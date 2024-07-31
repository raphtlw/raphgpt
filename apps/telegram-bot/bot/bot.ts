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

bot.catch((err) => {
  const ctx = err.ctx;
  logger.error(err, `Error while handling update ${ctx.update.update_id}`);
  const e = err.error;
  if (e instanceof GrammyError) {
    logger.error(`Error in request: ${e.description}`);
  } else if (e instanceof HttpError) {
    logger.error(e, `Could not contact Telegram`);
  } else {
    logger.error(e, "Unknown error");
  }
});

export { bot };
