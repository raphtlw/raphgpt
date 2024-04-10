import { blockquote, fmt } from "@grammyjs/parse-mode";
import { createId } from "@paralleldrive/cuid2";
import { db } from "db";
import { messages } from "db/schema";
import { Api, RawApi } from "grammy";
import { Other } from "node_modules/grammy/out/core/api";
import { Env } from "secrets/env";

export const sendMultimodalMessage = async <R extends RawApi>(
  chat_id: string | number,
  text: string,
  other?: Other<R, "sendMessage", "chat_id" | "text">,
) => {
  const api = new Api(Env.TELEGRAM_API_KEY);

  const buf: string[] = [];

  const flushBuf = async () => {
    if (buf.length > 0) {
      await sendMessage(chat_id, buf.join("\n"), {
        ...other,
        parse_mode: "MarkdownV2",
      });
      buf.length = 0;
    }
  };

  for (let line of text.split("\n")) {
    console.log("Processing line:", line);

    const img = /^!\[(.*)\]\((.*)\).*/gm.exec(line);
    if (img) {
      await flushBuf();
      await api.sendPhoto(chat_id, img[2], {
        ...other,
        caption: img[1],
        parse_mode: "MarkdownV2",
      });
      continue;
    }

    const ul = /-\s(.*)/gm.exec(line);
    if (ul) {
      line = `• ${ul[1]}`;
    }

    line = line.replaceAll("**", "*");

    for (const ec of [
      "!",
      "*",
      "_",
      "[",
      "]",
      "(",
      ")",
      "~",
      "`",
      ".",
      "{",
      "}",
      "|",
      "<",
      ">",
      "-",
      "=",
    ]) {
      line = line.replaceAll(ec, "\\" + ec);
    }

    buf.push(line);
  }

  await flushBuf();
};

export const sendMessage = async <R extends RawApi>(
  chat_id: string | number,
  text: string,
  other?: Other<R, "sendMessage", "chat_id" | "text">,
) => {
  const api = new Api(Env.TELEGRAM_API_KEY);
  const bot = await api.getMe();

  const message = await api.sendMessage(chat_id, text, other);
  await db.insert(messages).values({
    id: createId(),
    telegramId: message.message_id.toString(),
    telegramChatId: message.chat.id.toString(),
    telegramAuthorId: bot.id.toString(),
    contextData: JSON.stringify(message),
    text: message.text,
  });

  const botUpdatesMessageNotification = fmt([
    "Bot sent message:",
    "\n",
    blockquote(message.text),
  ]);
  await api.sendMessage(
    Env.TELEGRAM_BOT_UPDATES_CHAT_ID,
    botUpdatesMessageNotification.text,
    {
      entities: botUpdatesMessageNotification.entities,
    },
  );
};
