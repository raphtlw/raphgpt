import { checkWalletJob, freeTierResetJob } from "bot/crontab";
import logger from "bot/logger";

export async function cleanup() {
  logger.info("Init cleanup...");

  freeTierResetJob.stop();
  checkWalletJob.stop();
}
