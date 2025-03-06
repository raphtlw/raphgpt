import { TYPING_INDICATOR_DURATION } from "@/bot/constants";
import { activeRequests } from "@/bot/handler";
import logger from "@/bot/logger.js";
import { db, tables } from "@/db/db.js";
import { getEnv } from "@/helpers/env.js";
import { handleUserWalletBalanceChange } from "@/helpers/solana.js";
import { openai } from "@ai-sdk/openai";
import {
  conversations,
  type ConversationFlavor,
} from "@grammyjs/conversations";
import { hydrateReply, ParseModeFlavor } from "@grammyjs/parse-mode";
import AbortController from "abort-controller";
import { LanguageModel } from "ai";
import assert from "assert";
import { CronJob } from "cron";
import { isNotNull } from "drizzle-orm";
import { Bot, GrammyError, HttpError, type Context } from "grammy";

export type BotContext = ParseModeFlavor<ConversationFlavor<Context>> & {
  model: LanguageModel;

  chatAction: {
    kind: Parameters<BotContext["replyWithChatAction"]>[0];
    enable: (enabled: boolean) => Promise<void>;
    interval: NodeJS.Timeout | null;
    controller: AbortController;
  };
};

const bot = new Bot<BotContext>(getEnv("TELEGRAM_BOT_TOKEN"), {
  client: { apiRoot: getEnv("TELEGRAM_API_ROOT") },
});

bot.use(hydrateReply);
bot.use(conversations());
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

// Reset free tier message counts
const job = new CronJob("0 0 * * *", async () => {
  const result = await db.update(tables.users).set({
    freeTierMessageCount: 0,
  });
  logger.info(result, "Reset free tier message quota");
});
job.start();

// Typing indicator
bot.use(async (ctx, next) => {
  ctx.chatAction = {
    kind: "typing",
    interval: null,
    controller: new AbortController(),
    async enable(enabled) {
      if (enabled) {
        if (ctx.chatAction.interval) {
          clearInterval(ctx.chatAction.interval);
        }
        ctx.chatAction.interval = setInterval(async () => {
          try {
            await ctx.replyWithChatAction(
              this.kind,
              {
                message_thread_id: ctx.msg?.message_thread_id ?? ctx.chatId,
              },
              ctx.chatAction.controller.signal,
            );
          } catch {
            logger.error("replyWithChatAction failed but it doesn't matter");
            await this.enable(false);
          }
        }, TYPING_INDICATOR_DURATION);
        await ctx.replyWithChatAction(
          this.kind,
          {
            message_thread_id: ctx.msg?.message_thread_id ?? ctx.chatId,
          },
          ctx.chatAction.controller.signal,
        );
      } else {
        if (ctx.chatAction.interval) {
          logger.debug("Stopping typing indicator");
          ctx.chatAction.controller.abort();
          clearInterval(ctx.chatAction.interval);
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
  await ctx.chatAction.enable(false);

  logger.debug(
    { before, after, duration: after - before },
    `Time taken to respond: ${after - before}ms (${(after - before) / 1000}s)`,
  );
});

bot.catch(async ({ error, ctx, message }) => {
  await ctx.chatAction.enable(false);

  if (walletActivityInterval) {
    clearInterval(walletActivityInterval);
  }

  if (ctx.from) {
    activeRequests.delete(ctx.from.id);
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
