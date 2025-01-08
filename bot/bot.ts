import { TYPING_INDICATOR_DURATION } from "@/bot/constants";
import logger from "@/bot/logger.js";
import { db, tables } from "@/db/db.js";
import { getEnv } from "@/helpers/env.js";
import { handleUserWalletBalanceChange } from "@/helpers/solana.js";
import { hydrateReply, ParseModeFlavor } from "@grammyjs/parse-mode";
import { sequentialize } from "@grammyjs/runner";
import AbortController from "abort-controller";
import assert from "assert";
import { isNotNull } from "drizzle-orm";
import { Bot, Context, GrammyError, HttpError } from "grammy";

export type BotContext = ParseModeFlavor<Context> & {
  typing: {
    interval: NodeJS.Timeout | null;
    indicator: boolean;
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
  const before = Date.now();
  await next();
  const after = Date.now();

  logger.debug(
    { before, after, duration: after - before },
    `Time taken to respond: ${after - before}ms (${(after - before) / 1000}s)`,
  );
});
bot.use(async (ctx, next) => {
  logger.debug({ update: ctx.update }, "Update Received");
  await next();
});

// Handle wallet activity
let walletActivityInterval: NodeJS.Timeout;
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
walletActivityInterval = setInterval(checkWallets, 1 * 60 * 1000);
checkWallets();

bot.use(async (ctx, next) => {
  const controller = new AbortController();

  if (!ctx.typing) {
    ctx.typing = {
      interval: null,
      set indicator(enabled: boolean) {
        if (enabled) {
          ctx.typing.interval = setInterval(async () => {
            if (ctx.typing.indicator) {
              await ctx.replyWithChatAction(
                "typing",
                {
                  message_thread_id: ctx.msg?.message_thread_id,
                },
                controller.signal,
              );
            }
          }, TYPING_INDICATOR_DURATION);
        } else if (ctx.typing.interval) {
          controller.abort();
          clearInterval(ctx.typing.interval);
        }
      },
    };
  }

  await next();

  if (ctx.typing.interval) {
    controller.abort();
    clearInterval(ctx.typing.interval);
  }
});

bot.catch(async ({ error, ctx, message }) => {
  if (ctx.typing.interval) clearInterval(ctx.typing.interval);
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
