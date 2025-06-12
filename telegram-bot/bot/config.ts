import logger from "bot/logger.js";
import { redis } from "connections/redis";
import lang from "iso-language-codes";
import { z } from "zod";

export const configSchema = z.object({
  language: z
    .enum(lang.map((code) => code.iso639_1) as any)
    .describe(
      "Preferred language to use in iso 639_1 codes. Set 'None' to automatically detect",
    )
    .default("en"),
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
  const config = await redis.HGETALL(`config:${telegramUserId}`);

  logger.debug(config);

  if (!config) {
    // Return the default value
    return configSchema.parse({ [key]: undefined })[key];
  }

  return configSchema.parse(config)[key];
};
