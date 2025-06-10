import { b, fmt, i } from "@grammyjs/parse-mode";
import type { BotContext } from "bot";
import { db, tables } from "db";
import { eq } from "drizzle-orm";
import { getEnv } from "utils/env";

export const retrieveUser = async (ctx: BotContext) => {
  if (!ctx.from)
    throw new Error("Tried to retrieve user when no message sender exists!");
  if (!ctx.chatId) throw new Error("No chat ID found!");

  let user = await db.query.users.findFirst({
    where: eq(tables.users.userId, ctx.from.id),
  });
  if (!user) {
    user = await db
      .insert(tables.users)
      .values({
        chatId: ctx.chatId,
        userId: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      })
      .returning()
      .get();
    const welcomeNotification = fmt`${b}Welcome to raphGPT.${b}
You get ${b}${getEnv(
      "FREE_TIER_MESSAGE_DAILY_THRESHOLD",
    )}${b} messages per day, resets at 00:00 daily.
${i}You can get more tokens from the store (/topup)${i}`;
    await ctx.reply(welcomeNotification.text, {
      entities: welcomeNotification.entities,
    });
  } else {
    user = await db
      .update(tables.users)
      .set({
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      })
      .where(eq(tables.users.userId, ctx.from.id))
      .returning()
      .get();
  }

  if (!user) throw new Error("Unable to retrieve user");

  return user;
};
