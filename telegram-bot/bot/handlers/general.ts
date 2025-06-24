import { createConversation } from "@grammyjs/conversations";
import { code, fmt } from "@grammyjs/parse-mode";
import type { BotContext } from "bot";
import { configSchema } from "bot/config";
import { retrieveUser } from "bot/helpers";
import { s3 } from "bun";
import { redis } from "connections/redis";
import { vectorStore } from "connections/vector";
import { db, tables } from "db";
import { and, eq, inArray } from "drizzle-orm";
import { Composer } from "grammy";

export const generalHandler = new Composer<BotContext>();

generalHandler.command("start", async (ctx, next) => {
  const user = await retrieveUser(ctx);

  await ctx.reply(
    `hey ${
      user.firstName ?? user.lastName
    }, what's up? You can send a text, photo, telebubble or a voice message.`,
  );

  await next();
});

generalHandler.use(
  createConversation(async (conversation, ctx) => {
    await ctx.reply(
      "Please enter your preferred language code (ISO 639-1), e.g. “en”, “es”, “zh”.",
    );
    const { message } = await conversation.waitFor("message:text");
    const codeInput = message.text.trim().toLowerCase();
    // Validate against our config schema
    configSchema.pick({ language: true }).parse({ language: codeInput });
    // Store in Redis
    await redis.HSET(`config:${ctx.from!.id}`, "language", codeInput);
    const replyMessage = fmt`Thanks! I'll speak in ${code}${codeInput}${code} from now on.`;
    await ctx.reply(replyMessage.text, {
      entities: replyMessage.entities,
    });
  }, "ask_language"),
);

generalHandler.use(async (ctx, next) => {
  if (!ctx.from) return await next();
  // only trigger on /start
  if (ctx.msg?.text?.startsWith("/start")) {
    const existing = await redis.HGET(`config:${ctx.from.id}`, "language");
    if (!existing) {
      // kick off the conversation
      await ctx.conversation.enter("ask_language");
      return;
    }
  }
  await next();
});

generalHandler.command("clear", async (ctx) => {
  if (!ctx.from) throw new Error("Could not get message sender");

  const userId = ctx.from.id;
  let chatId = ctx.chatId;

  if (ctx.match) {
    const args = ctx.match.trim();
    chatId = parseInt(args);
  }

  // Remove all pending requests
  await redis.del(`pending_requests:${ctx.chatId}:${userId}`);

  const parts = await db
    .select({
      region: tables.messageParts.region,
      bucket: tables.messageParts.bucket,
      key: tables.messageParts.key,
    })
    .from(tables.messageParts)
    .leftJoin(
      tables.messages,
      eq(tables.messageParts.messageId, tables.messages.id),
    )
    .where(
      and(
        eq(tables.messages.userId, userId),
        eq(tables.messages.chatId, chatId),
        inArray(tables.messageParts.type, ["image", "file"]),
      ),
    )
    .all();

  await Promise.all(
    parts.map(
      async ({
        region,
        bucket,
        key,
      }: {
        region: string | null;
        bucket: string | null;
        key: string | null;
      }) => {
        if (region && bucket && key) {
          try {
            await s3.file(key, { region, bucket }).delete();
          } catch (error) {
            console.warn(
              `Failed to delete S3 file ${key} from ${bucket}/${region}: ${error}`,
            );
          }
        }
      },
    ),
  );

  const deleteResult = await db
    .delete(tables.messages)
    .where(
      and(
        eq(tables.messages.userId, userId),
        eq(tables.messages.chatId, chatId),
      ),
    );

  await ctx.reply(
    `All ${deleteResult.rowsAffected} messages cleared from short term memory.`,
  );

  const { deleted } = await vectorStore.delete({
    filter: `chatId = ${chatId}`,
  });

  await ctx.reply(
    `All ${deleted} conversation turns deleted from long term memory.`,
  );
});
