import type { BotContext } from "bot";
import { getEnv } from "utils/env";
import { z } from "zod";

export async function acceptPrivateOrWithPrefix(ctx: BotContext) {
  if (!ctx.from) throw new Error("ctx.from not found");

  if (ctx.hasChatType("private")) {
    return true;
  }
  if (
    ctx.from.id === getEnv("TELEGRAM_BOT_OWNER", z.coerce.number()) &&
    ctx.msg?.text?.startsWith("-bot ")
  ) {
    return true;
  }
  return false;
}
