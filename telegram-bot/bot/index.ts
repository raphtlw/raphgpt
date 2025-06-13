import {
  conversations,
  type ConversationFlavor,
} from "@grammyjs/conversations";
import { PRODUCTION } from "bot/constants";
import { configHandler } from "bot/handlers/config";
import { creditsHandler } from "bot/handlers/credits";
import { generalHandler } from "bot/handlers/general";
import { messageHandler } from "bot/handlers/message";
import { personalityHandler } from "bot/handlers/personality";
import { requestHandler } from "bot/handlers/request";
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
  task: AbortController | null;
  tempFiles: string[];
  topupAmountDollars: number | null;
  pendingPaymentInvoicePayload: string | null;
  chatAction: ChatAction | null;
};

export type BotContext = SessionFlavor<SessionData> &
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
bot.use(conversations());
bot.use(async (ctx, next) => {
  console.log({ update: ctx.update }, "Update Received");
  await next();
});

// ───────────────────────────────────────────────────────────────
// ⚙️  Register slash commands + about/description with Telegram
// ───────────────────────────────────────────────────────────────
if (PRODUCTION) {
  try {
    await bot.api.setMyCommands([
      {
        command: "start",
        description: "Start the bot & show usage instructions",
      },
      { command: "clear", description: "Clear your session history & memory" },
      {
        command: "personality",
        description: "View & edit custom personality prompts",
      },
      {
        command: "set",
        description: "Set configuration options (API key, model…)",
      },
      {
        command: "config",
        description: "Show your current configuration settings",
      },
      { command: "cancel", description: "Cancel the ongoing request" },
      { command: "balance", description: "View your AI credits balance" },
      { command: "topup", description: "Purchase additional credits" },
    ]);

    await bot.api.setMyDescription(
      `RaphGPT is an AI‑powered Telegram bot that lets you chat naturally with LLMs via text, voice or video.
  • Transcribe voice & video, extract key frames & summaries
  • Customize your bot’s personality prompts
  • Configure API keys, models & settings on the fly
  • Track & top‑up AI credits (Stripe & Solana supported)
  • Clear short‑term memory or long‑term vector history
  • Built‑in image generation, agents & tool integrations`,
    );

    await bot.api.setMyShortDescription(
      "AI assistant for Telegram: chat, voice & video‑analysis, image gen, google maps & bus timings",
    );
  } catch {
    console.error(
      "Encountered an error setting the bot's about/information, but it's okay.",
    );
  }
}

// Post-handler cleanup
bot.use(async (ctx, next) => {
  try {
    await next();
  } finally {
    ctx.session.task = null;
    ctx.session.chatAction?.stop();

    if (ctx.session.tempFiles?.length > 0) {
      for (const filePath of ctx.session.tempFiles) {
        try {
          await fs.rm(filePath, { force: true });
        } catch (e) {
          console.error({ e, filePath }, "Error cleaning up temporary file");
        }
      }
      ctx.session.tempFiles = [];
    }
  }
});

bot.use(configHandler);
bot.use(creditsHandler);
bot.use(generalHandler);
bot.use(requestHandler);
bot.use(personalityHandler);

bot.use(messageHandler);

bot.use(async (ctx, next) => {
  const before = Date.now();
  await next();
  const after = Date.now();

  console.log(
    { before, after, duration: after - before },
    `Time taken to respond: ${after - before}ms (${(after - before) / 1000}s)`,
  );
});

bot.catch(async ({ error, ctx, message }) => {
  if (ctx.session.chatAction) {
    ctx.session.chatAction.stop();
  }
  if (ctx.session.task) {
    ctx.session.task.abort();
  }

  console.error(error, `Error while handling update ${ctx.update.update_id}`);
  if (error instanceof GrammyError) {
    console.error(`Error in request: ${error.description}`);
  } else if (error instanceof HttpError) {
    console.error(error, `Could not contact Telegram`);
  } else {
    console.error(error, "Unknown error");
  }
  await ctx.reply(`Error: ${message}`);
});
