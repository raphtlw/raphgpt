import { Api } from "grammy";
import { Chat } from "grammy/types";
import { Env } from "secrets/env";

export const chatAction = async <Out>(
  chat: Chat,
  action: Parameters<Api["sendChatAction"]>[1],
  task: () => Promise<Out>,
  other: Parameters<Api["sendChatAction"]>[2],
): Promise<Out> => {
  const interval = setInterval(async () => {
    const api = new Api(Env.TELEGRAM_API_KEY);
    await api.sendChatAction(chat.id, action, other);
  }, 5 * 1000);

  const out = await task();

  clearInterval(interval);

  return out;
};
