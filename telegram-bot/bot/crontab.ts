import { insertMessage } from "bot/context-history";
import { telegram } from "bot/telegram";
import { inspect, s3 } from "bun";
import { redis } from "connections/redis";
import { handleUserWalletBalanceChange } from "connections/solana";
import { CronJob } from "cron";
import { db, tables } from "db";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import telegramifyMarkdown from "telegramify-markdown";
import { getEnv } from "utils/env";

// Reset free tier message counts
export const freeTierResetJob = new CronJob("0 0 * * *", async () => {
  const result = await db.update(tables.users).set({
    freeTierMessageCount: 0,
  });
  console.log(`Reset free tier message quota: ${inspect(result)}`);
});

// Handle wallet balance changes
export const checkWalletJob = new CronJob("* * * * *", async () => {
  const users = await db.query.users.findMany({
    where: isNotNull(tables.users.solanaWallet),
    with: {
      solanaWallet: true,
    },
  });

  for (const user of users) {
    if (!user.solanaWallet) throw new Error("User has no wallet");
    await handleUserWalletBalanceChange(user as any);
  }
});

// Send scheduled messages
export const scheduleJob = new CronJob("*/1 * * * *", async () => {
  const due = await db.query.scheduled_messages.findMany({
    where: and(
      lte(tables.scheduled_messages.scheduleAt, new Date()),
      eq(tables.scheduled_messages.sent, 0),
    ),
  });
  for (const msg of due) {
    await telegram.sendMessage(msg.chatId, msg.content);
    await db
      .update(tables.scheduled_messages)
      .set({ sent: 1 })
      .where(eq(tables.scheduled_messages.id, msg.id));
  }
});

// Notify user when task queue completes codex
export const codexNotifierJob = new CronJob("* * * * *", async () => {
  const keys = await redis.keys("results:*");
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;

    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }

    if (obj.status !== "completed") continue;
    const { data, chat_id, reply_to_message_id } = obj;
    if (!chat_id) continue;

    // send the assistant text
    if (data.assistant_msg) {
      const md = telegramifyMarkdown(data.assistant_msg, "escape");
      await telegram.sendMessage(chat_id, md, {
        parse_mode: "MarkdownV2",
        reply_parameters: {
          message_id: reply_to_message_id,
          allow_sending_without_reply: true,
        },
      });

      // also store as an assistant message
      const s3Bucket = getEnv("S3_BUCKET");
      const s3Region = getEnv("S3_REGION");
      await insertMessage({
        chatId: chat_id,
        userId: chat_id, // for private chats userId === chat_id
        role: "assistant",
        content: [{ type: "text", text: data.assistant_msg }],
        s3Bucket,
        s3Region,
      });
    }

    // send and store the generated ZIP if any
    if (data.generated_zip) {
      const presigned = s3.presign(data.generated_zip, { expiresIn: 3600 });
      await telegram.sendDocument(chat_id, presigned, {
        reply_parameters: {
          message_id: reply_to_message_id,
          allow_sending_without_reply: true,
        },
      });

      // store a message part noting the ZIP link
      const s3Bucket = getEnv("S3_BUCKET");
      const s3Region = getEnv("S3_REGION");
      await insertMessage({
        chatId: chat_id,
        userId: chat_id,
        role: "assistant",
        content: [{ type: "text", text: `🔗 ZIP ready: ${presigned}` }],
        s3Bucket,
        s3Region,
      });
    }

    await redis.del(key);
  }
});
