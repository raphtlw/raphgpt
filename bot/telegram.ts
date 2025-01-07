import { createId } from "@paralleldrive/cuid2";
import assert from "assert";
import { fileTypeFromFile, FileTypeResult } from "file-type";
import fs from "fs";
import got from "got";
import { Api, Context } from "grammy";
import path from "path";
import { pipeline as streamPipeline } from "stream/promises";
import { getEnv } from "../helpers/env.js";
import { LOCAL_FILES_DIR } from "./constants.js";
import logger from "./logger.js";

export const telegram = new Api(getEnv("TELEGRAM_BOT_TOKEN"));

export const downloadFile = async (
  ctx: Context,
): Promise<{
  localPath: string;
  remoteUrl: string;
  fileType: FileTypeResult | null;
}> => {
  if (ctx.has(":file")) {
    const telegramFile = await ctx.getFile();
    logger.debug(telegramFile);

    // Construct file URL
    const fileUrl = `https://${getEnv("TELEGRAM_API_FILES_ROOT")}/${getEnv("TELEGRAM_BOT_TOKEN")}/${telegramFile.file_path}`;

    // Download file
    const localPath = path.join(LOCAL_FILES_DIR, createId());
    await streamPipeline(got.stream(fileUrl), fs.createWriteStream(localPath));

    // Detect file type
    const fileType = await fileTypeFromFile(localPath);
    logger.info(fileType, "Document file type");

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

  assert(false, "ERROR: downloadFile called on context with missing file");
};
