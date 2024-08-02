import { hydrateReply, ParseModeFlavor } from "@grammyjs/parse-mode";
import { sequentialize } from "@grammyjs/runner";
import { Bot, Context, GrammyError, HttpError } from "grammy";
import logger from "./logger.js";

const bot = new Bot<ParseModeFlavor<Context>>(process.env.TELEGRAM_BOT_TOKEN!, {
  client: { apiRoot: "http://localhost:8081" },
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

bot.catch(async ({ error, ctx, message }) => {
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
