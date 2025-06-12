import logger from "bot/logger";
import { inspect } from "bun";
import { handleUserWalletBalanceChange } from "connections/solana";
import { CronJob } from "cron";
import { db, tables } from "db";
import { isNotNull } from "drizzle-orm";

// Reset free tier message counts
export const freeTierResetJob = new CronJob("0 0 * * *", async () => {
  const result = await db.update(tables.users).set({
    freeTierMessageCount: 0,
  });
  logger.info(`Reset free tier message quota: ${inspect(result)}`);
});

// Handle wallet balance changes
export const checkWalletJob = new CronJob("* * * * *", async () => {
  const users = await db.query.users.findMany({
    where: isNotNull(tables.users.solanaWallet),
    with: {
      solanaWallet: true,
    },
  });

  for (const user of users) {
    if (!user.solanaWallet) throw new Error("User has no wallet");
    await handleUserWalletBalanceChange(user as any);
  }
});
