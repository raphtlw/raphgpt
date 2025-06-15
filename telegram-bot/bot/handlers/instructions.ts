import { createConversation } from "@grammyjs/conversations";
import type { BotContext } from "bot";
import { db, tables } from "db";
import { eq } from "drizzle-orm";
import { Composer, InlineKeyboard } from "grammy";
import { getEnv } from "utils/env";
import { z } from "zod";

const ownerId = getEnv("TELEGRAM_BOT_OWNER", z.coerce.number());

export const instructionsHandler = new Composer<BotContext>();

// Only the bot owner may manage system instructions
instructionsHandler.use((ctx, next) => {
  if (ctx.from?.id !== ownerId) {
    return ctx.reply("❌ You are not authorized to use this command.");
  }
  return next();
});

// Show instructions menu
instructionsHandler.command("instructions", async (ctx) => {
  if (!ctx.from) throw new Error("ctx.from not found");

  const rows = await db.query.systemInstructions.findMany({
    columns: { id: true, content: true },
  });
  const len = rows.length;
  const inlineKeyboard = new InlineKeyboard()
    .text("<< 1", "instr-start")
    .text("< 1", "instr-1")
    .text("1", "instr-1")
    .text("2 >", "instr-2")
    .text(`${len} >>`, "instr-end")
    .row()
    .text("➕ Add", "instr-add")
    .text("✏️ Edit", `instr-edit-1`)
    .text("🗑️ Remove", `instr-remove-1`);

  if (len > 0 && rows[0]) {
    await ctx.reply(rows[0].content, { reply_markup: inlineKeyboard });
  } else {
    await ctx.reply("No system instructions found.", {
      reply_markup: inlineKeyboard,
    });
  }
});

// Paginate through instructions
const instrMenu = async (ctx: BotContext, page: number) => {
  if (!ctx.from) throw new Error("ctx.from not found");

  const rows = await db.query.systemInstructions.findMany({
    columns: { id: true, content: true },
  });
  const len = rows.length;

  if (page < 1 || page > len) {
    await ctx.answerCallbackQuery("Invalid instruction index");
    return;
  }

  const item = rows[page - 1];
  if (!item) {
    await ctx.answerCallbackQuery("Instruction not found");
    return;
  }

  const inlineKeyboard = new InlineKeyboard()
    .text("<< 1", "instr-start")
    .text(`< ${page - 1}`, `instr-${page - 1}`)
    .text(`${page}`, `instr-${page}`)
    .text(`${page + 1} >`, `instr-${page + 1}`)
    .text(`${len} >>`, "instr-end")
    .row()
    .text("➕ Add", "instr-add")
    .text("✏️ Edit", `instr-edit-${page}`)
    .text("🗑️ Remove", `instr-remove-${page}`);

  await ctx.answerCallbackQuery();
  await ctx.reply(item.content, { reply_markup: inlineKeyboard });
};

instructionsHandler.callbackQuery(/instr-(\d+)/, async (ctx) => {
  if (!ctx.match[1]) throw new Error("Instruction index not matched");
  const page = parseInt(ctx.match[1], 10);
  await instrMenu(ctx, page);
});

instructionsHandler.callbackQuery(/instr-(start|end)/, async (ctx) => {
  if (!ctx.from) throw new Error("ctx.from not found");
  const rows = await db.query.systemInstructions.findMany({
    columns: { id: true },
  });
  const len = rows.length;
  const direction = ctx.match[1];
  await ctx.answerCallbackQuery();
  if (direction === "start") await instrMenu(ctx, 1);
  if (direction === "end") await instrMenu(ctx, len);
});

// Conversation flow to add instruction
instructionsHandler.use(
  createConversation(async (conversation, ctx) => {
    await ctx.reply("Send the system instruction content you wish to add:");
    const { message } = await conversation.waitFor("message:text");
    await db
      .insert(tables.systemInstructions)
      .values({ content: message.text });
    await ctx.reply("Instruction added!");
  }, "instr-add"),
);

instructionsHandler.callbackQuery(/instr-add/, async (ctx) => {
  await ctx.conversation.enter("instr-add");
});

// Conversation flow to edit an existing instruction
instructionsHandler.use(
  createConversation(async (conversation, ctx, page: number) => {
    const rows = await db.query.systemInstructions.findMany({
      columns: { id: true, content: true },
    });
    const instr = rows[page - 1];
    if (!instr) throw new Error("Instruction not found");
    await ctx.reply(
      `Send new content for instruction #${page}: ${instr.content}`,
    );
    const { message } = await conversation.waitFor("message:text");
    await db
      .update(tables.systemInstructions)
      .set({ content: message.text })
      .where(eq(tables.systemInstructions.id, instr.id));
    await ctx.reply("Instruction updated!");
  }, "instr-edit"),
);

instructionsHandler.callbackQuery(/instr-edit-(\d+)/, async (ctx) => {
  const page = parseInt(ctx.match![1]!, 10);
  await ctx.conversation.enter("instr-edit", page);
});

// Remove instruction
instructionsHandler.callbackQuery(/instr-remove-(\d+)/, async (ctx) => {
  if (!ctx.match[1]) throw new Error("Instruction index not matched");
  const page = parseInt(ctx.match[1], 10);
  const rows = await db.query.systemInstructions.findMany({
    columns: { id: true },
  });
  const instr = rows[page - 1];
  if (!instr) {
    return ctx.reply("Instruction not found.");
  }
  const result = await db
    .delete(tables.systemInstructions)
    .where(eq(tables.systemInstructions.id, instr.id));
  await ctx.reply(`Deleted ${result.rowsAffected} instruction`);
});
