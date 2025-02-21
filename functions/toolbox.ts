import logger from "@/bot/logger.js";
import { telegram } from "@/bot/telegram";
import { ToolData } from "@/helpers/function";
import { tool } from "ai";
import { z } from "zod";

export const toolbox = (data: ToolData) => {
  return {
    blockchain_data: tool({
      description: "Analyze the solana blockchain",
      parameters: z.object({}),
      async execute() {
        logger.debug("tool triggered");
        telegram.sendMessage(data.chatId, "boom");

        return "ack";
      },
    }),
  };
};
