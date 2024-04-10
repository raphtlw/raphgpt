import { Api } from "grammy";
import { Chat } from "grammy/types";
import { Env } from "secrets/env";

export const chatAction = async <TArgs extends unknown[], Out>(
  chat: Chat,
  action: Parameters<Api["sendChatAction"]>[1],
  task: (...args: TArgs) => Promise<Out>,
  ...args: TArgs
): Promise<Out> => {
  const interval = setInterval(async () => {
    const api = new Api(Env.TELEGRAM_API_KEY);
    await api.sendChatAction(chat.id, action);
  }, 5 * 1000);

  const out = await task(...args);

  clearInterval(interval);

  return out;
};
