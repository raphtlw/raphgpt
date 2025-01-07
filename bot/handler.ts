import { bot } from "@/bot/bot.js";
import { configSchema, getConfigValue } from "@/bot/config.js";
import { DATA_DIR, LOCAL_FILES_DIR, OPENROUTER_FREE } from "@/bot/constants.js";
import logger from "@/bot/logger.js";
import { downloadFile, telegram } from "@/bot/telegram.js";
import { chroma } from "@/db/chroma.js";
import { db, tables } from "@/db/db.js";
import { mainFunctions } from "@/functions/main.js";
import { getEnv } from "@/helpers/env.js";
import { openrouter } from "@/helpers/openrouter.js";
import { buildPrompt } from "@/helpers/prompts.js";
import { callPython } from "@/helpers/python.js";
import { runModel } from "@/helpers/replicate.js";
import { runCommand } from "@/helpers/shell.js";
import {
  handleUserWalletBalanceChange,
  solanaConnection,
} from "@/helpers/solana.js";
import { superjson } from "@/helpers/superjson.js";
import { kv } from "@/kv/redis.js";
import { openai } from "@ai-sdk/openai";
import { CommandGroup } from "@grammyjs/commands";
import {
  bold,
  code,
  fmt,
  italic,
  ParseModeFlavor,
  underline,
} from "@grammyjs/parse-mode";
import { createId } from "@paralleldrive/cuid2";
import { Keypair, PublicKey } from "@solana/web3.js";
import { CoreMessage, generateText, UserContent } from "ai";
import assert from "assert";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { fileTypeFromBuffer } from "file-type";
import FormData from "form-data";
import fs from "fs";
import { globby } from "globby";
import got from "got";
import { Context, InlineKeyboard, InputFile } from "grammy";
import OpenAI from "openai";
import path from "path";
import pdf2pic from "pdf2pic";
import sharp from "sharp";
import telegramifyMarkdown from "telegramify-markdown";
import { encoding_for_model } from "tiktoken";
import { inspect } from "util";
import { z } from "zod";

const commands = new CommandGroup<ParseModeFlavor<Context>>();

const dollars = (cents: number) => {
  return cents / Math.pow(10, 2);
};

const cents = (dollars: number) => {
  return dollars * Math.pow(10, 2);
};

const calculateStripeFee = (cents: number) => {
  return (cents / 100) * 3.4 + 50;
};

const sendBuyCreditsInvoice = async (ctx: Context, amount: number) => {
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

commands
  .command("start", "Start the bot")
  .addToScope({ type: "default" }, async (ctx) => {
    await ctx.reply(
      "Hey, what's up? You can send a text, photo, telebubble or a voice message.",
    );
  });

commands.command("balance", "Check account balance", async (ctx) => {
  let readUserId = ctx.from?.id;
  if (ctx.match.length > 0) {
    readUserId = parseInt(ctx.match);
  }
  if (!readUserId) return await ctx.reply("User ID not specified");

  const user = await db.query.users.findFirst({
    where: eq(tables.users.telegramId, readUserId),
  });

  if (!user) return await ctx.reply("User not found");

  await ctx.replyFmt(
    fmt`User ID: ${bold(`${user.id}`)}
Balance: ${bold(`${dollars(user.credits)}`)}`,
  );
});

commands.command("clear", "Clear conversation history", async (ctx) => {
  let chatId = ctx.chatId;

  if (ctx.match) {
    const args = ctx.match.trim();
    chatId = parseInt(args);
  }

  const count = await kv.lLen(`message_turns:${chatId}`);

  await kv.del(`message_turns:${chatId}`);

  await ctx.reply(`All ${count} messages cleared.`);
});

commands.command("topup", "Get more tokens", async (ctx) => {
  const cmd = ctx.msg.text.split(" ");
  let amountDollars: number | null = null;
  if (cmd.length > 1) {
    amountDollars = parseFloat(cmd[1]);
  }

  const msg = await ctx.replyFmt(fmt`Choose a payment method`, {
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
  let user = await db.query.users.findFirst({
    where: eq(tables.users.telegramId, ctx.from.id),
  });
  if (!user) {
    user = await db
      .insert(tables.users)
      .values({
        chatId: ctx.chatId!,
        telegramId: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        credits: 169,
      })
      .returning()
      .get();
    await ctx.reply(
      "Welcome to raphGPT! You have $1.69 in credits to start with",
    );
  }
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
      .returning()
      .get();
  }
  assert(wallet, "Failed to retrieve wallet");

  // Notify user of current SOL price
  // await telegram.sendMessage(ctx.chatId!, `SOL current price is ${averagePrice} USD`)
  await ctx.replyFmt(
    fmt`The amount you send to this address will be used to top up your wallet: ${code(wallet.publicKey)}`,
  );
  solanaConnection.onAccountChange(
    new PublicKey(wallet.publicKey),
    async (updatedAccountInfo) => {
      logger.debug(
        `Received solana account info: ${inspect(updatedAccountInfo)}`,
      );

      assert(wallet, "Failed to retrieve wallet");

      const user = await db.query.users.findFirst({
        where: and(
          eq(tables.users.telegramId, ctx.from.id),
          isNotNull(tables.users.solanaWallet),
        ),
        with: {
          solanaWallet: true,
        },
      });
      await handleUserWalletBalanceChange(user as any);
    },
  );
  await ctx.replyFmt(fmt`Listening for incoming transactions...`);

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
    .where(eq(tables.users.telegramId, ctx.from.id))
    .returning()
    .get();

  await ctx.replyFmt(`Thanks for your purchase!`);
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
    await ctx.replyFmt(
      fmt([
        underline(bold("[HELP]")),
        "\n",
        "Available settings:\n",
        (
          Object.keys(configSchema.shape) as Array<
            keyof typeof configSchema.shape
          >
        )
          .map((key) => `- ${key} - ${configSchema.shape[key].description}`)
          .join("\n"),
      ]),
    );

    return await ctx.replyFmt(
      fmt([
        "Please specify key to set.\n",
        "Available options: ",
        Object.keys(configSchema.shape).join(", "),
      ]),
    );
  }

  if (!value) {
    return await ctx.replyFmt(fmt(["Please specify value."]));
  }

  configSchema.partial().parse({ [key]: value });

  await kv.HSET(`config:${ctx.from.id}`, key, value);

  return await ctx.reply(`Successfully set ${key} to ${value}`);
});

commands.command("config", "Get basic settings", async (ctx) => {
  assert(ctx.from);

  const result = await kv.HGETALL(`config:${ctx.from.id}`);

  await ctx.replyFmt(
    fmt(["Settings ", code(JSON.stringify(result, undefined, 4))]),
    {
      reply_parameters: {
        message_id: ctx.msgId,
        allow_sending_without_reply: true,
      },
    },
  );
});

bot.use(commands);

bot.on("message").filter(
  async (ctx) => {
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
    let user = await db.query.users.findFirst({
      where: eq(tables.users.telegramId, ctx.from.id),
    });
    if (!user) {
      const inserted = await db
        .insert(tables.users)
        .values({
          chatId: ctx.chatId,
          telegramId: ctx.from.id,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name,
          credits: 169,
        })
        .returning();
      user = inserted[0];
      await ctx.replyFmt(
        fmt`${bold(`Welcome to raphGPT. You have $1.69 in credits to start with.`)}
${italic(`You can get more tokens from the store (/topup)`)}`,
      );
    } else {
      const updated = await db
        .update(tables.users)
        .set({
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name,
        })
        .where(eq(tables.users.telegramId, ctx.from.id))
        .returning();
      user = updated[0];
    }
    assert(user, "Unable to retrieve user");

    // Check if user has enough credits
    // Excluding TELEGRAM_BOT_OWNER
    if (
      user.credits <= 0 &&
      user.telegramId !== getEnv("TELEGRAM_BOT_OWNER", z.coerce.number())
    ) {
      return await ctx.reply(
        "You have run out of credits! Use /topup to get more.",
      );
    }

    if (ctx.msg.text?.startsWith("-bot ")) {
      ctx.msg.text = ctx.msg.text.replace("-bot ", "");
    }

    const toSend: UserContent = [];
    const remindingSystemPrompt: string[] = [];

    if (ctx.msg.text) {
      toSend.push({ type: "text", text: ctx.msg.text });
    }
    if (ctx.msg.voice) {
      const file = await downloadFile(ctx);
      const result = await runModel(
        "openai/whisper:cdd97b257f93cb89dede1c7584e3f3dfc969571b357dbcee08e793740bedd854",
        {
          audio: file.remoteUrl,
          language: getConfigValue(ctx.from.id, "language"),
        },
        z.object({
          segments: z.array(z.unknown()),
          transcription: z.string(),
          detected_language: z.string(),
        }),
      );
      logger.debug(result, "Transcription");

      toSend.push({ type: "text", text: result.transcription });
    }
    if (ctx.msg.video_note) {
      const file = await downloadFile(ctx);
      const result = await runModel(
        "openai/whisper:cdd97b257f93cb89dede1c7584e3f3dfc969571b357dbcee08e793740bedd854",
        {
          audio: file.remoteUrl,
          language: getConfigValue(ctx.from.id, "language"),
        },
        z.object({
          segments: z.array(z.unknown()),
          transcription: z.string(),
          detected_language: z.string(),
        }),
      );
      logger.debug(result, "Transcription");

      const selectedFrames = await callPython("processVideo", {
        file_path: file.localPath,
        lang: "en",
      });

      remindingSystemPrompt.push(
        "You have been given periodic frames from a video. Frames with the least amount of blur were extracted.",
        "When responding, pretend you have watched a video.",
        "To avoid confusing the user, do not say they are images.",
      );
      for (const result of selectedFrames) {
        toSend.push({
          type: "image",
          image: await fs.promises.readFile(result.frame.path),
        });
      }
      toSend.push({
        type: "text",
        text: result.transcription,
      });
    }
    if (ctx.msg.photo) {
      const file = await downloadFile(ctx);
      const image = await sharp(file.localPath)
        .jpeg({ mozjpeg: true })
        .toBuffer();
      toSend.push({
        type: "image",
        image,
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

          let textFilePaths = [];

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
      const image = await sharp(file.localPath)
        .jpeg({ mozjpeg: true })
        .toBuffer();
      toSend.push({
        type: "image",
        image,
      });
    }
    if (ctx.msg.caption) {
      toSend.push({
        type: "text",
        text: ctx.msg.caption,
      });
    }

    logger.debug(inspect({ toSend, remindingSystemPrompt }));

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

    logger.debug(`Relevant info: ${inspect(relevantDocuments)}`);

    // For each document, get the original message turn
    let messages: CoreMessage[] = [];
    for (const metadata of relevantDocuments.metadatas[0]) {
      assert(metadata, "Metadata is null");
      const relevantTurn = (
        await kv.lRange(
          `message_turns:${metadata.chatId}`,
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
      await kv.lRange(
        `message_turns:${ctx.chatId}`,
        -(await getConfigValue(ctx.from.id, "messagehistsize")),
        -1,
      )
    )
      .map((t) => superjson.parse(t))
      .flat(2) as CoreMessage[];

    logger.debug(`Message History: ${inspect(messageTurns)}`);

    messages.push(...messageTurns);

    messages.push({
      role: "system",
      content: remindingSystemPrompt.join("\n"),
    });

    messages.push({
      role: "user",
      content: toSend,
    });

    const {
      text: finalResponse,
      response,
      usage,
    } = await generateText({
      model: openai("gpt-4o"),
      tools: mainFunctions(user.id, ctx.chatId, ctx.msgId),
      system: await buildPrompt("system", {
        me: JSON.stringify(await telegram.getMe()),
        date: new Date().toLocaleString(),
        language: await getConfigValue(ctx.from.id, "language"),
        personality: (
          await db.query.personality.findMany({
            columns: {
              id: true,
              content: true,
            },
          })
        )
          .map((r) => `${r.id} - ${r.content}`)
          .join("\n"),
      }),
      messages,
      maxSteps: 5,
    });
    const turn = [{ role: "user", content: toSend }, ...response.messages];
    const turnIdx =
      (await kv.RPUSH(
        `message_turns:${ctx.chatId}`,
        superjson.stringify(turn),
      )) - 1;

    // Send final response to user
    if (ctx.msg.voice || ctx.msg.video_note) {
      const { text: toSpeak, usage: voiceUsage } = await generateText({
        model: openrouter(OPENROUTER_FREE),
        prompt: await buildPrompt("speech", {
          originalQuery: ctx.msg.text,
          output: finalResponse,
        }),
      });

      logger.info(`To be spoken (formatted): "${toSpeak}"`);

      const openai = new OpenAI();
      const mp3 = await openai.audio.speech.create({
        model: "tts-1",
        voice: "shimmer",
        input: toSpeak,
      });
      const fileId = createId();
      const spokenPath = path.join(DATA_DIR, `voice-${fileId}.mp3`);
      await fs.promises.writeFile(
        spokenPath,
        Buffer.from(await mp3.arrayBuffer()),
      );
      const outputPath = path.join(DATA_DIR, `voice-${fileId}.ogg`);
      await runCommand(
        `ffmpeg -i ${spokenPath} -acodec libopus -filter:a "volume=6dB" ${outputPath}`,
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
    }

    logger.debug(`Final response: ${finalResponse}`);

    // Convert message to MarkdownV2
    const mdv2 = telegramifyMarkdown(finalResponse, "escape");

    try {
      logger.debug({ finalResponse, mdv2 }, "Telegramify Markdown");
      await telegram.sendMessage(ctx.chatId, mdv2, {
        parse_mode: "MarkdownV2",
      });
    } catch (e) {
      logger.error(e, "Unable to send MarkdownV2 message");
      logger.info("Uploading message to web");

      let pageTitle: string | null = null;

      try {
        // limit content length to fit context size for model
        const enc = encoding_for_model("gpt-4o");
        const tok = enc.encode(finalResponse);
        const lim = tok.slice(0, 1024);
        const txt = new TextDecoder().decode(enc.decode(lim));
        enc.free();

        const { text: title } = await generateText({
          model: openrouter(OPENROUTER_FREE),
          prompt: [
            "Generate a suitable title for the following article:",
            txt,
            "Reply only with the title and nothing else.",
            "Do not use any quotes to wrap the title.",
          ].join("\n"),
        });
        pageTitle = title;
      } catch (e) {
        logger.error(e, "Error occurred while generating title");
        pageTitle = "Bot Response";
      }

      const result = await got
        .post(`${getEnv("RAPHTLW_URL")}/api/raphgpt/document`, {
          json: {
            title: pageTitle,
            content: finalResponse,
          },
          headers: {
            Authorization: `Bearer ${getEnv("RAPHTLW_API_KEY")}`,
          },
        })
        .json()
        .then((r) =>
          z
            .object({
              doc: z.object({
                _createdAt: z.string().datetime(),
                _id: z.string(),
                _rev: z.string(),
                _type: z.literal("raphgptPage"),
                _updatedAt: z.string().datetime(),
                content: z.string(),
                publishedAt: z.string().datetime(),
                title: z.string(),
              }),
            })
            .parse(r),
        );
      const publishNotification = fmt([
        "Telegram limits message sizes, so I've published the message online.",
        "\n",
        "You can view the message at this URL: ",
        `${getEnv("RAPHTLW_URL")}/api/raphgpt/document/${result.doc._id}`,
      ]);
      await telegram.sendMessage(ctx.chatId, publishNotification.text, {
        entities: publishNotification.entities,
        reply_parameters: {
          message_id: ctx.msgId,
          allow_sending_without_reply: true,
        },
      });
    }

    let cost = 0;

    cost += usage.promptTokens * (2.5 / 1_000_000);
    cost += usage.completionTokens * (10 / 1_000_000);

    // up to 50 cents in fees per message (the more tokens used, the less fees)
    cost += cost + 0.3 / usage.completionTokens + 0.2;

    cost /= Math.pow(10, 2); // Store value without 2 d.p.

    // Subtract credits from user
    await db
      .update(tables.users)
      .set({
        credits: sql`${tables.users.credits} - ${cost}`,
      })
      .where(eq(tables.users.telegramId, ctx.from.id));

    logger.debug({ cost }, "Deducted credits");

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
      documents: [queryDocument.join("\n")],
      ids: [createId()],
      metadatas: [{ chatId: ctx.chatId, messageId: ctx.msgId, turnIdx }],
    });
  },
);

await commands.setCommands(bot);

export { bot };
