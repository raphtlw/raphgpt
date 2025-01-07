import { z } from "zod";
import { kv } from "../kv/redis.js";
import logger from "./logger.js";

const whisperLanguages = [
  "auto",
  "en", // English
  "zh", // Chinese (Mandarin)
  "es", // Spanish
  "fr", // French
  "de", // German
  "ru", // Russian
  "ja", // Japanese
  "pt", // Portuguese
  "ko", // Korean
  "it", // Italian
  "ar", // Arabic
  "hi", // Hindi
  "nl", // Dutch
  "pl", // Polish
  "tr", // Turkish
  "uk", // Ukrainian
  "vi", // Vietnamese
  "cs", // Czech
  "sv", // Swedish
  "el", // Greek
  "he", // Hebrew
  "th", // Thai
  "ro", // Romanian
  "id", // Indonesian
  "hu", // Hungarian
  "fi", // Finnish
  "da", // Danish
  "no", // Norwegian
  "ms", // Malay
  "bg", // Bulgarian
  "ca", // Catalan
  "sr", // Serbian
  "sk", // Slovak
  "hr", // Croatian
  "ta", // Tamil
  "bn", // Bengali
  "tl", // Filipino (Tagalog)
  "fa", // Persian
  "lt", // Lithuanian
  "sl", // Slovenian
  "lv", // Latvian
  "et", // Estonian
  "mk", // Macedonian
  "eu", // Basque
  "is", // Icelandic
  "bs", // Bosnian
  "sq", // Albanian
  "sw", // Swahili
  "am", // Amharic
  "ka", // Georgian
  "hy", // Armenian
  "km", // Khmer
  "mt", // Maltese
  "yo", // Yoruba
  "zu", // Zulu
] as const;

export const configSchema = z.object({
  language: z
    .enum(whisperLanguages)
    .describe("Preferred language to use. Set 'auto' to automatically detect")
    .default("auto"),
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
) => {
  const config = await kv.HGETALL(`config:${telegramUserId}`);

  logger.debug(config);

  if (!config) {
    return configSchema.shape[key].default;
  }

  return configSchema.parse(config)[key];
};
