import { run } from "@grammyjs/runner";
import { bot } from "bot";
import { cleanup } from "bot/cleanup";
import { DATA_DIR, TEMP_DIR } from "bot/constants";
import { checkWalletJob, freeTierResetJob } from "bot/crontab";
import logger from "bot/logger";
import fs from "fs";

// Register exception handlers
process.on("uncaughtException", async (err) => {
  logger.fatal(err, "Uncaught Exception");

  // If a graceful shutdown is not achieved after 2 seconds,
  // shut down the process completely
  setTimeout(() => {
    process.abort(); // exit immediately and generate a core dump file
  }, 2000).unref();

  await cleanup();

  process.exit(1);
});

process.on("SIGTERM", async (err) => {
  logger.info(err, "Terminating...");

  await cleanup();

  process.exit(1);
});

// Create working directories
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Run cron jobs
freeTierResetJob.start();
checkWalletJob.start();

// Start telegram bot
const handle = run(bot);
await handle.task();

logger.info("Bot done processing!");

await handle.stop();

await cleanup();
