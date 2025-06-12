import { createConversation } from "@grammyjs/conversations";
import type { BotContext } from "bot";
import logger from "bot/logger";
import { db, tables } from "db";
import { eq } from "drizzle-orm";
import { Composer, InlineKeyboard } from "grammy";

export const personalityHandler = new Composer<BotContext>();

personalityHandler.command("personality", async (ctx) => {
  if (!ctx.from) throw new Error("ctx.from not found");

  const personality = await db.query.personality.findMany({
    where: eq(tables.personality.userId, ctx.from.id),
    columns: {
      id: true,
      content: true,
    },
  });

  const inlineKeyboard = new InlineKeyboard()
    .text("<< 1", "personality-start")
    .text("< 1", "personality-1")
    .text("1", "personality-1")
    .text("2 >", "personality-2")
    .text(`${personality.length} >>`, "personality-end")
    .row()
    .text("➕ Add", "personality-add")
    .text("🗑️ Remove", "personality-remove-1");
  if (personality.length > 0 && personality[0]) {
    await ctx.reply(personality[0].content, {
      reply_markup: inlineKeyboard,
    });
  } else {
    await ctx.reply("No personality data found.", {
      reply_markup: inlineKeyboard,
    });
  }
});

const personalityMenu = async (ctx: BotContext, page: number) => {
  if (!ctx.from) throw new Error("ctx.from not found");

  const personality = await db.query.personality.findMany({
    where: eq(tables.personality.userId, ctx.from.id),
    columns: {
      id: true,
      content: true,
    },
  });

  if (page > personality.length) {
    await ctx.answerCallbackQuery("You have reached the end of the list");
    return;
  }

  if (page < 1) {
    await ctx.answerCallbackQuery("Unable to go backwards even further");
    return;
  }

  const inlineKeyboard = new InlineKeyboard()
    .text("<< 1", "personality-start")
    .text(`< ${page - 1}`, `personality-${page - 1}`)
    .text(`${page}`, `personality-${page}`)
    .text(`${page + 1} >`, `personality-${page + 1}`)
    .text(`${personality.length} >>`, "personality-end")
    .row()
    .text("➕ Add", "personality-add")
    .text("🗑️ Remove", `personality-remove-${page}`);

  if (personality.length > 0 && personality[page - 1]) {
    await ctx.answerCallbackQuery();
    await ctx.reply(personality[page - 1]!.content, {
      reply_markup: inlineKeyboard,
    });
  } else {
    await ctx.answerCallbackQuery();
    await ctx.reply("No personality data found.", {
      reply_markup: inlineKeyboard,
    });
  }
};

personalityHandler.callbackQuery(/personality-(\d+)/, async (ctx) => {
  logger.debug(`Personality: ${ctx.match}`);

  if (!ctx.match[1]) throw new Error("Personality index not matched");

  const personalityPage = parseInt(ctx.match[1]);
  await personalityMenu(ctx, personalityPage);
});

personalityHandler.callbackQuery(/personality-(start|end)/, async (ctx) => {
  logger.debug(`Personality: ${ctx.match}`);

  if (!ctx.from) throw new Error("ctx.from not found");

  const personality = await db.query.personality.findMany({
    where: eq(tables.personality.userId, ctx.from.id),
    columns: {
      id: true,
      content: true,
    },
  });

  if (ctx.match[1] === "start") {
    await personalityMenu(ctx, 1);
  }

  if (ctx.match[1] === "end") {
    await personalityMenu(ctx, personality.length);
  }
});

personalityHandler.use(
  createConversation(async (conversation, ctx) => {
    if (!ctx.from) throw new Error("ctx.from not found");

    await ctx.reply(
      "Send the content you wish to add to the bot's personality",
    );
    const { message } = await conversation.waitFor("message:text");
    await db.insert(tables.personality).values({
      userId: ctx.from.id,
      content: message.text,
    });

    await ctx.reply("Personality added!");
  }, "personality-add"),
);

personalityHandler.callbackQuery(/personality-add/, async (ctx) => {
  logger.debug(`Personality: ${ctx.match}`);

  await ctx.conversation.enter("personality-add");
});

personalityHandler.callbackQuery(/personality-remove-(\d+)/, async (ctx) => {
  logger.debug(`Personality: ${ctx.match}`);

  if (!ctx.match[1]) throw new Error("Personality index not matched");

  const personalityPage = parseInt(ctx.match[1]);
  const personality = await db.query.personality.findMany({
    where: eq(tables.personality.userId, ctx.from.id),
    columns: {
      id: true,
      content: true,
    },
  });

  const result = await db
    .delete(tables.personality)
    .where(eq(tables.personality.id, personality[personalityPage - 1]!.id));

  await ctx.reply(`Deleted ${result.rowsAffected} personality record`);
});
