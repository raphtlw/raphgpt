import { Api } from "grammy";
import { Chat } from "grammy/types";

export const telegram = new Api(process.env.TELEGRAM_BOT_TOKEN!);

export const chatAction = async <Out>(
  chat: Chat,
  action: Parameters<Api["sendChatAction"]>[1],
  task: () => Promise<Out>,
  other: Parameters<Api["sendChatAction"]>[2],
): Promise<Out> => {
  const interval = setInterval(async () => {
    await telegram.sendChatAction(chat.id, action, other);
  }, 5 * 1000);

  try {
    const out = await task();
    clearInterval(interval);
    return out;
  } catch (e) {
    clearInterval(interval);
    throw e;
  }
};
