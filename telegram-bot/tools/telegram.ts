import { createId } from "@paralleldrive/cuid2";
import { tool, type ToolSet } from "ai";
import { type BotContext } from "bot";
import { insertMessage } from "bot/context-history";
import { telegram } from "bot/telegram";
import { s3 } from "bun";
import { redis } from "connections/redis";
import { vectorStore } from "connections/vector";
import { db, tables } from "db";
import { eq, or } from "drizzle-orm";
import { getEnv } from "utils/env";
import { z } from "zod";

/**
 * These tools are included in every LLM call.
 *
 * These are the most essential for interacting with Telegram
 * and therefore, have to be lean and easy for
 * LLMs to understand.
 */
export function telegramTools(ctx: BotContext): ToolSet {
  async function resolveChatId(recipient: number | string): Promise<number> {
    if (typeof recipient === "number") {
      return recipient;
    }
    const user = await db.query.users.findFirst({
      where: or(
        eq(tables.users.username, recipient),
        eq(tables.users.firstName, recipient),
        eq(tables.users.lastName, recipient),
      ),
    });
    if (!user) {
      throw new Error(`Recipient not found: ${recipient}`);
    }
    return user.chatId;
  }

  return {
    send_message: tool({
      description:
        "Send a text message to a specified chat, identified by chat ID or username/first name/last name (via the user database). Replies to the invoking message by default and allows sending without reply. Available to all users.",
      parameters: z.object({
        recipient: z
          .union([z.number(), z.string()])
          .describe("Destination chat ID or username/first name/last name"),
        text: z.string().describe("Message text to send"),
      }),
      async execute({ recipient, text }) {
        let chatIdToSend: number;
        try {
          chatIdToSend = await resolveChatId(recipient);
        } catch (e: any) {
          return `ERROR: ${e.message}`;
        }
        await telegram.sendMessage(chatIdToSend, text, {
          reply_parameters: {
            message_id: ctx.msgId!,
            allow_sending_without_reply: true,
          },
        });

        const s3Bucket = getEnv("S3_BUCKET", z.string());
        const s3Region = getEnv("S3_REGION", z.string());
        const msgId = await insertMessage({
          chatId: chatIdToSend,
          userId: chatIdToSend,
          role: "assistant",
          content: text,
          s3Bucket,
          s3Region,
        });
        await vectorStore.upsert({
          id: createId(),
          data: text,
          metadata: {
            chatId: chatIdToSend,
            messageIds: [msgId],
            createdAt: new Date(),
          },
        });

        return `Message sent to ${chatIdToSend}`;
      },
    }),

    read_s3_file: tool({
      description:
        "Read a file from S3 by key. Returns up to `max_chars` characters of text if it's a text file, otherwise returns only the file's mime type.",
      parameters: z.object({
        key: z.string().describe("S3 object key/path"),
        max_chars: z
          .number()
          .optional()
          .describe("Max characters to return; defaults to 500"),
      }),
      async execute({ key, max_chars }) {
        const limit = max_chars ?? 500;
        try {
          const file = s3.file(key);
          const stat = await file.stat();
          const mimeType = stat.type;
          if (
            mimeType.startsWith("text/") ||
            mimeType.includes("json") ||
            mimeType.includes("xml") ||
            mimeType.includes("csv") ||
            /\/.*\+xml/.test(mimeType)
          ) {
            const text = await file.text();
            const truncated = text.length > limit ? text.slice(0, limit) : text;
            return { mimeType, text: truncated };
          } else {
            return { mimeType };
          }
        } catch (e: any) {
          return `ERROR: ${e.message}`;
        }
      },
    }),

    get_all_users: tool({
      description: "Get all users from the database. Owner only.",
      parameters: z.object({}),
      async execute() {
        const ownerId = getEnv("TELEGRAM_BOT_OWNER", z.coerce.number());
        if (ctx.from?.id !== ownerId) {
          return "ERROR: Only the bot owner may use get_all_users";
        }
        const users = await db.query.users.findMany();
        return users.map((u) => ({
          chatId: u.chatId,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
        }));
      },
    }),

    cancel: tool({
      description: "Interrupt and stop thinking of a response",
      parameters: z.object({}),
      async execute() {
        ctx.session.task?.abort();

        await redis.del(`pending_requests:${ctx.chatId}:${ctx.from?.id}`);

        return "Stopped generating response.";
      },
    }),

    send_file: tool({
      description: "Send a document to a specified chat.",
      parameters: z.object({
        recipient: z
          .union([z.number(), z.string()])
          .describe("Destination chat ID or username"),
        file_path: z.string().describe("Local file path to send"),
        caption: z
          .string()
          .optional()
          .describe("Optional caption for the file"),
      }),
      async execute({ recipient, file_path, caption }) {
        let chatIdToSend: number;
        try {
          chatIdToSend = await resolveChatId(recipient);
        } catch (e: any) {
          return `ERROR: ${e.message}`;
        }
        try {
          await telegram.sendDocument(chatIdToSend, file_path, {
            caption,
            reply_parameters: {
              message_id: ctx.msgId!,
              allow_sending_without_reply: true,
            },
          });
          return "File sent.";
        } catch (e: any) {
          return `ERROR: ${e.message}`;
        }
      },
    }),

    send_photo: tool({
      description: "Send a photo to a specified chat.",
      parameters: z.object({
        recipient: z
          .union([z.number(), z.string()])
          .describe("Destination chat ID or username"),
        photo: z.string().describe("URL or local file path of the photo"),
        caption: z
          .string()
          .optional()
          .describe("Optional caption for the photo"),
      }),
      async execute({ recipient, photo, caption }) {
        let chatIdToSend: number;
        try {
          chatIdToSend = await resolveChatId(recipient);
        } catch (e: any) {
          return `ERROR: ${e.message}`;
        }
        try {
          await telegram.sendPhoto(chatIdToSend, photo, {
            caption,
            reply_parameters: {
              message_id: ctx.msgId!,
              allow_sending_without_reply: true,
            },
          });
          return "Photo sent.";
        } catch (e: any) {
          return `ERROR: ${e.message}`;
        }
      },
    }),

    send_video: tool({
      description: "Send a video to a specified chat.",
      parameters: z.object({
        recipient: z
          .union([z.number(), z.string()])
          .describe("Destination chat ID or username"),
        video: z.string().describe("URL or local file path of the video"),
        caption: z
          .string()
          .optional()
          .describe("Optional caption for the video"),
      }),
      async execute({ recipient, video, caption }) {
        let chatIdToSend: number;
        try {
          chatIdToSend = await resolveChatId(recipient);
        } catch (e: any) {
          return `ERROR: ${e.message}`;
        }
        try {
          await telegram.sendVideo(chatIdToSend, video, {
            caption,
            reply_parameters: {
              message_id: ctx.msgId!,
              allow_sending_without_reply: true,
            },
          });
          return "Video sent.";
        } catch (e: any) {
          return `ERROR: ${e.message}`;
        }
      },
    }),

    send_poll: tool({
      description: "Send a poll to a specified chat.",
      parameters: z.object({
        recipient: z
          .union([z.number(), z.string()])
          .describe("Destination chat ID or username"),
        question: z.string().describe("Poll question"),
        options: z.array(z.string()).describe("List of poll answer options"),
        is_anonymous: z
          .boolean()
          .optional()
          .describe("Whether the poll should be anonymous"),
        allows_multiple_answers: z
          .boolean()
          .optional()
          .describe("Whether multiple answers are allowed"),
        type: z
          .enum(["regular", "quiz"])
          .optional()
          .describe("Type of the poll"),
        correct_option_id: z
          .number()
          .optional()
          .describe("Index of the correct option for quiz polls"),
      }),
      async execute({
        recipient,
        question,
        options,
        is_anonymous,
        allows_multiple_answers,
        type,
        correct_option_id,
      }) {
        let chatIdToSend: number;
        try {
          chatIdToSend = await resolveChatId(recipient);
        } catch (e: any) {
          return `ERROR: ${e.message}`;
        }
        try {
          await telegram.sendPoll(
            chatIdToSend,
            question,
            options.map((o) => ({ text: o })),
            {
              is_anonymous: is_anonymous ?? true,
              allows_multiple_answers: allows_multiple_answers ?? false,
              type,
              correct_option_id,
            },
          );
          return "Poll sent.";
        } catch (e: any) {
          return `ERROR: ${e.message}`;
        }
      },
    }),

    forward_message: tool({
      description: "Forward a message from one chat to another.",
      parameters: z.object({
        from_chat_id: z
          .union([z.number(), z.string()])
          .describe("Chat ID or username to forward message from"),
        message_id: z.number().describe("Identifier of the message to forward"),
        recipient: z
          .union([z.number(), z.string()])
          .describe("Destination chat ID or username"),
      }),
      async execute({ from_chat_id, message_id, recipient }) {
        let toChatId: number;
        try {
          toChatId = await resolveChatId(recipient);
        } catch (e: any) {
          return `ERROR: ${e.message}`;
        }
        let fromChatId: number;
        try {
          fromChatId = await resolveChatId(from_chat_id);
        } catch (e: any) {
          return `ERROR: ${e.message}`;
        }
        try {
          await telegram.forwardMessage(toChatId, fromChatId, message_id);
          return "Message forwarded.";
        } catch (e: any) {
          return `ERROR: ${e.message}`;
        }
      },
    }),
  };
}
