import type { BotContext } from "bot";
import logger from "bot/logger";
import { redis } from "connections/redis";
import { Composer } from "grammy";

export const requestHandler = new Composer<BotContext>();

requestHandler.command("cancel", async (ctx) => {
  logger.debug("Cancellation requested");

  if (!ctx.from) throw new Error("ctx.from not found");
  const userId = ctx.from.id;

  ctx.session.task?.abort();

  // Remove all pending requests
  await redis.del(`pending_requests:${ctx.chatId}:${userId}`);

  await ctx.reply("Stopped thinking");
});
