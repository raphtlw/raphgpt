import { bot, BotContext } from "@/bot/bot.js";
import { configSchema, getConfigValue } from "@/bot/config.js";
import {
  DATA_DIR,
  LOCAL_FILES_DIR,
  WHISPER_LANGUAGES,
} from "@/bot/constants.js";
import logger from "@/bot/logger.js";
import { downloadFile, telegram } from "@/bot/telegram.js";
import { chroma } from "@/db/chroma.js";
import { db, tables } from "@/db/db.js";
import { mainFunctions } from "@/functions/main.js";
import { toolbox } from "@/functions/toolbox";
import { getEnv } from "@/helpers/env.js";
import { ToolData } from "@/helpers/function";
import { generateAudio, GenerateTextParams } from "@/helpers/openai";
import { buildPrompt } from "@/helpers/prompts";
import { callPython } from "@/helpers/python";
import { runModel } from "@/helpers/replicate";
import { runCommand } from "@/helpers/shell";
import {
  handleUserWalletBalanceChange,
  solanaConnection,
} from "@/helpers/solana.js";
import { superjson } from "@/helpers/superjson.js";
import { kv } from "@/kv/redis.js";
import { openai } from "@ai-sdk/openai";
import { CommandGroup } from "@grammyjs/commands";
import { createConversation } from "@grammyjs/conversations";
import { b, code, fmt, i, underline } from "@grammyjs/parse-mode";
import { createId } from "@paralleldrive/cuid2";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  CoreMessage,
  FilePart,
  generateText,
  ImagePart,
  LanguageModelUsage,
  streamText,
  TextPart,
  ToolCallPart,
  ToolContent,
  UserContent,
} from "ai";
import assert from "assert";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { fileTypeFromBuffer } from "file-type";
import FormData from "form-data";
import fs from "fs";
import { globby } from "globby";
import got from "got";
import { InlineKeyboard, InputFile } from "grammy";
import path from "path";
import pdf2pic from "pdf2pic";
import sharp from "sharp";
import telegramifyMarkdown from "telegramify-markdown";
import TGS from "tgs-to";
import { inspect } from "util";
import { z } from "zod";

const commands = new CommandGroup<BotContext>();

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

const deductCredits = async (ctx: BotContext, usage: LanguageModelUsage) => {
  assert(ctx.from);

  let cost = 0;

  cost += usage.promptTokens * (2.5 / 1_000_000);
  cost += usage.completionTokens * (10 / 1_000_000);

  // 50% will be taken as fees
  cost += (cost / 100) * 50;

  cost *= Math.pow(10, 2); // Store value without 2 d.p.

  // Subtract credits from user
  await db
    .update(tables.users)
    .set({
      credits: sql`${tables.users.credits} - ${cost}`,
    })
    .where(eq(tables.users.userId, ctx.from.id));

  logger.debug({ cost }, "Deducted credits");
};

const retrieveUser = async (ctx: BotContext) => {
  assert(ctx.from, "Tried to retrieve user when no message sender exists!");
  assert(ctx.chatId, "No chat ID found!");

  let user = await db.query.users.findFirst({
    where: eq(tables.users.userId, ctx.from.id),
  });
  if (!user) {
    user = await db
      .insert(tables.users)
      .values({
        chatId: ctx.chatId,
        userId: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      })
      .returning()
      .get();
    const welcomeNotification = fmt`${b}Welcome to raphGPT.${b}
You get ${b}${getEnv("FREE_TIER_MESSAGE_DAILY_THRESHOLD")}${b} messages per day, resets at 00:00 daily.
${i}You can get more tokens from the store (/topup)${i}`;
    await ctx.reply(welcomeNotification.text, {
      entities: welcomeNotification.entities,
    });
  } else {
    user = await db
      .update(tables.users)
      .set({
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      })
      .where(eq(tables.users.userId, ctx.from.id))
      .returning()
      .get();
  }

  assert(user, "Unable to retrieve user");

  return user;
};

if (getEnv("NODE_ENV") === "production") {
  try {
    await telegram.setMyDescription(
      "The best AI companion on Telegram! This started as a personal project to create a bot that can do things for me. It can listen to voice messages and watch video messages.",
      {
        language_code: "en",
      },
    );
    await telegram.setMyShortDescription(
      "Powered by OpenAI. Any inquiries @raphtlw",
      {
        language_code: "en",
      },
    );
  } catch {
    logger.error(
      "Encountered an error setting the bot's description, but it's okay.",
    );
  }
}

commands
  .command("start", "Start the bot")
  .addToScope({ type: "default" }, async (ctx) => {
    const user = await retrieveUser(ctx);

    await ctx.reply(
      `hey ${user.firstName ?? user.lastName}, what's up? You can send a text, photo, telebubble or a voice message.`,
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
  assert(ctx.from, "Could not get message sender");
  const userId = ctx.from.id;
  let chatId = ctx.chatId;

  if (ctx.match) {
    const args = ctx.match.trim();
    chatId = parseInt(args);
  }

  const scount = await kv.LLEN(`message_turns:${chatId}:${userId}`);

  await kv.del(`message_turns:${chatId}:${userId}`);
  await ctx.reply(`All ${scount} messages cleared from short term memory.`);

  const collection = await chroma.getOrCreateCollection({
    name: "message_history",
  });
  const lcount = await collection.count();
  await collection.delete({
    where: {
      chatId: ctx.chatId,
    },
  });
  await ctx.reply(`All ${lcount} messages cleared from long term memory.`);
});

commands.command("topup", "Get more tokens", async (ctx) => {
  const cmd = ctx.msg.text.split(" ");
  let amountDollars: number | null = null;
  if (cmd.length > 1) {
    amountDollars = parseFloat(cmd[1]);
  }

  const msg = await ctx.reply("Choose a payment method", {
    reply_markup: new InlineKeyboard()
      .text("Solana", "payment-method-solana")
      .text("Stripe (3.4% + S$0.50 fees)", "payment-method-stripe"),
  });

  await kv.set(
    `callback_data:${msg.message_id}`,
    superjson.stringify({
      amountDollars,
    } as PaymentMethodData),
  );
});

type PaymentMethodData = {
  amountDollars: number;
};

bot.callbackQuery("payment-method-solana", async (ctx) => {
  // Create user if they don't exist till now
  let user = await retrieveUser(ctx);
  assert(user, "Unable to retrieve user");

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
  assert(wallet, "Failed to retrieve wallet");

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

      assert(wallet, "Failed to retrieve wallet");

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

bot.callbackQuery("payment-method-stripe", async (ctx) => {
  const cachedPayload = await kv.get(
    `callback_data:${ctx.callbackQuery.message?.message_id}`,
  );
  assert(cachedPayload, "Failed to retrieve payload");
  const data = superjson.parse<PaymentMethodData>(cachedPayload);

  if (data.amountDollars) {
    await sendBuyCreditsInvoice(ctx, cents(data.amountDollars));
  } else {
    const buildSelection = (amount: number) =>
      InlineKeyboard.text(
        `${amount} ($${dollars(Math.trunc(amount + calculateStripeFee(amount)))})`,
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

bot.callbackQuery(/deposit-amount-(\d+)/, async (ctx) => {
  logger.debug(`deposit-amount matched: ${ctx.match}`);

  await sendBuyCreditsInvoice(ctx, parseInt(ctx.match[1]));
});

bot.callbackQuery("cancel", async (ctx) => {
  if (ctx.chatId && ctx.callbackQuery.message?.message_id) {
    await telegram.deleteMessage(
      ctx.chatId,
      ctx.callbackQuery.message?.message_id,
    );
  }
});

// when a user has confirmed their payment and shipping details
bot.on("pre_checkout_query", async (ctx) => {
  // Remember that the user still needs to pay
  await kv.set(
    `pending_payment:${ctx.from.id}`,
    ctx.preCheckoutQuery.invoice_payload,
  );

  await ctx.answerPreCheckoutQuery(true);
});

bot.on("msg:successful_payment", async (ctx) => {
  assert(ctx.from);

  const pendingPayment = await kv.get(`pending_payment:${ctx.from.id}`);
  assert(pendingPayment);

  const user = await db
    .update(tables.users)
    .set({
      credits: sql`${tables.users.credits} + ${pendingPayment}`,
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
  assert(ctx.from);
  const cmd = ctx.msg.text.split(" ");

  const key = cmd[1];
  const value = cmd[2];

  if (!key) {
    const settingsMessage = fmt`${underline}${b}[HELP]${b}${underline}
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
  assert(ctx.from);

  const result = await kv.HGETALL(`config:${ctx.from.id}`);

  const settingsMessage = fmt`Settings ${code}${JSON.stringify(result, undefined, 4)}${code}`;
  await ctx.reply(settingsMessage.text, {
    entities: settingsMessage.entities,
    reply_parameters: {
      message_id: ctx.msgId,
      allow_sending_without_reply: true,
    },
  });
});

commands.command("personality", "View/Modify personality").addToScope(
  {
    type: "chat",
    chat_id: getEnv("TELEGRAM_BOT_OWNER", z.coerce.number()),
  },
  async (ctx) => {
    assert(ctx.from);

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
    if (personality.length > 0) {
      await ctx.reply(personality[0].content, {
        reply_markup: inlineKeyboard,
      });
    } else {
      await ctx.reply("No personality data found.", {
        reply_markup: inlineKeyboard,
      });
    }
  },
);

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

  if (personality.length > 0) {
    await ctx.answerCallbackQuery();
    await ctx.reply(personality[page - 1].content, {
      reply_markup: inlineKeyboard,
    });
  } else {
    await ctx.answerCallbackQuery();
    await ctx.reply("No personality data found.", {
      reply_markup: inlineKeyboard,
    });
  }
};

bot.callbackQuery(/personality-(\d+)/, async (ctx) => {
  logger.debug(`Personality: ${ctx.match}`);

  const personalityPage = parseInt(ctx.match[1]);
  await personalityMenu(ctx, personalityPage);
});

bot.callbackQuery(/personality-(start|end)/, async (ctx) => {
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

bot.use(
  createConversation(async (conversation, ctx) => {
    assert(ctx.from);

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

bot.callbackQuery(/personality-add/, async (ctx) => {
  logger.debug(`Personality: ${ctx.match}`);

  await ctx.conversation.enter("personality-add");
});

bot.callbackQuery(/personality-remove-(\d+)/, async (ctx) => {
  logger.debug(`Personality: ${ctx.match}`);

  const personalityPage = parseInt(ctx.match[1]);
  const personality = await db.query.personality.findMany({
    columns: {
      id: true,
      content: true,
    },
  });

  const result = await db
    .delete(tables.personality)
    .where(eq(tables.personality.id, personality[personalityPage - 1].id));

  await ctx.reply(`Deleted ${result.rowsAffected} personality record`);
});

commands.command(
  "cancel",
  "If the previous message was a mistake, you can cancel the request",
  async (ctx) => {
    logger.debug("Cancellation requested");

    assert(ctx.from);
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

bot.use(commands);

export const activeRequests = new Map<number, AbortController>();

bot.on(["message", "edit:text"]).filter(
  async (ctx) => {
    assert(ctx.msg.from);

    if (ctx.hasChatType("private")) {
      return true;
    }
    if (
      ctx.msg.from.id === getEnv("TELEGRAM_BOT_OWNER", z.coerce.number()) &&
      ctx.msg.text?.startsWith("-bot ")
    ) {
      return true;
    }
    return false;
  },
  async (ctx) => {
    assert(ctx.from);
    const userId = ctx.from.id;

    // Cancel the previous request if it exists
    if (activeRequests.has(userId)) {
      activeRequests.get(userId)?.abort();
      activeRequests.delete(userId);
      const interruptionNotification = fmt`${i}⏹️ Previous response interrupted. Processing new request...${i}`;
      await ctx.reply(interruptionNotification.text, {
        entities: interruptionNotification.entities,
      });
    }

    if (ctx.editedMessage) {
      const editedMessageNotification = fmt`${i}Noticed you edited a message. Revisiting it...${i}`;
      await ctx.reply(editedMessageNotification.text, {
        entities: editedMessageNotification.entities,
      });
    }

    const controller = new AbortController();
    activeRequests.set(userId, controller);

    await ctx.chatAction.enable(true);

    const user = await retrieveUser(ctx);

    // Check if user has enough free messages
    // Check if user has enough credits
    // Excluding TELEGRAM_BOT_OWNER
    const userExceedsFreeMessages =
      user.freeTierMessageCount >
      getEnv("FREE_TIER_MESSAGE_DAILY_THRESHOLD", z.coerce.number());
    const userIsOwner =
      user.userId === getEnv("TELEGRAM_BOT_OWNER", z.coerce.number());
    if (userExceedsFreeMessages && user.credits <= 0 && !userIsOwner) {
      return await ctx.reply(
        "You have run out of credits! Use /topup to get more.",
      );
    }

    if (ctx.msg.text?.startsWith("-bot ")) {
      ctx.msg.text = ctx.msg.text.replace("-bot ", "");
    }

    const toSend: UserContent = [];
    const remindingSystemPrompt: string[] = [];

    const transcribeAudio = async () => {
      if (ctx.msg.video_note || ctx.msg.video) {
        assert(ctx.from);
        const file = await downloadFile(ctx);
        const inputFileId = createId();
        const audioFilePath = path.join(DATA_DIR, `input-${inputFileId}.mp3`);
        await runCommand(`ffmpeg -i ${file.localPath} ${audioFilePath}`);

        logger.debug(`ffmpeg generated audio file: ${audioFilePath}`);

        const result = await runModel(
          "vaibhavs10/incredibly-fast-whisper:3ab86df6c8f54c11309d4d1f930ac292bad43ace52d10c80d87eb258b3c9f79c",
          z.object({
            task: z
              .enum(["transcribe", "translate"])
              .describe(
                "Task to perform: transcribe or translate to another language.",
              )
              .default("transcribe"),
            audio: z.any(),
            hf_token: z
              .string()
              .describe(
                "Provide a hf.co/settings/token for Pyannote.audio to diarise the audio clips. You need to agree to the terms in 'https://huggingface.co/pyannote/speaker-diarization-3.1' and 'https://huggingface.co/pyannote/segmentation-3.0' first.",
              )
              .optional(),
            language: z
              .enum(WHISPER_LANGUAGES)
              .describe(
                "Language spoken in the audio, specify 'None' to perform language detection.",
              )
              .default("None"),
            timestamp: z
              .enum(["chunk", "word"])
              .describe(
                "Whisper supports both chunked as well as word level timestamps.",
              )
              .default("chunk"),
            batch_size: z
              .number()
              .int()
              .describe(
                "Number of parallel batches you want to compute. Reduce if you face OOMs.",
              )
              .default(24),
            diarise_audio: z
              .boolean()
              .describe(
                "Use Pyannote.audio to diarise the audio clips. You will need to provide hf_token below too.",
              )
              .default(false),
          }),
          z.object({
            text: z.string(),
            chunks: z.array(
              z.object({
                text: z.string(),
                timestamp: z.tuple([z.number(), z.number()]), // Ensures exactly two numbers in the array
              }),
            ),
          }),
          {
            audio: await fs.promises.readFile(audioFilePath!),
            task: "transcribe",
            timestamp: "chunk",
            batch_size: 48,
            diarise_audio: false,
            language: await getConfigValue(ctx.from.id, "language"),
          },
        );
        logger.debug(result, "Transcription");
        return result;
      }
      assert(
        false,
        "Cannot call this function when there is no audio to transcribe",
      );
    };

    if (ctx.msg.text) {
      toSend.push({ type: "text", text: ctx.msg.text });
    }
    if (ctx.msg.voice) {
      ctx.chatAction.kind = "record_voice";

      const file = await downloadFile(ctx);
      const inputFileId = createId();
      const audioFilePath = path.join(DATA_DIR, `input-${inputFileId}.mp3`);
      await runCommand(`ffmpeg -i ${file.localPath} ${audioFilePath}`);

      toSend.push({
        type: "file",
        mimeType: "audio/mpeg",
        data: await fs.promises.readFile(audioFilePath),
      });
    }
    if (ctx.msg.video_note || ctx.msg.video) {
      const file = await downloadFile(ctx);

      const transcribe = transcribeAudio();
      const selectFrames = callPython("processVideo", {
        file_path: file.localPath,
        lang: "en",
      });

      const [transcription, frames] = await Promise.all([
        transcribe,
        selectFrames,
      ]);

      remindingSystemPrompt.push(
        "You have been given periodic frames from a video. Frames with the least amount of blur were extracted.",
        "When responding, pretend you have watched a video.",
        "To avoid confusing the user, do not say they are images.",
      );
      for (const result of frames) {
        toSend.push({
          type: "image",
          image: await fs.promises.readFile(result.frame.path),
        });
      }
      toSend.push({ type: "text", text: transcription.text });
    }
    if (ctx.msg.photo) {
      const file = await downloadFile(ctx);
      const image = await sharp(file.localPath)
        .jpeg({ mozjpeg: true })
        .toBuffer();

      const { text, usage } = await generateText({
        model: openai("gpt-4o"),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: ctx.msg.caption
                  ? `Describe what's in this photo, most accurately as context for another llm to answer the user's request "${ctx.msg.caption}"`
                  : `What's in this photo?`,
              },
              {
                type: "image",
                image: image,
              },
            ],
          },
        ],
      });
      if (userExceedsFreeMessages && !userIsOwner) {
        await deductCredits(ctx, usage);
      }

      toSend.push({
        type: "text",
        text: `Image contents: ${text}`,
      });
    }
    if (ctx.msg.document) {
      const file = await downloadFile(ctx);
      if (file.fileType) {
        if (file.fileType.ext === "pdf") {
          toSend.push({
            type: "text",
            text: "PDF file contents",
          });

          const pdfPages = await pdf2pic.fromPath(file.localPath).bulk(-1, {
            responseType: "buffer",
          });

          for (const page of pdfPages) {
            toSend.push({
              type: "image",
              image: page.buffer!,
            });
          }
        }
        if (file.fileType.ext === "docx") {
          toSend.push({
            type: "text",
            text: `DOCX file contents`,
          });

          const form = new FormData();
          form.append("files", fs.createReadStream(file.localPath));

          const converted = await got
            .post(`${getEnv("GOTENBERG_URL")}/forms/libreoffice/convert`, {
              body: form,
              headers: {},
            })
            .buffer();
          const pdfPages = await pdf2pic.fromBuffer(converted).bulk(-1, {
            responseType: "buffer",
          });

          for (const page of pdfPages) {
            const resized = await sharp(page.buffer)
              .resize({
                fit: "contain",
                width: 512,
              })
              .toBuffer();
            toSend.push({
              type: "image",
              image: resized,
            });
          }
        }
        if (file.fileType.ext === "jpg") {
          toSend.push({
            type: "image",
            image: file.remoteUrl,
          });
        }
        if (file.fileType.ext === "zip") {
          // unzip the file
          const contentDir = await fs.promises.mkdtemp(
            path.join(LOCAL_FILES_DIR, "zip-"),
          );

          await ctx.reply("Unzipping...", {
            reply_parameters: {
              message_id: ctx.msgId,
              allow_sending_without_reply: true,
            },
          });

          await runCommand(`unzip ${file.localPath}`, {
            cwd: contentDir,
          });

          const filePaths = await globby("**", {
            absolute: true,
            ignore: [
              "__MACOSX",
              ".DS_Store",
              ".idea",
              ".gradle",
              ".plugin_symlinks",
              "windows/runner",
              "macos/runner",
              "node_modules",
              "dart_project",
            ].map((p) => `**/${p}/**`),
            expandDirectories: true,
            onlyFiles: true,
            dot: true,
            cwd: contentDir,
          });

          logger.info(filePaths, "Unzipped files");

          const textFilePaths = [];

          for (const filePath of filePaths) {
            const binaryType = await fileTypeFromBuffer(
              await fs.promises.readFile(filePath),
            );
            if (!binaryType) {
              textFilePaths.push(filePath);
            }
          }

          const localFiles = await db
            .insert(tables.localFiles)
            .values(
              textFilePaths.map((p) => ({
                path: p,
                content: fs.readFileSync(p, "utf-8"),
              })),
            )
            .returning();

          await fs.promises.rm(contentDir, { recursive: true, force: true });

          toSend.push({
            type: "text",
            text: [
              `ZIP file processed. File IDs:`,
              ...localFiles.map((f) => f.id),
            ].join("\n"),
          });
          toSend.push({
            type: "text",
            text: "You should call read_file tool to read files you may need.",
          });
        }
      } else {
        toSend.push({
          type: "text",
          text: "Text file contents:",
        });
        toSend.push({
          type: "text",
          text: await fs.promises.readFile(file.localPath, {
            encoding: "utf-8",
          }),
        });
      }
    }
    if (ctx.msg.location) {
      toSend.push({
        type: "text",
        text: JSON.stringify(ctx.msg.location),
      });
    }
    if (ctx.msg.sticker) {
      const file = await downloadFile(ctx);

      const images: Buffer[] = [];
      if (ctx.msg.sticker.is_animated) {
        const mp4FilePath = await new TGS(file.localPath).convertToMp4(
          path.join(LOCAL_FILES_DIR, `${createId()}.mp4`),
        );
        const frames = await callPython("processVideo", {
          file_path: mp4FilePath,
          lang: "en",
        });
        for (const result of frames) {
          images.push(await fs.promises.readFile(result.frame.path));
        }
      } else if (file.fileType?.mime.startsWith("video")) {
        const frames = await callPython("processVideo", {
          file_path: file.localPath,
          lang: "en",
        });
        for (const result of frames) {
          images.push(await fs.promises.readFile(result.frame.path));
        }
      } else {
        images.push(
          await sharp(file.localPath).jpeg({ mozjpeg: true }).toBuffer(),
        );
      }

      const { text, usage } = await generateText({
        model: openai("gpt-4o"),
        system:
          "You're a helpful AI assistant that imitates API endpoints for web server that returns info about ANY sticker on Telegram.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `The user has sent a Telegram sticker: ${JSON.stringify(ctx.msg.sticker)}. Describe everything about it most accurately for another LLM to understand and interpret, and add references to pop culture or things it might look like.`,
              },
              ...(images.map((image) => ({
                type: "image",
                image,
              })) as ImagePart[]),
            ],
          },
        ],
      });
      if (userExceedsFreeMessages && !userIsOwner) {
        await deductCredits(ctx, usage);
      }

      toSend.push({
        type: "text",
        text: `Telegram sticker contents: ${text}`,
      });
    }
    if (ctx.msg.caption) {
      toSend.push({
        type: "text",
        text: ctx.msg.caption,
      });
    }

    logger.debug(
      `User message content: ${inspect({ toSend, remindingSystemPrompt }, true, 10, true)}`,
    );

    // Get previous messages
    const collection = await chroma.getOrCreateCollection({
      name: "message_history",
    });

    // Search for previous turns with relevant information
    const relevantDocuments = await collection.query({
      queryTexts: [ctx.msg.text ?? ctx.msg.caption ?? ""],
      where: {
        chatId: ctx.chatId,
      },
      nResults: 4,
    });

    logger.debug(`Relevant messages: ${inspect(relevantDocuments)}`);

    // For each document, get the original message turn
    const messages: CoreMessage[] = [];
    for (const metadata of relevantDocuments.metadatas[0]) {
      assert(metadata, "Metadata is null");
      const relevantTurn = (
        await kv.LRANGE(
          `message_turns:${metadata.chatId}:${userId}`,
          metadata.turnIdx as number,
          metadata.turnIdx as number,
        )
      )
        .map((t) => superjson.parse(t))
        .flat(2) as CoreMessage[];

      logger.debug(
        `Message Turn ${metadata.turnIdx}: ${inspect(relevantTurn)}`,
      );

      messages.push(...relevantTurn);
    }

    const messageTurns = (
      await kv.LRANGE(
        `message_turns:${ctx.chatId}:${userId}`,
        -(await getConfigValue(ctx.from.id, "messagehistsize")),
        -1,
      )
    )
      .map((t) => superjson.parse(t))
      .flat(2) as CoreMessage[];

    logger.debug(`Message History: ${inspect(messageTurns, true, 10, true)}`);

    messages.push(...messageTurns);

    messages.push({
      role: "system",
      content: remindingSystemPrompt.join("\n"),
    });

    const pendingRequests = await kv
      .LRANGE(`pending_requests:${ctx.chatId}:${userId}`, 0, -1)
      .then((jsons) => jsons.map((j) => superjson.parse<UserContent>(j)));

    logger.debug(
      `Pending requests: ${inspect(pendingRequests, true, 10, true)}`,
    );

    const content = [...pendingRequests.flat(1), ...toSend] as UserContent;

    messages.push({
      role: "user",
      content,
    });

    logger.debug(
      `Sending message to model: ${inspect(content, true, 10, true)}`,
    );

    const toolData: ToolData = {
      userId: user.userId!,
      chatId: ctx.chatId,
      msgId: ctx.msgId,
      dbUser: user.id,
    };

    const toolQuery: string[] = [];

    for (const part of toSend) {
      if (typeof part === "string") {
        toolQuery.push(part);
      } else if (part.type === "text") {
        toolQuery.push(part.text);
      } else if (part.type === "file") {
        toolQuery.push(`File type: ${part.mimeType}`);
      }
    }

    logger.debug(toolQuery, "Search query for toolbox");

    logger.debug(`Determining model type`);

    for (const message of messages) {
      if (
        typeof message.content !== "string" &&
        message.content.find((part) => part.type === "image")
      ) {
        ctx.model = openai("gpt-4o");
        break;
      }
    }

    const fns = {
      ...mainFunctions(toolData),
      ...(await toolbox(toolData, toolQuery.join(" "))),
    };

    const generateTextParams: Omit<GenerateTextParams<typeof fns>, "model"> = {
      tools: fns,
      system: await buildPrompt("system", {
        me: JSON.stringify(ctx.me),
        date: new Date().toLocaleString(),
        language: await getConfigValue(ctx.from.id, "language"),
        personality: (
          await db.query.personality.findMany({
            columns: {
              content: true,
            },
          })
        )
          .map((r) => r.content)
          .join("\n"),
      }),
      messages,
      maxSteps: 5,
    };
    let modelUsage: LanguageModelUsage | undefined;

    await kv.RPUSH(
      `pending_requests:${ctx.chatId}:${userId}`,
      superjson.stringify(toSend),
    );

    if (ctx.msg.voice || ctx.msg.audio) {
      // Remove all image_url inputs for audio model
      const messagesForAudioModel = messages.map((message) => {
        let content = message.content;

        if (Array.isArray(message.content)) {
          content = message.content.filter((part) => part.type !== "image") as
            | (TextPart | ImagePart | FilePart)[]
            | (TextPart | ToolCallPart)[]
            | ToolContent;
        }

        return {
          ...message,
          content,
        };
      });

      const { audio, ...result } = await generateAudio({
        ...generateTextParams,
        messages: messagesForAudioModel as CoreMessage[],
      });
      modelUsage = result.usage;

      assert(audio);

      const fileId = createId();
      const spokenPath = path.join(DATA_DIR, `voice-${fileId}.mp3`);
      await fs.promises.writeFile(
        spokenPath,
        Buffer.from(audio.data, "base64"),
        { encoding: "utf-8" },
      );
      const outputPath = path.join(DATA_DIR, `voice-${fileId}.ogg`);
      await runCommand(
        `ffmpeg -i ${spokenPath} -acodec libopus -filter:a "volume=10dB" ${outputPath}`,
      );

      await telegram.sendVoice(
        ctx.chatId,
        new InputFile(fs.createReadStream(outputPath)),
        {
          reply_parameters: {
            message_id: ctx.msgId,
          },
        },
      );

      await fs.promises.rm(spokenPath);
      await fs.promises.rm(outputPath);

      // Remove all pending requests
      await kv.DEL(`pending_requests:${ctx.chatId}:${userId}`);
    } else {
      const { textStream, usage } = streamText({
        model: ctx.model,
        ...generateTextParams,
        async onFinish(result) {
          activeRequests.delete(userId);
          modelUsage = await usage;

          // Remove all pending requests
          await kv.DEL(`pending_requests:${ctx.chatId}:${userId}`);

          // Save to redis
          const turn = [
            { role: "user", content: toSend },
            ...result.response.messages,
          ];
          const turnIdx =
            (await kv.RPUSH(
              `message_turns:${ctx.chatId}:${userId}`,
              superjson.stringify(turn),
            )) - 1;

          // Save to chromadb
          // queryDocument is what will be used to match the user's query
          // based on the input message
          const queryDocument: string[] = [];

          for (const chunk of turn) {
            for (const part of chunk.content) {
              if (typeof part === "string") {
                queryDocument.push(part);
              } else if (part.type === "text") {
                queryDocument.push(part.text);
              } else if (part.type === "file") {
                queryDocument.push(part.mimeType);
              }
            }
          }

          logger.debug(`Saving to chromadb: ${queryDocument}`);

          await collection.add({
            documents: [queryDocument.join(" ")],
            ids: [createId()],
            metadatas: [{ chatId: ctx.chatId, messageId: ctx.msgId, turnIdx }],
          });
        },
        async onError({ error }) {
          logger.error(error, "Encountered error during AI streaming");
          activeRequests.delete(userId);
          modelUsage = await usage;
        },
        abortSignal: controller.signal,
      });

      let textBuffer = "";
      let firstMessageSent = false;

      const flushBuffer = async () => {
        // flush the buffer
        if (textBuffer.trim().length > 0) {
          const mdv2 = telegramifyMarkdown(textBuffer, "escape");
          await telegram.sendMessage(ctx.chatId, mdv2, {
            parse_mode: "MarkdownV2",
            ...(ctx.editedMessage &&
              !firstMessageSent && {
                reply_parameters: {
                  message_id: ctx.msgId,
                },
              }),
          });
          textBuffer = "";
          firstMessageSent = true;
        }
      };

      for await (const textPart of textStream) {
        textBuffer += textPart;
        logger.debug(textBuffer);

        if (
          textBuffer.trim().endsWith("<|message|>") ||
          textBuffer.trim().endsWith("</|message|>")
        ) {
          textBuffer = textBuffer.replaceAll("<|message|>", "");
          textBuffer = textBuffer.replaceAll("</|message|>", "");

          await flushBuffer();
        }
      }

      await flushBuffer();
    }

    assert(modelUsage, "Model usage not found!");

    if (!userIsOwner) {
      if (userExceedsFreeMessages) {
        await deductCredits(ctx, modelUsage);
      } else {
        await db
          .update(tables.users)
          .set({
            freeTierMessageCount: sql`${tables.users.freeTierMessageCount} + 1`,
          })
          .where(eq(tables.users.userId, ctx.from.id));
      }
    }
  },
);

await commands.setCommands(bot);

export { bot };
