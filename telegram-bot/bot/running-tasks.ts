import { TYPING_INDICATOR_DURATION } from "bot/constants";
import { telegram } from "bot/telegram";
import { AbortController } from "node_modules/grammy/out/shim.node";
import { cancellableInterval } from "utils/interval";

type ChatActionKind = Parameters<typeof telegram.sendChatAction>[1];

const RUNNING_CHAT_ACTIONS: Record<number, ChatAction[]> = [];

// Chat action
export class ChatAction {
  private chatId: number;
  private action: ChatActionKind;
  private abort: AbortController;

  constructor(chatId: number, action: ChatActionKind) {
    this.chatId = chatId;
    this.action = action;
    this.abort = new AbortController();

    this.startInterval();
    this.sendChatAction(chatId, action);

    if (!RUNNING_CHAT_ACTIONS[chatId]) {
      RUNNING_CHAT_ACTIONS[chatId] = [this];
    } else {
      RUNNING_CHAT_ACTIONS[chatId].push(this);
    }
  }

  async sendChatAction(chatId: number, action: ChatActionKind) {
    await telegram.sendChatAction(chatId, action, {}, this.abort.signal);
  }

  startInterval() {
    cancellableInterval(
      this.sendChatAction.bind(this),
      TYPING_INDICATOR_DURATION,
      this.abort.signal,
      this.chatId,
      this.action,
    );
  }

  stop() {
    this.abort.abort();
  }
}

export function clearRunningChatActions(chatId: number) {
  if (!RUNNING_CHAT_ACTIONS[chatId]) return;
  while (RUNNING_CHAT_ACTIONS[chatId].length > 0) {
    const chatAction = RUNNING_CHAT_ACTIONS[chatId].pop();
    chatAction?.stop();
  }
}

export function clearAllRunningChatActions() {
  for (const chatId in RUNNING_CHAT_ACTIONS) {
    clearRunningChatActions(parseInt(chatId));
  }
}
