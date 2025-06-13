import { createId } from "@paralleldrive/cuid2";
import { TEMP_DIR } from "bot/constants";
import { fileTypeFromBuffer, type FileTypeResult } from "file-type";
import fs from "fs";
import { Api, Context } from "grammy";
import path from "path";
import { getEnv } from "utils/env";

export const telegram = new Api(getEnv("TELEGRAM_BOT_TOKEN"), {
  apiRoot: getEnv("TELEGRAM_API_URL"),
});

/**
 * Downloads a file from Telegram, using the API hosted
 * at the environment variable TELEGRAM_API_URL to TEMP_DIR.
 */
export const downloadFile = async (
  ctx: Context,
): Promise<{
  localPath: string;
  remoteUrl: string;
  fileType: FileTypeResult | null;
}> => {
  if (ctx.has(":file")) {
    const telegramFile = await ctx.getFile();

    // Construct file URL
    const fileUrl = `${getEnv("TELEGRAM_API_URL")}/file/bot${getEnv(
      "TELEGRAM_BOT_TOKEN",
    )}/${telegramFile.file_path}`;

    // Download file
    const resp = await fetch(fileUrl);
    const localPath = path.join(TEMP_DIR, createId());
    await Bun.write(localPath, resp);

    // Detect file type
    const fileBuffer = await fs.promises.readFile(localPath);
    const fileType = await fileTypeFromBuffer(new Uint8Array(fileBuffer));
    console.log(fileType, "Document file type");

    // Rename file with better extension
    if (fileType) {
      const localPathWithExt = `${localPath}.${fileType.ext}`;
      await fs.promises.rename(localPath, localPathWithExt);
      return {
        remoteUrl: fileUrl,
        localPath: localPathWithExt,
        fileType: fileType ?? null,
      };
    }

    return {
      remoteUrl: fileUrl,
      localPath,
      fileType: fileType ?? null,
    };
  }

  throw new Error("downloadFile called on context with no file");
};
