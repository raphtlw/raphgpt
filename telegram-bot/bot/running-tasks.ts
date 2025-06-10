import { TYPING_INDICATOR_DURATION } from "bot/constants";
import { telegram } from "bot/telegram";
import { AbortController } from "node_modules/grammy/out/shim.node";
import { cancellableInterval } from "utils/interval";

type ChatActionKind = Parameters<typeof telegram.sendChatAction>[1];

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
