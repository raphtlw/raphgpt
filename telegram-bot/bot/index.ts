import {
  conversations,
  type ConversationFlavor,
} from "@grammyjs/conversations";
import { createId } from "@paralleldrive/cuid2";
import { PRODUCTION, TEMP_DIR } from "bot/constants";
import { configHandler } from "bot/handlers/config";
import { creditsHandler } from "bot/handlers/credits";
import { generalHandler } from "bot/handlers/general";
import { instructionsHandler } from "bot/handlers/instructions";
import { messageHandler } from "bot/handlers/message";
import { personalityHandler } from "bot/handlers/personality";
import { requestHandler } from "bot/handlers/request";
import { ChatAction, clearRunningChatActions } from "bot/running-tasks";
import { downloadTelegramFile } from "bot/telegram";
import { inspect } from "bun";
import type { FileTypeResult } from "file-type";
import {
  Bot,
  GrammyError,
  HttpError,
  session,
  type Context,
  type Middleware,
  type SessionFlavor,
} from "grammy";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnv } from "utils/env";

export type SessionData = {
  tempDir: string;
  task: AbortController | null;
  topupAmountDollars: number | null;
  pendingPaymentInvoicePayload: string | null;
  chatAction: ChatAction | null;

  // Media groups
  mediaGroupId?: string;
  mediaGroupCtxs?: BotContext[];
  mediaGroupTimer?: NodeJS.Timeout;
};

export type BotContext = SessionFlavor<SessionData> &
  ConversationFlavor<Context> &
  FileFlavor<Context & SessionFlavor<SessionData>>;

export type FileFlavor<C extends Context & SessionFlavor<SessionData>> = C & {
  downloadFile: () => Promise<{
    remoteUrl: string;
    localPath: string;
    fileType: FileTypeResult | null;
  }>;
};

function telegramFileMiddleware<
  C extends FileFlavor<Context & SessionFlavor<SessionData>>,
>(): Middleware<C> {
  return async (ctx, next) => {
    ctx.downloadFile = async () => {
      const telegramFile = await ctx.getFile();
      if (!telegramFile.file_path)
        throw new Error("Cannot call downloadFile when there is no file path!");

      const destination = path.join(
        ctx.session.tempDir,
        path.basename(telegramFile.file_path),
      );

      return await downloadTelegramFile(telegramFile, destination);
    };

    await next();
  };
}

export const bot = new Bot<BotContext>(getEnv("TELEGRAM_BOT_TOKEN"), {
  client: { apiRoot: getEnv("TELEGRAM_API_URL") },
});

bot.use(session({ initial: () => ({}) }));
bot.use(conversations());
bot.use(telegramFileMiddleware());
bot.use(async (ctx, next) => {
  console.log("Update Received:", { update: ctx.update });
  await next();
});

// ───────────────────────────────────────────────────────────────
// ⚙️  Register slash commands + about/description with Telegram
// ───────────────────────────────────────────────────────────────
if (PRODUCTION) {
  try {
    // ─── Available slash commands ─────────────────────────────────────────────
    // /start         - Start the bot & show usage instructions
    // /clear         - Clear your session history & memory
    // /personality   - View & edit custom personality prompts
    // /instructions  - Manage system instructions (admin only)
    // /set           - Set configuration options (API key, model…)
    // /config        - Show your current configuration settings
    // /cancel        - Cancel the ongoing request
    // /balance       - View your AI credits balance
    // /topup         - Purchase additional credits
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
        command: "instructions",
        description: "Manage system instructions (admin only)",
      },
      {
        command: "set",
        description: "Set configuration options (Timezone, language, model…)",
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
  • Manage system instructions via /instructions (admin only)
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

bot.use(async (ctx, next) => {
  ctx.session.tempDir = path.join(TEMP_DIR, createId());
  await fs.mkdir(ctx.session.tempDir, { recursive: true });
  await next();
});

// Post-handler cleanup
bot.use(async (ctx, next) => {
  try {
    await next();
  } finally {
    ctx.session.task = null;
    ctx.session.chatAction?.stop();
    clearRunningChatActions(ctx.chatId!);

    console.log(
      "Temporary directory after message handler:",
      ctx.session.tempDir,
    );

    await fs.rm(ctx.session.tempDir, { recursive: true, force: true });
  }
});

bot.use(configHandler);
bot.use(creditsHandler);
bot.use(generalHandler);
bot.use(requestHandler);
bot.use(personalityHandler);
bot.use(instructionsHandler);

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
  if (ctx && ctx.session && ctx.session.chatAction) {
    ctx.session.chatAction.stop();
  }
  if (ctx && ctx.session && ctx.session.task) {
    ctx.session.task.abort();
  }
  if (ctx.chatId) {
    clearRunningChatActions(ctx.chatId!);
  }

  console.error(
    `Error while handling update ${ctx.update.update_id}\n${inspect(error)}`,
  );
  if (error instanceof GrammyError) {
    console.error(`Error in request: ${error.description}`);
  } else if (error instanceof HttpError) {
    console.error(`Could not contact Telegram: ${inspect(error)}`);
  } else {
    console.error(`Unknown error: ${inspect(error)}`);
  }
  await ctx.reply(message);
});
