import type { BotContext } from "bot";
import { fileTypeFromBuffer, type FileTypeResult } from "file-type";
import fs from "fs";
import { Api } from "grammy";
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
  ctx: BotContext,
): Promise<{
  localPath: string;
  remoteUrl: string;
  fileType: FileTypeResult | null;
}> => {
  if (ctx.has(":file")) {
    const telegramFile = await ctx.getFile();

    if (!telegramFile.file_path)
      throw new Error("Cannot call downloadFile when there is no file path!");

    // Construct file URL
    const fileUrl = `${getEnv("TELEGRAM_API_URL")}/file/bot${getEnv(
      "TELEGRAM_BOT_TOKEN",
    )}/${telegramFile.file_path}`;

    // Download file
    const resp = await fetch(fileUrl);
    const localPath = path.join(
      ctx.session.tempDir,
      path.basename(telegramFile.file_path),
    );
    await Bun.write(localPath, resp);

    // Detect file type
    const fileBuffer = await fs.promises.readFile(localPath);
    const fileType = await fileTypeFromBuffer(new Uint8Array(fileBuffer));

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
