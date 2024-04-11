import {
  FormattedString,
  blockquote,
  bold,
  fmt,
  italic,
  link,
} from "@grammyjs/parse-mode";
import { createId } from "@paralleldrive/cuid2";
import assert from "assert";
import { db } from "db";
import { messages } from "db/schema";
import { Api, RawApi } from "grammy";
import { Other } from "node_modules/grammy/out/core/api";
import { Env } from "secrets/env";
import { inspect } from "util";

export const markdownToEntities = (text: string) => {
  const result: (FormattedString | { alt: string; imageUrl: string })[] = [];
  const msgbuf: FormattedString[] = [];
  const tbuf: string[] = [];

  let cursor = 0;
  while (cursor < text.length) {
    // parse bold
    if (text[cursor] === "*" && text[cursor + 1] === "*") {
      cursor++;
      cursor++;

      while ((text[cursor] === "*" && text[cursor + 1] === "*") === false) {
        tbuf.push(text[cursor]);
        cursor++;
      }
      cursor++;

      msgbuf.push(bold(tbuf.join("")));
      tbuf.length = 0;

      cursor++;
      continue;
    }

    // parse link
    if (text[cursor] === "[") {
      cursor++;
      while (text[cursor] !== "]") {
        tbuf.push(text[cursor]); // link name
        cursor++;
      }
      cursor++;

      const linkName = tbuf.join("");
      tbuf.length = 0;

      assert(
        text[cursor] === "(",
        "Parsing error: missing parenthesis after link label",
      );

      cursor++;
      while (text[cursor] !== ")") {
        tbuf.push(text[cursor]); // link url
        cursor++;
      }

      const linkUrl = tbuf.join("");
      tbuf.length = 0;

      msgbuf.push(link(linkName, linkUrl));

      cursor++;
      continue;
    }

    // parse image
    if (text[cursor] === "!" && text[cursor + 1] === "[") {
      cursor++;
      cursor++;

      while (text[cursor] !== "]") {
        tbuf.push(text[cursor]);
        cursor++;
      }
      cursor++;

      const imageAlt = tbuf.join("");
      tbuf.length = 0;

      assert(
        text[cursor] === "(",
        "Parsing error: missing parenthesis after image alt",
      );

      cursor++;
      while (text[cursor] !== ")") {
        tbuf.push(text[cursor]); // link url
        cursor++;
      }

      const imageUrl = tbuf.join("");
      tbuf.length = 0;

      result.push(fmt(msgbuf));
      msgbuf.length = 0;

      result.push({ alt: imageAlt, imageUrl });

      cursor++;
      continue;
    }

    // parse italic
    if (text[cursor] === "*") {
      cursor++;

      while (text[cursor] !== "*") {
        tbuf.push(text[cursor]);
        cursor++;
      }

      msgbuf.push(italic(tbuf.join("")));
      tbuf.length = 0;

      cursor++;
      continue;
    }

    msgbuf.push(fmt([text[cursor]]));
    cursor++;
  }

  result.push(fmt(msgbuf));
  msgbuf.length = 0;

  console.log(inspect(result, true, 10, true));
  assert(tbuf.length === 0, "tbuf should be empty!");

  return result;
};

export const sendMarkdownMessage = async <R extends RawApi>(
  chat_id: string | number,
  text: string,
  other?: Other<R, "sendMessage", "chat_id" | "text">,
) => {
  const api = new Api(Env.TELEGRAM_API_KEY);

  const formattedMessages = markdownToEntities(text);

  for (const msg of formattedMessages) {
    if ("imageUrl" in msg) {
      await api.sendPhoto(chat_id, msg.imageUrl, {
        ...other,
        caption: msg.alt,
      });
    } else {
      await api.sendMessage(chat_id, msg.text, {
        ...other,
        entities: msg.entities,
      });
    }
  }
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
