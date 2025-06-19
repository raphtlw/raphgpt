import { telegram } from "bot/telegram";
import { inspect, s3 } from "bun";
import { redis } from "connections/redis";
import { handleUserWalletBalanceChange } from "connections/solana";
import { CronJob } from "cron";
import { db, tables } from "db";
import { isNotNull } from "drizzle-orm";
import telegramifyMarkdown from "telegramify-markdown";

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
    if (obj.status !== "completed") {
      // you could handle "error" here too
      continue;
    }

    const { data, chat_id, reply_to_message_id } = obj;
    if (!chat_id) continue;

    if (data.assistant_msg) {
      await telegram.sendMessage(
        chat_id,
        telegramifyMarkdown(data.assistant_msg, "escape"),
        {
          parse_mode: "MarkdownV2",
          reply_parameters: {
            message_id: reply_to_message_id,
            allow_sending_without_reply: true,
          },
        },
      );
    }

    if (data.generated_zip) {
      const presigned = s3.presign(data.generated_zip, {
        expiresIn: 3600,
      });
      await telegram.sendDocument(chat_id, presigned, {
        reply_parameters: {
          message_id: reply_to_message_id,
          allow_sending_without_reply: true,
        },
      });
    }

    console.log(key);

    await redis.del(key);
  }
});
