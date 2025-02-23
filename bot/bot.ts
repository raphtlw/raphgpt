import { TYPING_INDICATOR_DURATION } from "@/bot/constants";
import logger from "@/bot/logger.js";
import { db, tables } from "@/db/db.js";
import { getEnv } from "@/helpers/env.js";
import { handleUserWalletBalanceChange } from "@/helpers/solana.js";
import { openai } from "@ai-sdk/openai";
import { hydrateReply, ParseModeFlavor } from "@grammyjs/parse-mode";
import { sequentialize } from "@grammyjs/runner";
import AbortController from "abort-controller";
import { LanguageModel } from "ai";
import assert from "assert";
import { isNotNull } from "drizzle-orm";
import { Bot, Context, GrammyError, HttpError } from "grammy";

export type BotContext = ParseModeFlavor<Context> & {
  model: LanguageModel;

  typingIndicator: {
    enable: (enabled: boolean) => Promise<void>;
    interval: NodeJS.Timeout | null;
    controller: AbortController;
  };
};

const bot = new Bot<BotContext>(getEnv("TELEGRAM_BOT_TOKEN"), {
  client: { apiRoot: getEnv("TELEGRAM_API_ROOT") },
});

bot.use(hydrateReply);
bot.use(
  sequentialize((ctx) => {
    if (!ctx.chat || !ctx.from) return;
    const chat = ctx.chat.id.toString();
    const user = ctx.from.id.toString();
    return [chat, user];
  }),
);
bot.use(async (ctx, next) => {
  logger.debug({ update: ctx.update }, "Update Received");
  await next();
});
bot.use(async (ctx, next) => {
  ctx.model = openai("o3-mini", { structuredOutputs: false });

  if (
    ctx.msg &&
    (ctx.msg.photo || ctx.msg.document || ctx.msg.video || ctx.msg.sticker)
  ) {
    ctx.model = openai("gpt-4o");
  }

  await next();
});

// Handle wallet activity
const checkWallets = async () => {
  const users = await db.query.users.findMany({
    where: isNotNull(tables.users.solanaWallet),
    with: {
      solanaWallet: true,
    },
  });

  for (const user of users) {
    assert(user.solanaWallet, "User has no wallet");
    await handleUserWalletBalanceChange(user as any);
  }
};
const walletActivityInterval = setInterval(checkWallets, 1 * 60 * 1000);
checkWallets();

// Typing indicator
bot.use(async (ctx, next) => {
  ctx.typingIndicator = {
    interval: null,
    controller: new AbortController(),
    async enable(enabled) {
      if (enabled) {
        ctx.typingIndicator.interval = setInterval(async () => {
          await ctx.replyWithChatAction(
            "typing",
            {
              message_thread_id: ctx.msg?.message_thread_id,
            },
            ctx.typingIndicator.controller.signal,
          );
        }, TYPING_INDICATOR_DURATION);
        await ctx.replyWithChatAction(
          "typing",
          {
            message_thread_id: ctx.msg?.message_thread_id,
          },
          ctx.typingIndicator.controller.signal,
        );
      } else {
        if (ctx.typingIndicator.interval) {
          ctx.typingIndicator.controller.abort();
          clearInterval(ctx.typingIndicator.interval);
        }
      }
    },
  };

  await next();
});

bot.use(async (ctx, next) => {
  const before = Date.now();
  await next();
  const after = Date.now();
  await ctx.typingIndicator.enable(false);

  logger.debug(
    { before, after, duration: after - before },
    `Time taken to respond: ${after - before}ms (${(after - before) / 1000}s)`,
  );
});

bot.catch(async ({ error, ctx, message }) => {
  if (ctx.typingIndicator.interval) {
    ctx.typingIndicator.controller.abort();
    clearInterval(ctx.typingIndicator.interval);
  }

  if (walletActivityInterval) {
    clearInterval(walletActivityInterval);
  }

  logger.error(error, `Error while handling update ${ctx.update.update_id}`);
  if (error instanceof GrammyError) {
    logger.error(`Error in request: ${error.description}`);
  } else if (error instanceof HttpError) {
    logger.error(error, `Could not contact Telegram`);
  } else {
    logger.error(error, "Unknown error");
  }
  await ctx.reply(`Error: ${message}`);
});

export { bot };
