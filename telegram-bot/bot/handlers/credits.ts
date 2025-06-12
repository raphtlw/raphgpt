import { b, code, fmt } from "@grammyjs/parse-mode";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { BotContext } from "bot";
import { retrieveUser } from "bot/helpers";
import logger from "bot/logger";
import { telegram } from "bot/telegram";
import { inspect } from "bun";
import {
  handleUserWalletBalanceChange,
  solanaConnection,
} from "connections/solana";
import { db, tables } from "db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Composer, InlineKeyboard } from "grammy";
import { getEnv } from "utils/env";

export const creditsHandler = new Composer<BotContext>();

const dollars = (cents: number) => {
  return cents / Math.pow(10, 2);
};

const cents = (dollars: number) => {
  return dollars * Math.pow(10, 2);
};

const calculateStripeFee = (cents: number) => {
  return (cents / 100) * 3.4 + 50;
};

const sendBuyCreditsInvoice = async (ctx: BotContext, amount: number) => {
  if (amount < 100) {
    return await ctx.reply("Min. Amount is $1.");
  }

  const cost = Math.trunc(amount + calculateStripeFee(amount));

  await ctx.replyWithInvoice(
    "Buy Credits (USD)",
    "Get more messages and tokens from OpenAI.",
    `${amount}`,
    "USD",
    [
      {
        amount: cost,
        label: `Add ${dollars(amount)} worth of tokens`,
      },
    ],
    {
      provider_token: getEnv("TELEGRAM_PAYMENT_STRIPE"),
      start_parameter: "",
      photo_url:
        "https://storage.googleapis.com/raphgpt-static/duck-token.jpeg",
    },
  );
};

creditsHandler.command("balance", async (ctx) => {
  let readUserId = ctx.from?.id;
  if (ctx.match.length > 0) {
    readUserId = parseInt(ctx.match);
  }
  if (!readUserId) return await ctx.reply("User ID not specified");

  const user = await db.query.users.findFirst({
    where: eq(tables.users.userId, readUserId),
  });

  if (!user) return await ctx.reply("User not found");

  const balanceMessage = fmt`
User ID: ${b}${user.id}${b}
Balance: ${b}${dollars(user.credits)}${b}`;

  await ctx.reply(balanceMessage.text, { entities: balanceMessage.entities });
});

creditsHandler.command("topup", async (ctx) => {
  const cmd = ctx.msg.text.split(" ");
  let amountDollars: number | null = null;
  if (cmd[1]) {
    amountDollars = parseFloat(cmd[1]);
  }

  await ctx.reply("Choose a payment method", {
    reply_markup: new InlineKeyboard()
      .text("Solana", "payment-method-solana")
      .text("Stripe (3.4% + S$0.50 fees)", "payment-method-stripe"),
  });

  ctx.session.topupAmountDollars = amountDollars;
});

creditsHandler.callbackQuery("payment-method-solana", async (ctx) => {
  // Create user if they don't exist till now
  let user = await retrieveUser(ctx);

  // Check if user has existing wallet
  let wallet: typeof tables.solanaWallets.$inferSelect | undefined;
  if (user.solanaWallet) {
    wallet = await db
      .select()
      .from(tables.solanaWallets)
      .where(eq(tables.solanaWallets.id, user.solanaWallet))
      .get();
  } else {
    // Create wallet and attach it to the user record
    const keypair = new Keypair();
    wallet = await db
      .insert(tables.solanaWallets)
      .values({
        owner: user.id,
        secretKey: keypair.secretKey.toString(),
        publicKey: keypair.publicKey.toBase58(),
        balanceLamports: await solanaConnection.getBalance(keypair.publicKey),
      })
      .returning()
      .get();
    user = await db
      .update(tables.users)
      .set({ solanaWallet: wallet.id })
      .where(eq(tables.users.id, user.id))
      .returning()
      .get();
  }
  if (!wallet) throw new Error("Wallet not found");

  // Notify user of current SOL price
  // await telegram.sendMessage(ctx.chatId!, `SOL current price is ${averagePrice} USD`)
  const topupNotification = fmt`The amount you send to this address will be used to top up your wallet: ${code}${wallet.publicKey}${code}`;
  await ctx.reply(topupNotification.text, {
    entities: topupNotification.entities,
  });
  solanaConnection.onAccountChange(
    new PublicKey(wallet.publicKey),
    async (updatedAccountInfo) => {
      logger.debug(
        `Received solana account info: ${inspect(updatedAccountInfo)}`,
      );

      if (!wallet) throw new Error("Failed to retrieve wallet");

      const user = await db.query.users.findFirst({
        where: and(
          eq(tables.users.userId, ctx.from.id),
          isNotNull(tables.users.solanaWallet),
        ),
        with: {
          solanaWallet: true,
        },
      });
      await handleUserWalletBalanceChange(user as any);
    },
  );
  await ctx.reply("Listening for incoming transactions...");
});

creditsHandler.callbackQuery("payment-method-stripe", async (ctx) => {
  const amountDollars = ctx.session.topupAmountDollars;
  if (!amountDollars) throw new Error("Failed to retrieve payload");

  if (amountDollars) {
    await sendBuyCreditsInvoice(ctx, cents(amountDollars));
  } else {
    const buildSelection = (amount: number) =>
      InlineKeyboard.text(
        `${amount} ($${dollars(
          Math.trunc(amount + calculateStripeFee(amount)),
        )})`,
        `deposit-amount-${amount}`,
      );
    return await ctx.reply(
      [
        "Payments are securely powered by Stripe.",
        "Please select the number of tokens you wish to purchase, or send a custom number (>100).",
      ].join("\n"),
      {
        reply_markup: new InlineKeyboard()
          .row(buildSelection(100), buildSelection(150))
          .row(buildSelection(200), buildSelection(300))
          .row(InlineKeyboard.text("Cancel ❌", "cancel")),
      },
    );
  }
});

creditsHandler.callbackQuery(/deposit-amount-(\d+)/, async (ctx) => {
  logger.debug(`deposit-amount matched: ${ctx.match}`);

  if (!ctx.match[1]) throw new Error("No deposit amount found");

  await sendBuyCreditsInvoice(ctx, parseInt(ctx.match[1]));
});

creditsHandler.callbackQuery("cancel", async (ctx) => {
  if (ctx.chatId && ctx.callbackQuery.message?.message_id) {
    await telegram.deleteMessage(
      ctx.chatId,
      ctx.callbackQuery.message?.message_id,
    );
  }
});

// when a user has confirmed their payment and shipping details
creditsHandler.on("pre_checkout_query", async (ctx) => {
  // Remember that the user still needs to pay
  ctx.session.pendingPaymentInvoicePayload =
    ctx.preCheckoutQuery.invoice_payload;

  await ctx.answerPreCheckoutQuery(true);
});

creditsHandler.on("msg:successful_payment", async (ctx) => {
  if (!ctx.from) throw new Error("ctx.from not found");
  if (!ctx.session.pendingPaymentInvoicePayload)
    throw new Error("Pending payment invoice not found!");

  const user = await db
    .update(tables.users)
    .set({
      credits: sql`${tables.users.credits} + ${ctx.session.pendingPaymentInvoicePayload}`,
    })
    .where(eq(tables.users.userId, ctx.from.id))
    .returning()
    .get();

  await ctx.reply("Thanks for your purchase!");
  await telegram.sendMessage(
    ctx.chatId,
    `You have $${user.credits} in credits now`,
  );
});
