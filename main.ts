import { DATA_DIR, LOCAL_FILES_DIR } from "@/bot/constants.js";
import { bot } from "@/bot/handler.js";
import logger from "@/bot/logger.js";
import { BROWSER } from "@/helpers/browser.js";
import { run } from "@grammyjs/runner";
import fs from "fs";

// Register exception handlers
process.on("uncaughtException", async (err) => {
  logger.fatal(err, "Uncaught Exception");

  // If a graceful shutdown is not achieved after 2 seconds,
  // shut down the process completely
  setTimeout(() => {
    process.abort(); // exit immediately and generate a core dump file
  }, 2000).unref();

  await BROWSER.close();
  logger.info("Browser closed");

  process.exit(1);
});

process.on("SIGTERM", async (err) => {
  logger.info(err, "Terminating...");

  await BROWSER.close();

  process.exit(1);
});

// Create working directories
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

if (!fs.existsSync(LOCAL_FILES_DIR)) {
  fs.mkdirSync(LOCAL_FILES_DIR);
}

const handle = run(bot);

await handle.task();

logger.info("Bot done processing!");

await handle.stop();
