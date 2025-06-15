import { openai } from "@ai-sdk/openai";
import { TZDate } from "@date-fns/tz";
import { fmt, i } from "@grammyjs/parse-mode";
import { createId } from "@paralleldrive/cuid2";
import {
  generateObject,
  generateText,
  streamText,
  type CoreMessage,
  type DataContent,
  type ImagePart,
  type UserContent,
} from "ai";
import type { BotContext } from "bot";
import { getConfigValue } from "bot/config";
import { DATA_DIR, LLM_TOOLS_LIMIT, TEMP_DIR } from "bot/constants";
import {
  insertMessage,
  pullMessageHistory,
  pullMessagesByChatAndUser,
} from "bot/context-history";
import { retrieveUser } from "bot/helpers";
import { ChatAction } from "bot/running-tasks";
import { downloadFile, telegram } from "bot/telegram";
import { $, inspect } from "bun";
import { redis } from "connections/redis";
import { replicate } from "connections/replicate";
import { vectorStore } from "connections/vector";
import { analyzeVideo } from "connections/video-parser";
import { db } from "db";
import { searchChatMemory } from "db/vector";
import { Composer, InputFile } from "grammy";
import path from "path";
import type { FileOutput } from "replicate";
import sharp from "sharp";
import SuperJSON from "superjson";
import telegramifyMarkdown from "telegramify-markdown";
import { agenticTools } from "tools/agentic";
import { generateImage } from "tools/generate-image";
import { ltaAgent } from "tools/lta-agent";
import { raphgptTools } from "tools/raphgpt";
import { telegramTools } from "tools/telegram";
import { walletExplorerAgent } from "tools/wallet-explorer-agent";
import { getEnv } from "utils/env";
import { buildPrompt } from "utils/prompt";
import TGS from "utils/tgs";
import { mergeTools, searchTools } from "utils/tools";
import { z } from "zod";

export const messageHandler = new Composer<BotContext>();

messageHandler.on(["message", "edit:text"]).filter(
  async (ctx) => {
    if (!ctx.from) throw new Error("ctx.from not found");

    if (ctx.hasChatType("private")) {
      return true;
    }
    if (
      ctx.from.id === getEnv("TELEGRAM_BOT_OWNER", z.coerce.number()) &&
      ctx.msg.text?.startsWith("-bot ")
    ) {
      return true;
    }
    return false;
  },
  async (ctx) => {
    if (!ctx.from) throw new Error("ctx.from not found");

    const userId = ctx.from.id;
    const chatId = ctx.chatId;

    // Cancel the previous request if it exists
    if (ctx.session.task) {
      ctx.session.task.abort();
      const interruptionNotification = fmt`${i}⏹️ Previous response interrupted. Processing new request...${i}`;
      await ctx.reply(interruptionNotification.text, {
        entities: interruptionNotification.entities,
      });
    }

    if (ctx.editedMessage) {
      const editedMessageNotification = fmt`${i}Noticed you edited a message. Revisiting it...${i}`;
      await ctx.reply(editedMessageNotification.text, {
        entities: editedMessageNotification.entities,
      });
    }

    ctx.session.task = new AbortController();

    const user = await retrieveUser(ctx);

    // // Check if user has enough free messages
    // // Check if user has enough credits
    // // Excluding TELEGRAM_BOT_OWNER
    // const userExceedsFreeMessages =
    //   user.freeTierMessageCount >
    //   getEnv("FREE_TIER_MESSAGE_DAILY_THRESHOLD", z.coerce.number());
    // const userIsOwner =
    //   user.userId === getEnv("TELEGRAM_BOT_OWNER", z.coerce.number());
    // if (userExceedsFreeMessages && user.credits <= 0 && !userIsOwner) {
    //   return await ctx.reply(
    //     "You have run out of credits! Use /topup to get more.",
    //   );
    // }

    if (ctx.msg.text?.startsWith("-bot ")) {
      ctx.msg.text = ctx.msg.text.replace("-bot ", "");
    }

    const toSend: UserContent = [];
    const remindingSystemPrompt: string[] = [];

    if (ctx.msg.text) {
      ctx.session.chatAction = new ChatAction(ctx.chatId, "typing");

      toSend.push({ type: "text", text: ctx.msg.text });
    }
    if (ctx.msg.voice) {
      ctx.session.chatAction = new ChatAction(ctx.chatId, "typing");

      const file = await downloadFile(ctx);
      ctx.session.tempFiles.push(file.localPath);
      const inputFileId = createId();
      const audioFilePath = path.join(DATA_DIR, `input-${inputFileId}.mp3`);
      ctx.session.tempFiles.push(audioFilePath);
      await $`ffmpeg -i ${file.localPath} ${audioFilePath}`;

      const transcript = (await replicate.run(
        "vaibhavs10/incredibly-fast-whisper:3ab86df6c8f54c11309d4d1f930ac292bad43ace52d10c80d87eb258b3c9f79c",
        {
          input: {
            task: "transcribe",
            audio: file.remoteUrl,
            language: "english",
            batch_size: 64,
            diarise_audio: false,
          },
          signal: ctx.session.task.signal,
        },
      )) as { text: string };

      toSend.push({ type: "text", text: transcript.text });
    }
    if (ctx.msg.video_note || ctx.msg.video) {
      ctx.session.chatAction = new ChatAction(ctx.chatId, "typing");

      const file = await downloadFile(ctx);
      ctx.session.tempFiles.push(file.localPath);

      const { transcript, frames, summary } = await analyzeVideo(
        Bun.file(file.localPath),
        "en",
      );

      remindingSystemPrompt.push(
        "You have been given periodic frames from a video. Frames with the least amount of blur were extracted.",
        "When responding, pretend you have watched a video.",
        "To avoid confusing the user, do not say they are images.",
      );
      for (const b64 of frames) {
        toSend.push({
          type: "image",
          image: b64,
        });
      }
      toSend.push({ type: "text", text: transcript });
    }
    if (ctx.msg.photo) {
      ctx.session.chatAction = new ChatAction(ctx.chatId, "typing");

      const file = await downloadFile(ctx);
      ctx.session.tempFiles.push(file.localPath);
      const image = await sharp(file.localPath)
        .jpeg({ mozjpeg: true })
        .toBuffer();

      toSend.push({
        type: "image",
        image,
      });
    }
    if (ctx.msg.document) {
      ctx.session.chatAction = new ChatAction(ctx.chatId, "typing");

      toSend.push({
        type: "text",
        text: `File: ${JSON.stringify(ctx.msg.document)}`,
      });

      // const file = await downloadFile(ctx);
      // ctx.session.tempFiles.push(file.localPath);
      // if (file.fileType) {
      //   switch (file.fileType.ext) {
      //     case "pdf": {
      //       toSend.push({
      //         type: "text",
      //         text: "PDF file contents",
      //       });

      //       const pdfPages = await pdf2pic.fromPath(file.localPath).bulk(-1, {
      //         responseType: "buffer",
      //       });

      //       for (const page of pdfPages) {
      //         toSend.push({
      //           type: "image",
      //           image: page.buffer!,
      //         });
      //       }
      //       break;
      //     }
      //     case "docx": {
      //       toSend.push({
      //         type: "text",
      //         text: `DOCX file contents`,
      //       });

      //       const form = new FormData();
      //       form.append("files", Bun.file(file.localPath));

      //       const res = await fetch(
      //         "http://gotenberg:3000/forms/libreoffice/convert",
      //         {
      //           method: "POST",
      //           body: form,
      //         },
      //       );

      //       if (!res.ok) {
      //         throw new Error(
      //           `Gotenberg failed with status ${res.status}: ${await res.text()}`,
      //         );
      //       }

      //       const pdfPages = await pdf2pic
      //         .fromBuffer(Buffer.from(await res.arrayBuffer()))
      //         .bulk(-1, {
      //           responseType: "buffer",
      //         });

      //       for (const page of pdfPages) {
      //         const resized = await sharp(page.buffer)
      //           .resize({
      //             fit: "contain",
      //             width: 512,
      //           })
      //           .toBuffer();
      //         toSend.push({
      //           type: "image",
      //           image: resized,
      //         });
      //       }
      //       break;
      //     }
      //     case "jpg":
      //     case "jpeg":
      //     case "png":
      //     case "webp": {
      //       toSend.push({
      //         type: "image",
      //         image: file.remoteUrl,
      //       });
      //       break;
      //     }
      //   }
      // } else {
      //   toSend.push({
      //     type: "text",
      //     text: "Text file contents:",
      //   });
      //   toSend.push({
      //     type: "text",
      //     text: await Bun.file(file.localPath).text(),
      //   });
      // }
    }
    if (ctx.msg.location) {
      toSend.push({
        type: "text",
        text: `Location: ${JSON.stringify(ctx.msg.location)}`,
      });
    }
    if (ctx.msg.sticker) {
      ctx.session.chatAction = new ChatAction(ctx.chatId, "typing");

      const file = await downloadFile(ctx);
      ctx.session.tempFiles.push(file.localPath);

      let images: DataContent[];
      if (ctx.msg.sticker.is_animated) {
        const mp4FilePath = await new TGS(file.localPath).convertToMp4(
          path.join(TEMP_DIR, `${createId()}.mp4`),
        );
        ctx.session.tempFiles.push(mp4FilePath);
        const { transcript, frames, summary } = await analyzeVideo(
          Bun.file(mp4FilePath),
          "en",
        );
        images = frames;
      } else if (file.fileType?.mime.startsWith("video")) {
        const stickerPath = path.join(TEMP_DIR, `sticker_${createId()}.mp4`);
        ctx.session.tempFiles.push(stickerPath);
        await $`ffmpeg -i ${file.localPath} ${stickerPath}`;
        const { transcript, frames, summary } = await analyzeVideo(
          Bun.file(stickerPath),
          "en",
        );
        images = frames;
      } else {
        const stickerBuffer = await sharp(file.localPath)
          .jpeg({ mozjpeg: true })
          .toBuffer();
        images = [stickerBuffer];
      }

      const { text, usage } = await generateText({
        model: openai("gpt-4o"),
        system:
          "You're a helpful AI assistant that imitates API endpoints for web server that returns info about ANY sticker on Telegram.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `The user has sent a Telegram sticker: ${JSON.stringify(
                  ctx.msg.sticker,
                )}. Describe everything about it most accurately for another LLM to understand and interpret, and add references to pop culture or things it might look like.`,
              },
              ...(images.map((image) => ({
                type: "image",
                image,
              })) as ImagePart[]),
            ],
          },
        ],
      });
      // if (userExceedsFreeMessages && !userIsOwner) {
      //   await deductCredits(ctx, usage);
      // }

      toSend.push({
        type: "text",
        text: `Telegram sticker contents: ${text}`,
      });
    }
    if (ctx.msg.caption) {
      ctx.session.chatAction = new ChatAction(ctx.chatId, "typing");

      toSend.push({
        type: "text",
        text: ctx.msg.caption,
      });
    }

    console.log(
      `User message content: ${inspect({ toSend, remindingSystemPrompt })}`,
    );

    const messages: CoreMessage[] = [];

    const { object: summary } = await generateObject({
      model: openai("gpt-4o"),
      system:
        "You are an assistant summarizing multimodal content into search-friendly text.",
      schema: z.object({
        query: z.string(),
        title: z.string(),
      }),
      messages: [
        ...messages,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are an assistant helping index messages for semantic search.
Given the following content extracted from a user's message, summarize it in a single sentence for indexing and storage.
Query should be what you would use to search a RAG db for related messages.
Title should be what this set of messages would be stored as in the RAG db.`,
            },
            ...toSend,
          ],
        },
      ],
    });

    console.log(`Summary from LLM: ${inspect(summary)}`);

    // Find most relevant conversations from chat-memory vector db
    const relatedTurns = await searchChatMemory(chatId, summary.query, 4);
    console.log(`Most relevant conversation turns: ${inspect(relatedTurns)}`);

    for (const turn of relatedTurns) {
      const relatedMessages = await pullMessageHistory(turn.messageIds);
      messages.push(...relatedMessages);
    }

    // Get context history, limited to config value
    const recentMessages = await pullMessagesByChatAndUser({
      chatId,
      userId,
      limit: await getConfigValue(ctx.from.id, "messagehistsize"),
    });
    messages.push(...recentMessages);

    console.log(`Message history: ${inspect(messages)}`);

    messages.push({
      role: "system",
      content: remindingSystemPrompt.join("\n"),
    });

    const pendingRequests = await redis
      .LRANGE(`pending_requests:${ctx.chatId}:${userId}`, 0, -1)
      .then((jsons) =>
        jsons.map((c: string) => SuperJSON.parse<UserContent>(c)),
      );

    console.log(`Pending requests: ${inspect(pendingRequests)}`);

    const content = [...pendingRequests.flat(1), ...toSend] as UserContent;

    messages.push({
      role: "user",
      content,
    });

    console.log(`Sending message to model: ${inspect(content)}`);

    await redis.RPUSH(
      `pending_requests:${ctx.chatId}:${userId}`,
      SuperJSON.stringify(toSend),
    );

    const tools = mergeTools(
      await searchTools(
        summary.query,
        mergeTools(
          raphgptTools({ ctx }),
          generateImage({ ctx }),
          ltaAgent({ ctx }),
          walletExplorerAgent({ ctx }),
          agenticTools,
        ),
        LLM_TOOLS_LIMIT,
      ),
      telegramTools(ctx),
    );

    const instrRows = await db.query.systemInstructions.findMany({
      columns: { content: true },
    });
    const instructions = instrRows.map((r) => r.content).join("\n");

    const exampleRows = await db.query.interactionExamples.findMany({
      columns: { userInput: true, botResponse: true },
    });
    const examples = exampleRows
      .map((r) => `User: ${r.userInput}\nBot: ${r.botResponse}`)
      .join("\n\n");

    const { textStream } = streamText({
      model: openai("o4-mini", {
        structuredOutputs: false,
      }),
      tools,
      system: await buildPrompt("system", {
        me: JSON.stringify(ctx.me),
        date: new TZDate(
          new Date(),
          (await getConfigValue(ctx.from.id, "timezone")) ?? "Asia/Singapore",
        ).toString(),
        language: await getConfigValue(ctx.from.id, "language"),
        personality: (
          await db.query.personality.findMany({ columns: { content: true } })
        )
          .map((r) => r.content)
          .join("\n"),
        userName: ctx.from.username ?? ctx.from.first_name,
        instructions,
        examples,
      }),
      messages,
      maxSteps: 5,
      async onFinish(result) {
        if (ctx.msg.audio || ctx.msg.voice) {
          ctx.session.chatAction = new ChatAction(ctx.chatId, "record_voice");
          const audioFile = (await replicate.run("minimax/speech-02-turbo", {
            input: {
              text: result.text.split("<|message|>").join("<#0.5#>"),
              voice_id: "English_FriendlyPerson",
              speed: 1,
              volume: 2,
              pitch: 0,
              emotion: "auto",
              english_normalization: true,
              sample_rate: 32000,
              bitrate: 128000,
              channel: "mono",
              language_boost: "English",
            },
            signal: ctx.session.task?.signal,
          })) as FileOutput;

          const rawPath = path.join(TEMP_DIR, `voice-${createId()}.mp3`);
          ctx.session.tempFiles.push(rawPath);
          await Bun.write(rawPath, await audioFile.blob());
          const oggPath = rawPath.replace(/\.[^.]+$/, ".ogg");
          ctx.session.tempFiles.push(oggPath);
          await $`ffmpeg -i ${rawPath} -acodec libopus -filter:a volume=4dB ${oggPath}`;

          await telegram.sendVoice(ctx.chatId, new InputFile(oggPath), {
            reply_parameters: {
              message_id: ctx.msgId,
              allow_sending_without_reply: true,
            },
          });
        }

        // Remove all pending requests
        await redis.del(`pending_requests:${ctx.chatId}:${userId}`);
        ctx.session.task = null;

        console.log(`Model finished with ${result.finishReason}`);

        if (result.finishReason === "tool-calls") {
          console.error(
            `Not saving this time because generation stopped from a tool call! id: ${result.response.id}`,
          );
          return;
        }

        {
          const s3Bucket = getEnv("S3_BUCKET", z.string());
          const s3Region = getEnv("S3_REGION", z.string());
          const messageIds: number[] = [];

          messageIds.push(
            await insertMessage({
              chatId: ctx.chatId,
              userId,
              role: "user",
              content: toSend,
              s3Bucket,
              s3Region,
            }),
          );
          for (const msg of result.response.messages) {
            messageIds.push(
              await insertMessage({
                chatId: ctx.chatId,
                userId,
                role: msg.role,
                content: msg.content,
                s3Bucket,
                s3Region,
              }),
            );
          }

          await vectorStore.upsert({
            id: createId(),
            data: summary.title,
            metadata: { chatId, messageIds, createdAt: new Date() },
          });
        }
      },
      async onError({ error }) {
        console.error(error, "Encountered error during AI streaming");
        ctx.session.task?.abort();
      },
      abortSignal: ctx.session.task.signal,
    });

    let textBuffer = "";
    let firstMessageSent = false;

    const flushBuffer = async () => {
      console.log(`About to flush: ${textBuffer}`);

      // flush the buffer
      if (textBuffer.trim().length > 0) {
        const mdv2 = telegramifyMarkdown(textBuffer, "escape");
        await telegram.sendMessage(ctx.chatId, mdv2, {
          parse_mode: "MarkdownV2",
          ...(ctx.editedMessage &&
            !firstMessageSent && {
              reply_parameters: {
                message_id: ctx.msgId,
              },
            }),
        });
        textBuffer = "";
        firstMessageSent = true;
      }
    };

    for await (const textPart of textStream) {
      textBuffer += textPart;

      if (
        textBuffer.trim().endsWith("<|message|>") ||
        textBuffer.trim().endsWith("</|message|>")
      ) {
        textBuffer = textBuffer.replaceAll("<|message|>", "");
        textBuffer = textBuffer.replaceAll("</|message|>", "");

        await flushBuffer();
      }
    }
    await flushBuffer();

    // if (!userIsOwner) {
    //   if (userExceedsFreeMessages) {
    //     await deductCredits(ctx, modelUsage);
    //   } else {
    //     await db
    //       .update(tables.users)
    //       .set({
    //         freeTierMessageCount: sql`${tables.users.freeTierMessageCount} + 1`,
    //       })
    //       .where(eq(tables.users.userId, ctx.from.id));
    //   }
    // }
  },
);
