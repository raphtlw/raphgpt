import { CommandGroup } from "@grammyjs/commands";
import { createConversation } from "@grammyjs/conversations";
import { b, code, fmt, u } from "@grammyjs/parse-mode";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { BotContext } from "bot";
import { configSchema } from "bot/config";
import { activeRequests, handler } from "bot/handler";
import { retrieveUser } from "bot/helpers";
import logger from "bot/logger";
import { telegram } from "bot/telegram";
import { inspect, s3 } from "bun";
import { kv } from "connections/redis";
import {
  handleUserWalletBalanceChange,
  solanaConnection,
} from "connections/solana";
import { vectorStore } from "connections/vector";
import { db, tables } from "db";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import { getEnv } from "utils/env";
import { z } from "zod";

export const commands = new CommandGroup<BotContext>();

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

commands.command("start", "Start the bot", async (ctx) => {
  const user = await retrieveUser(ctx);

  await ctx.reply(
    `hey ${
      user.firstName ?? user.lastName
    }, what's up? You can send a text, photo, telebubble or a voice message.`,
  );
});

commands.command("balance", "Check account balance", async (ctx) => {
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

commands.command("clear", "Clear conversation history", async (ctx) => {
  if (!ctx.from) throw new Error("Could not get message sender");

  const userId = ctx.from.id;
  let chatId = ctx.chatId;

  if (ctx.match) {
    const args = ctx.match.trim();
    chatId = parseInt(args);
  }

  // Remove all pending requests
  await kv.DEL(`pending_requests:${ctx.chatId}:${userId}`);

  const parts = await db
    .select({
      region: tables.messageParts.region,
      bucket: tables.messageParts.bucket,
      key: tables.messageParts.key,
    })
    .from(tables.messageParts)
    .leftJoin(
      tables.messages,
      eq(tables.messageParts.messageId, tables.messages.id),
    )
    .where(
      and(
        eq(tables.messages.userId, userId),
        eq(tables.messages.chatId, chatId),
        inArray(tables.messageParts.type, ["image", "file"]),
      ),
    )
    .all();

  await Promise.all(
    parts.map(
      async ({
        region,
        bucket,
        key,
      }: {
        region: string | null;
        bucket: string | null;
        key: string | null;
      }) => {
        if (region && bucket && key) {
          try {
            await s3.file(key, { region, bucket }).delete();
          } catch (error) {
            logger.warn(
              `Failed to delete S3 file ${key} from ${bucket}/${region}: ${error}`,
            );
          }
        }
      },
    ),
  );

  const deleteResult = await db
    .delete(tables.messages)
    .where(
      and(
        eq(tables.messages.userId, userId),
        eq(tables.messages.chatId, chatId),
      ),
    );

  await ctx.reply(
    `All ${deleteResult.rowsAffected} messages cleared from short term memory.`,
  );

  const { deleted } = await vectorStore.delete({
    filter: `chatId = ${chatId}`,
  });

  await ctx.reply(
    `All ${deleted} conversation turns deleted from long term memory.`,
  );
});

commands.command("topup", "Get more tokens", async (ctx) => {
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

handler.callbackQuery("payment-method-solana", async (ctx) => {
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

  await kv.del(`callback_data:${ctx.callbackQuery.message?.message_id}`);
});

handler.callbackQuery("payment-method-stripe", async (ctx) => {
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

  await kv.del(`callback_data:${ctx.callbackQuery.message?.message_id}`);
});

handler.callbackQuery(/deposit-amount-(\d+)/, async (ctx) => {
  logger.debug(`deposit-amount matched: ${ctx.match}`);

  if (!ctx.match[1]) throw new Error("No deposit amount found");

  await sendBuyCreditsInvoice(ctx, parseInt(ctx.match[1]));
});

handler.callbackQuery("cancel", async (ctx) => {
  if (ctx.chatId && ctx.callbackQuery.message?.message_id) {
    await telegram.deleteMessage(
      ctx.chatId,
      ctx.callbackQuery.message?.message_id,
    );
  }
});

// when a user has confirmed their payment and shipping details
handler.on("pre_checkout_query", async (ctx) => {
  // Remember that the user still needs to pay
  ctx.session.pendingPaymentInvoicePayload =
    ctx.preCheckoutQuery.invoice_payload;

  await ctx.answerPreCheckoutQuery(true);
});

handler.on("msg:successful_payment", async (ctx) => {
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

  await kv.del(`pending_payment:${ctx.from.id}`);
});

commands.command("set", "Set basic settings", async (ctx) => {
  if (!ctx.from) throw new Error("ctx.from not found");
  const cmd = ctx.msg.text.split(" ");

  const key = cmd[1];
  const value = cmd[2];

  if (!key) {
    const settingsMessage = fmt`${u}${b}[HELP]${b}${u}
Available settings:
${(Object.keys(configSchema.shape) as Array<keyof typeof configSchema.shape>)
  .map((key) => `- ${key} - ${configSchema.shape[key].description}`)
  .join("\n")}
`;

    await ctx.reply(settingsMessage.text, {
      entities: settingsMessage.entities,
    });

    const specifyKeyMessage = fmt`Please specify key to set.
Available options:
${Object.keys(configSchema.shape).join(", ")}
`;

    return await ctx.reply(specifyKeyMessage.text, {
      entities: specifyKeyMessage.entities,
    });
  }

  if (!value) {
    return await ctx.reply("Please specify value.");
  }

  configSchema.partial().parse({ [key]: value });

  await kv.HSET(`config:${ctx.from.id}`, key, value);

  return await ctx.reply(`Successfully set ${key} to ${value}`);
});

commands.command("config", "Get basic settings", async (ctx) => {
  if (!ctx.from) throw new Error("ctx.from not found");

  const result = await kv.HGETALL(`config:${ctx.from.id}`);

  const settingsMessage = fmt`Settings ${code}${JSON.stringify(
    result,
    undefined,
    4,
  )}${code}`;
  await ctx.reply(settingsMessage.text, {
    entities: settingsMessage.entities,
    reply_parameters: {
      message_id: ctx.msgId,
      allow_sending_without_reply: true,
    },
  });
});

commands.command("personality", "View/Modify personality", async (ctx) => {
  if (!ctx.from) throw new Error("ctx.from not found");

  if (ctx.from.id !== getEnv("TELEGRAM_BOT_OWNER", z.coerce.number())) {
    await ctx.reply("Cannot use this command!");
    return;
  }

  const personality = await db.query.personality.findMany({
    columns: {
      id: true,
      content: true,
    },
  });

  const inlineKeyboard = new InlineKeyboard()
    .text("<< 1", "personality-start")
    .text("< 1", "personality-1")
    .text("1", "personality-1")
    .text("2 >", "personality-2")
    .text(`${personality.length} >>`, "personality-end")
    .row()
    .text("➕ Add", "personality-add")
    .text("🗑️ Remove", "personality-remove");
  if (personality.length > 0 && personality[0]) {
    await ctx.reply(personality[0].content, {
      reply_markup: inlineKeyboard,
    });
  } else {
    await ctx.reply("No personality data found.", {
      reply_markup: inlineKeyboard,
    });
  }
});

const personalityMenu = async (ctx: BotContext, page: number) => {
  const personality = await db.query.personality.findMany({
    columns: {
      id: true,
      content: true,
    },
  });

  if (page > personality.length) {
    await ctx.answerCallbackQuery("You have reached the end of the list");
    return;
  }

  if (page < 1) {
    await ctx.answerCallbackQuery("Unable to go backwards even further");
    return;
  }

  const inlineKeyboard = new InlineKeyboard()
    .text("<< 1", "personality-start")
    .text(`< ${page - 1}`, `personality-${page - 1}`)
    .text(`${page}`, `personality-${page}`)
    .text(`${page + 1} >`, `personality-${page + 1}`)
    .text(`${personality.length} >>`, "personality-end")
    .row()
    .text("➕ Add", "personality-add")
    .text("🗑️ Remove", `personality-remove-${page}`);

  if (personality.length > 0 && personality[page - 1]) {
    await ctx.answerCallbackQuery();
    await ctx.reply(personality[page - 1]!.content, {
      reply_markup: inlineKeyboard,
    });
  } else {
    await ctx.answerCallbackQuery();
    await ctx.reply("No personality data found.", {
      reply_markup: inlineKeyboard,
    });
  }
};

handler.callbackQuery(/personality-(\d+)/, async (ctx) => {
  logger.debug(`Personality: ${ctx.match}`);

  if (!ctx.match[1]) throw new Error("Personality index not matched");

  const personalityPage = parseInt(ctx.match[1]);
  await personalityMenu(ctx, personalityPage);
});

handler.callbackQuery(/personality-(start|end)/, async (ctx) => {
  logger.debug(`Personality: ${ctx.match}`);

  const personality = await db.query.personality.findMany({
    columns: {
      id: true,
      content: true,
    },
  });

  if (ctx.match[1] === "start") {
    await personalityMenu(ctx, 1);
  }

  if (ctx.match[1] === "end") {
    await personalityMenu(ctx, personality.length);
  }
});

handler.use(
  createConversation(async (conversation, ctx) => {
    if (!ctx.from) throw new Error("ctx.from not found");

    await ctx.reply(
      "Send the content you wish to add to the bot's personality",
    );
    const { message } = await conversation.waitFor("message:text");
    await db.insert(tables.personality).values({
      userId: ctx.from.id,
      content: message.text,
    });

    await ctx.reply("Personality added!");
  }, "personality-add"),
);

handler.callbackQuery(/personality-add/, async (ctx) => {
  logger.debug(`Personality: ${ctx.match}`);

  await ctx.conversation.enter("personality-add");
});

handler.callbackQuery(/personality-remove-(\d+)/, async (ctx) => {
  logger.debug(`Personality: ${ctx.match}`);

  if (!ctx.match[1]) throw new Error("Personality index not matched");

  const personalityPage = parseInt(ctx.match[1]);
  const personality = await db.query.personality.findMany({
    columns: {
      id: true,
      content: true,
    },
  });

  const result = await db
    .delete(tables.personality)
    .where(eq(tables.personality.id, personality[personalityPage - 1]!.id));

  await ctx.reply(`Deleted ${result.rowsAffected} personality record`);
});

commands.command(
  "cancel",
  "If the previous message was a mistake, you can cancel the request",
  async (ctx) => {
    logger.debug("Cancellation requested");

    if (!ctx.from) throw new Error("ctx.from not found");
    const userId = ctx.from.id;

    if (activeRequests.has(userId)) {
      activeRequests.get(userId)?.abort();
      activeRequests.delete(userId);
    }

    // Remove all pending requests
    await kv.DEL(`pending_requests:${ctx.chatId}:${userId}`);

    await ctx.reply("Stopped thinking");
  },
);
