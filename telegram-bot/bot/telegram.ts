import { fileTypeFromBuffer } from "file-type";
import fs from "fs";
import { Api } from "grammy";
import type { File } from "grammy/types";
import { getEnv } from "utils/env";

export const telegram = new Api(getEnv("TELEGRAM_BOT_TOKEN"), {
  apiRoot: getEnv("TELEGRAM_API_URL"),
});

/**
 * Downloads a file from Telegram, using the API hosted
 * at the environment variable TELEGRAM_API_URL to TEMP_DIR.
 */
export async function downloadTelegramFile(telegramFile: File, dest: string) {
  if (!telegramFile.file_path)
    throw new Error(
      "Cannot call downloadTelegramFile when there is no file path!",
    );

  // Construct file URL
  const fileUrl = `${getEnv("TELEGRAM_API_URL")}/file/bot${getEnv(
    "TELEGRAM_BOT_TOKEN",
  )}/${telegramFile.file_path}`;

  // Download file
  const resp = await fetch(fileUrl);
  await Bun.write(dest, resp);

  // Detect file type
  const fileBuffer = await fs.promises.readFile(dest);
  const fileType = await fileTypeFromBuffer(new Uint8Array(fileBuffer));

  // Rename file with better extension
  if (fileType) {
    const localPathWithExt = `${dest}.${fileType.ext}`;
    await fs.promises.rename(dest, localPathWithExt);
    return {
      remoteUrl: fileUrl,
      localPath: localPathWithExt,
      fileType: fileType ?? null,
    };
  }

  return {
    remoteUrl: fileUrl,
    localPath: dest,
    fileType: fileType ?? null,
  } as const;
}
