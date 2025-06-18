import { b, fmt } from "@grammyjs/parse-mode";
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { telegram } from "bot/telegram";
import { db, tables } from "db";
import { eq, sql } from "drizzle-orm";
import { inspect } from "util";
import { getEnv } from "utils/env";

export const solanaConnection = new Connection(getEnv("SOLANA_RPC_URL"), {
  wsEndpoint: getEnv("SOLANA_WEBSOCKET_URL"),
});

export const raydium = await Raydium.load({
  connection: solanaConnection,
});

export const getUSDCPrice = async () => {
  // Calculate Solana <=> USDC price
  const availablePools = await raydium.api.fetchPoolByMints({
    mint1: "So11111111111111111111111111111111111111112",
    mint2: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  });
  const approvedPools = availablePools.data.filter((pool) => pool.tvl > 10_000);
  let allPoolsCombinedPrice = 0;
  for (const pool of approvedPools) {
    allPoolsCombinedPrice += pool.price;
  }
  const averagePrice = allPoolsCombinedPrice / approvedPools.length;

  return averagePrice;
};

export const handleUserWalletBalanceChange = async (
  user: typeof tables.users.$inferSelect & {
    solanaWallet: typeof tables.solanaWallets.$inferSelect;
  },
) => {
  // Check for dust
  const tokenAccountResponse =
    await solanaConnection.getParsedTokenAccountsByOwner(
      new PublicKey(user.solanaWallet.publicKey),
      {
        programId: TOKEN_PROGRAM_ID,
      },
    );
  console.log(
    `Found ${tokenAccountResponse.value.length} tokens in wallet: ${inspect(
      tokenAccountResponse,
    )}`,
  );
  for (const token of tokenAccountResponse.value) {
    if (token.account) {
      const parsedAccountInfo = token.account.data;
      const mintAddress = parsedAccountInfo.parsed.info.mint;
      const tokenBalance = parsedAccountInfo.parsed.info.tokenAmount.uiAmount;

      console.log(`Token account: ${token.pubkey.toString()}`);
      console.log(`Mint address: ${mintAddress}`);
      console.log(`Balance: ${tokenBalance}`);
    }
  }

  const balance = await solanaConnection.getBalance(
    new PublicKey(user.solanaWallet.publicKey),
  );
  if (balance > user.solanaWallet.balanceLamports) {
    const receivedSol =
      (balance - user.solanaWallet.balanceLamports) / LAMPORTS_PER_SOL;
    const usdcPrice = await getUSDCPrice();
    const message = fmt`Received ${b}${receivedSol}${b} SOL ($${
      receivedSol * usdcPrice
    } USD).`;
    await telegram.sendMessage(user.chatId, message.text, {
      entities: message.entities,
    });

    await db
      .update(tables.users)
      .set({
        credits: sql`${tables.users.credits} + ${receivedSol * usdcPrice}`,
      })
      .where(eq(tables.users.id, user.id))
      .returning()
      .get();
    await db
      .update(tables.solanaWallets)
      .set({
        balanceLamports: balance,
      })
      .where(eq(tables.solanaWallets.owner, user.id))
      .returning()
      .get();
  }
};
