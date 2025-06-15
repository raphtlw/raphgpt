import { db, tables } from "db";
import { eq } from "drizzle-orm";
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
  timezone: z
    .string()
    .nullable()
    .describe("Time zone identifier (IANA format, e.g. 'Asia/Singapore')")
    .default(null),
});

export const getConfigValue = async <K extends keyof typeof configSchema.shape>(
  telegramUserId: number,
  key: K,
): Promise<z.infer<typeof configSchema>[K]> => {
  const configRow = await db.query.userConfig.findFirst({
    where: eq(tables.userConfig.userId, telegramUserId),
  });

  if (!configRow) {
    // Return the default value
    return configSchema.parse({ [key]: undefined })[key];
  }

  // Parse full row to enforce schema and defaults
  return configSchema.parse(configRow)[key];
};
