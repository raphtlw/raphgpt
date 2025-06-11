import {
  commandNotFound,
  commands,
  type CommandsFlavor,
} from "@grammyjs/commands";
import {
  conversations,
  type ConversationFlavor,
} from "@grammyjs/conversations";
import { commands as botCommands } from "bot/commands";
import { PRODUCTION } from "bot/constants";
import { activeRequests, handler } from "bot/handler";
import logger from "bot/logger";
import { ChatAction } from "bot/running-tasks";
import {
  Bot,
  GrammyError,
  HttpError,
  session,
  type Context,
  type SessionFlavor,
} from "grammy";
import fs from "node:fs/promises";
import { getEnv } from "utils/env";

export type SessionData = {
  topupAmountDollars: number | null;
  pendingPaymentInvoicePayload: string | null;
  chatAction: ChatAction | null;
  tempFiles: string[];
};

export type BotContext = SessionFlavor<SessionData> &
  CommandsFlavor<Context> &
  ConversationFlavor<Context>;

export const bot = new Bot<BotContext>(getEnv("TELEGRAM_BOT_TOKEN"), {
  client: { apiRoot: getEnv("TELEGRAM_API_URL") },
});

bot.use(
  session({
    initial: () => ({
      tempFiles: [] as string[],
    }),
  }),
);
bot.use(commands());
bot.use(conversations());
bot.use(async (ctx, next) => {
  logger.debug({ update: ctx.update }, "Update Received");
  await next();
});

// Set bot information
if (PRODUCTION) {
  try {
    await bot.api.setMyDescription(
      "The best AI companion on Telegram! This started as a personal project to create a bot that can do things for me. It can listen to voice messages and watch video messages.",
      {
        language_code: "en",
      },
    );
    await bot.api.setMyShortDescription(
      "Powered by OpenAI. Any inquiries @raphtlw",
      {
        language_code: "en",
      },
    );
  } catch {
    logger.error(
      "Encountered an error setting the bot's description, but it's okay.",
    );
  }
}

bot.use(botCommands);

// Set available bot commands
await botCommands.setCommands(bot).catch((e) => {
  logger.error(
    "Encountered an error setting the bot's commands, but it's okay.",
  );
});

// Suggesting the nearest command
bot.filter(commandNotFound(botCommands)).use(async (ctx) => {
  if (ctx.commandSuggestion) {
    await ctx.reply(
      `Hmm... I don't know that command. Did you mean ${ctx.commandSuggestion}?`,
    );
  } else {
    await ctx.reply("Oops... I don't know that command 😥");
  }
});

bot.use(handler);

bot.use(async (ctx, next) => {
  try {
    await next();
  } finally {
    if (ctx.session.tempFiles?.length) {
      for (const filePath of ctx.session.tempFiles) {
        try {
          await fs.rm(filePath, { force: true });
        } catch (e) {
          logger.error({ e, filePath }, "Error cleaning up temporary file");
        }
      }
      ctx.session.tempFiles = [];
    }
  }
});

bot.use(async (ctx, next) => {
  const before = Date.now();
  await next();
  const after = Date.now();

  logger.debug(
    { before, after, duration: after - before },
    `Time taken to respond: ${after - before}ms (${(after - before) / 1000}s)`,
  );
});

bot.catch(async ({ error, ctx, message }) => {
  if (ctx.from) {
    activeRequests.delete(ctx.from.id);
  }

  if (ctx.session.chatAction) {
    ctx.session.chatAction.stop();
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
