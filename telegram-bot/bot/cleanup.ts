import { checkWalletJob, freeTierResetJob } from "bot/crontab";

export async function cleanup() {
  console.log("Init cleanup...");

  freeTierResetJob.stop();
  checkWalletJob.stop();
}
