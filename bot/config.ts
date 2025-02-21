import { WHISPER_LANGUAGES } from "@/bot/constants";
import logger from "@/bot/logger.js";
import { kv } from "@/kv/redis.js";
import { z } from "zod";

export const configSchema = z.object({
  language: z
    .enum(WHISPER_LANGUAGES)
    .describe("Preferred language to use. Set 'None' to automatically detect")
    .default("None"),
  messagehistsize: z
    .number()
    .min(0)
    .max(15)
    .describe("Amount of messages to keep in memory")
    .default(6),
});

export const getConfigValue = async <K extends keyof typeof configSchema.shape>(
  telegramUserId: number,
  key: K,
): Promise<z.infer<typeof configSchema>[K]> => {
  const config = await kv.HGETALL(`config:${telegramUserId}`);

  logger.debug(config);

  if (!config) {
    // Return the default value
    return configSchema.parse({ [key]: undefined })[key];
  }

  return configSchema.parse(config)[key];
};
