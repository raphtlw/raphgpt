import * as Bonfida from "@bonfida/spl-name-service";
import {
  clusterApiUrl,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { tool } from "ai";
import { createAgent } from "bot/agents";
import logger from "bot/logger";
import { inspect } from "bun";
import { format } from "date-fns";
import { z } from "zod";

/**
 * walletExplorerAgent: an agent that investigates Solana wallets and transactions.
 */
export const walletExplorerAgent = createAgent({
  name: "wallet_explorer_agent",
  description:
    "Explore the Solana blockchain, using wallet addresses or transaction signatures.",
  parameters: z.object({
    walletAddressOrSignature: z
      .string()
      .describe("Signature or address in base58 or .sol domain"),
    instruction: z
      .string()
      .describe(
        "Natural language instruction describing what you want from the address or signature",
      ),
  }),
  system: `You are a Solana blockchain investigator.
Current time in UTC: ${format(
    new Date(),
    "EEEE, yyyy-MM-dd 'at' HH:mm:ss zzz (XXX)",
  )}.
Always use get_sol_signatures before assuming there are no transactions associated with a specific wallet.`,
  createTools: (toolData) => ({
    resolve_sol_domain: tool({
      parameters: z.object({
        domain: z.string().describe("Bonfida domain ending in .sol"),
      }),
      async execute({ domain }) {
        const connection = new Connection(clusterApiUrl("mainnet-beta"));
        const owner = await Bonfida.resolve(connection, domain);
        return owner.toBase58();
      },
    }),

    get_account_info: tool({
      parameters: z.object({
        walletAddress: z.string(),
      }),
      async execute({ walletAddress }) {
        const connection = new Connection(clusterApiUrl("mainnet-beta"));
        return await connection.getAccountInfoAndContext(
          new PublicKey(walletAddress),
        );
      },
    }),

    get_sol_signatures: tool({
      description: "Get all signatures for wallet address",
      parameters: z.object({
        walletAddress: z.string(),
        limit: z.number().optional(),
      }),
      async execute({ walletAddress, limit }) {
        const connection = new Connection(clusterApiUrl("mainnet-beta"));
        const signatures = await connection.getSignaturesForAddress(
          new PublicKey(walletAddress),
          { limit },
        );

        logger.debug(signatures, "Confirmed signatures");

        const formatted: string[] = [];
        for (const sig of signatures) {
          const txDetails: string[] = [];

          txDetails.push(
            `timestamp: ${format(
              new Date(),
              "EEEE, yyyy-MM-dd 'at' HH:mm:ss zzz (XXX)",
            )}`,
          );
          txDetails.push(`sig: ${sig.signature}`);
          txDetails.push(`memo: ${sig.memo}`);
          txDetails.push(`error: ${inspect(sig.err)}`);

          formatted.push(txDetails.join(","));
        }

        return formatted.join("\n");
      },
    }),

    get_sol_tx: tool({
      description: "Get transaction by signature",
      parameters: z.object({ sig: z.string() }),
      async execute({ sig }) {
        const connection = new Connection(clusterApiUrl("mainnet-beta"));
        const transaction = await connection.getParsedTransaction(sig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (!transaction) throw new Error("Transaction not found");

        const formatted: string[] = [];
        const txDetails: string[] = [];

        txDetails.push(
          `timestamp: ${format(
            new Date(),
            "EEEE, yyyy-MM-dd 'at' HH:mm:ss zzz (XXX)",
          )}`,
        );
        txDetails.push(`data: ${inspect(transaction.meta)}`);

        formatted.push(txDetails.join(","));

        return formatted.join("\n");
      },
    }),

    lamports_to_sol: tool({
      description: "Calculate lamports to sol",
      parameters: z.object({ lamports: z.number() }),
      async execute({ lamports }) {
        return lamports / LAMPORTS_PER_SOL;
      },
    }),
  }),
});
