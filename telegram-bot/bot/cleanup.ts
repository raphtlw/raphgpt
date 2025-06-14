import { TEMP_DIR } from "bot/constants";
import { checkWalletJob, freeTierResetJob } from "bot/crontab";
import { clearAllRunningChatActions } from "bot/running-tasks";
import fs from "node:fs/promises";

export async function cleanup() {
  console.log("Init cleanup...");

  clearAllRunningChatActions();

  await freeTierResetJob.stop();
  await checkWalletJob.stop();
  await fs.rm(TEMP_DIR, { recursive: true, force: true });
}
