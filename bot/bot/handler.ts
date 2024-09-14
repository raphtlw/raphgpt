import { openai } from "@ai-sdk/openai";
import { bold, fmt, italic } from "@grammyjs/parse-mode";
import { createId } from "@paralleldrive/cuid2";
import { CoreMessage, generateText, UserContent } from "ai";
import assert from "assert";
import { desc, eq, sql } from "drizzle-orm";
import { fileTypeFromFile } from "file-type";
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
import logger from "../bot/logger.js";
import { downloadFile, telegram } from "../bot/telegram.js";
import { db, tables } from "../db/db.js";
import { mainFunctions } from "../functions/main.js";
import { getEnv } from "../helpers/env.js";
import { openrouter } from "../helpers/openrouter.js";
import { buildPrompt } from "../helpers/prompts.js";
import { callPython } from "../helpers/python.js";
import { runModel } from "../helpers/replicate.js";
import { runCommand } from "../helpers/shell.js";
import { superjson } from "../helpers/superjson.js";
import { kv } from "../kv/redis.js";
import { bot } from "./bot.js";
import { DATA_DIR, LOCAL_FILES_DIR, OPENROUTER_FREE } from "./constants.js";

const calculateStripeFee = (amount: number) => {
  return (amount / 100) * 3.4 + 50;
};

const sendBuyCreditsInvoice = async (ctx: Context, amount: number) => {
  if (amount < 100) {
    return await ctx.reply("Min. Amount is 100 tokens.");
  }

  const cost = Math.trunc(amount + calculateStripeFee(amount));

  await ctx.replyWithInvoice(
    "Buy Credits (USD)",
    "Get tokens which will be used to run servers and support the project.",
    JSON.stringify({ cost, amount }),
    "USD",
    [
      {
        amount: cost,
        label: `Get ${amount} tokens for $${cost}!`,
      },
    ],
    {
      provider_token: getEnv("TELEGRAM_PAYMENT_STRIPE_LIVE"),
      start_parameter: "",
      photo_url:
        "https://storage.googleapis.com/raphgpt-static/duck-token.jpeg",
    },
  );
};

bot.on("callback_query:data", async (ctx) => {
  logger.debug(
    { payload: ctx.callbackQuery.data },
    "Button event with payload",
  );
  const payload = JSON.parse(ctx.callbackQuery.data);
  if (payload.action === "deposit-amount-chosen") {
    await sendBuyCreditsInvoice(ctx, payload.amount);
  } else if (
    payload.action === "cancel" &&
    ctx.chatId &&
    ctx.callbackQuery.message?.message_id
  ) {
    await telegram.deleteMessage(
      ctx.chatId,
      ctx.callbackQuery.message?.message_id,
    );
  } else {
    logger.error("Unknown event");
  }
  await ctx.answerCallbackQuery({ text: "What is love, baby don't hurt me" });
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Hey, what's up? You can send a text, photo, telebubble or a voice message.",
  );
});

bot.command("balance", async (ctx) => {
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
Tokens left: ${bold(`${user.credits}`)}`,
  );
});

// bot.command("usage", async (ctx) => {
//   let readChatId = ctx.chatId;
//   if (ctx.match.length > 0) {
//     readChatId = parseInt(ctx.match);
//   }

//   const messages = await db.query.messages.findMany({
//     where: eq(tables.messages.chatId, readChatId),
//   });

//   if (messages.length === 0) {
//     await ctx.reply("You have not sent any messages. Try /start!", {
//       reply_parameters: {
//         message_id: ctx.msgId,
//         allow_sending_without_reply: true,
//       },
//     });
//     return;
//   }

//   let cost = 0;
//   let totalInputTokens = 0;
//   let totalOutputTokens = 0;
//   let turns = [];

//   // Chunk messages into conversation turns
//   let turn = { input: "", output: "" };
//   for (let i = 0; i < messages.length; i++) {
//     const message = JSON.parse(messages[i].json);
//     if (message.role === "user") {
//       if (typeof message.content === "string") {
//         turn.input += message.content;
//       } else if (Array.isArray(message.content)) {
//         for (const part of message.content) {
//           if (part.type === "image_url") {
//             cost += 0.003;
//           }
//           if (part.type === "text") {
//             turn.input += part.text;
//           }
//         }
//       }
//     }
//     if (message.role === "tool") {
//       turn.input += message.content;
//     }
//     if (message.role === "assistant") {
//       if (typeof message.content === "string") {
//         turn.output += message.content;
//       } else if (Array.isArray(message.content)) {
//         turn.output += message.content.join("");
//       }
//       turns.push(turn);
//       turn = { input: "", output: "" };
//     }
//   }

//   const enc = encoding_for_model("gpt-4o");

//   for (let lim = 0; lim < turns.length; lim++) {
//     for (let m = 0; m <= lim; m++) {
//       const inputTokens = enc.encode(turns[m].input);
//       const outputTokens = enc.encode(turns[m].output);

//       totalInputTokens += inputTokens.length;
//       totalOutputTokens += outputTokens.length;

//       cost += inputTokens.length * (5 / 1_000_000);
//       cost += outputTokens.length * (15 / 1_000_000);
//     }
//   }

//   await ctx.replyFmt(
//     fmt([
//       underline(`[${bold("USAGE")}]`),
//       `\n\n`,
//       `You have used this amount of input tokens: ${totalInputTokens}\n`,
//       `You have used this amount of output tokens: ${totalOutputTokens}`,
//       `\n\n`,
//       `Your total spending is: ${cost} USD`,
//     ]),
//   );
// });

bot.command("clear", async (ctx) => {
  const args = ctx.match.trim();
  let chatId: number;

  if (args.length > 0) {
    chatId = parseInt(args);
  } else {
    chatId = ctx.chatId;
  }

  const count = await kv.lLen(`message_turns:${chatId}`);

  await kv.del(`message_turns:${chatId}`);

  await ctx.reply(`All ${count} messages cleared.`);
});

bot.command("topup", async (ctx) => {
  const args = ctx.match.trim();

  if (args.length === 0) {
    const buildSelection = (amount: number) =>
      InlineKeyboard.text(
        `${amount} tokens ($${Math.trunc(amount + calculateStripeFee(amount)) / 100})`,
        JSON.stringify({ action: "deposit-amount-chosen", amount }),
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
          .row(
            InlineKeyboard.text(
              "Cancel ❌",
              JSON.stringify({ action: "cancel" }),
            ),
          ),
      },
    );
  }

  if (args.indexOf(".") > -1) {
    return await ctx.reply(
      "Decimals are not supported! Must be a whole number: /topup 300",
    );
  }

  const amount = parseInt(args);
  await sendBuyCreditsInvoice(ctx, amount);
});

bot.on("pre_checkout_query", async (ctx) => {
  let user = await db.query.users.findFirst({
    where: eq(tables.users.telegramId, ctx.from.id),
  });
  if (!user) {
    const inserted = await db
      .insert(tables.users)
      .values({
        telegramId: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        credits: String(0),
      })
      .returning();
    user = inserted[0];
    await ctx.reply("Welcome to raphGPT!");
  }
  assert(user, "Unable to retrieve user");

  await db.insert(tables.pendingPayments).values({
    telegramUserId: ctx.from.id,
    payload: ctx.preCheckoutQuery.invoice_payload,
  });

  await ctx.answerPreCheckoutQuery(true);
});

bot.on("msg:successful_payment", async (ctx) => {
  assert(ctx.from);

  const pendingPayment = await db.query.pendingPayments.findFirst({
    where: eq(tables.pendingPayments.telegramUserId, ctx.from.id),
    orderBy: desc(tables.pendingPayments.created),
  });

  assert(pendingPayment);

  const payload = JSON.parse(pendingPayment.payload);

  await db
    .update(tables.users)
    .set({
      credits: sql`${tables.users.credits} + ${payload.amount}`,
    })
    .where(eq(tables.users.telegramId, ctx.from.id));
});

bot.on("message", async (ctx) => {
  if (
    !(
      ctx.hasChatType("private") ||
      (ctx.msg.from.id === getEnv("TELEGRAM_BOT_OWNER", z.coerce.number()) &&
        ctx.msg.text?.startsWith("-bot "))
    )
  )
    return;

  let user = await db.query.users.findFirst({
    where: eq(tables.users.telegramId, ctx.from.id),
  });
  if (!user) {
    const inserted = await db
      .insert(tables.users)
      .values({
        telegramId: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        credits: String(69),
      })
      .returning();
    user = inserted[0];
    await ctx.replyFmt(
      fmt`${bold(`Welcome to raphGPT. You have a free trial of 69 tokens.`)}
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
    parseFloat(user.credits) <= 0 &&
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
        language: "auto",
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
        language: "auto",
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
          const binaryType = await fileTypeFromFile(filePath);
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

  const messages = (
    await kv.lRange(
      `message_turns:${ctx.chatId}`,
      -getEnv("MESSAGE_CHUNKED_HISTORY_SIZE", z.coerce.number()),
      -1,
    )
  )
    .map((t) => superjson.parse(t))
    .flat(2) as CoreMessage[];

  logger.debug(`Message History: ${inspect(messages)}`);

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
    responseMessages,
    usage,
  } = await generateText({
    model: openai("gpt-4o"),
    tools: mainFunctions(ctx.chatId, ctx.msgId),
    system: await buildPrompt("system", {
      me: JSON.stringify(await telegram.getMe()),
      date: new Date().toLocaleString(),
    }),
    messages,
    maxToolRoundtrips: 5,
  });
  const turn = [{ role: "user", content: toSend }, ...responseMessages];
  await kv.rPush(`message_turns:${ctx.chatId}`, superjson.stringify(turn));

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

    assert(voiceUsage, "Could not get usage details");
    await db
      .insert(tables.usage)
      .values({
        userId: user.id,
        model: "gpt-4o",
        inputTokens: voiceUsage.promptTokens,
        outputTokens: voiceUsage.completionTokens,
      })
      .onConflictDoUpdate({
        target: [tables.usage.userId, tables.usage.model],
        set: {
          inputTokens: sql`${tables.usage.inputTokens} + ${voiceUsage.promptTokens}`,
          outputTokens: sql`${tables.usage.outputTokens} + ${voiceUsage.completionTokens}`,
        },
      });
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

    const insertResult = await db
      .insert(tables.fullResponses)
      .values({
        title: pageTitle,
        content: finalResponse,
      })
      .returning();
    const published = insertResult[0];
    const publishNotification = fmt([
      "Telegram limits message sizes, so I've published the message online.",
      "\n",
      "You can view the message at this URL: ",
      `${process.env.WEB_SITE_URL}/telegram/${published.id}`,
    ]);
    await telegram.sendMessage(ctx.chatId, publishNotification.text, {
      entities: publishNotification.entities,
      reply_parameters: {
        message_id: ctx.msgId,
        allow_sending_without_reply: true,
      },
    });

    // Track usage
    await db
      .insert(tables.usage)
      .values({
        userId: user.id,
        model: "gpt-4o",
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
      })
      .onConflictDoUpdate({
        target: [tables.usage.userId, tables.usage.model],
        set: {
          inputTokens: sql`${tables.usage.inputTokens} + ${usage.promptTokens}`,
          outputTokens: sql`${tables.usage.outputTokens} + ${usage.completionTokens}`,
        },
      });

    let cost = 0;

    cost += usage.promptTokens * (5 / 1_000_000);
    cost += usage.completionTokens * (15 / 1_000_000);

    // 3% of fees
    cost += (cost / 100) * 3;

    cost = cost * 100; // Store value without 2 d.p.

    // Subtract credits from user
    await db
      .update(tables.users)
      .set({
        credits: sql`${tables.users.credits} - ${cost}`,
      })
      .where(eq(tables.users.telegramId, ctx.from.id));

    logger.debug({ cost }, "Deducted credits");
  }
});

bot.api.setMyCommands([
  { command: "start", description: "Start the bot" },
  { command: "usage", description: "Check usage and spending" },
  { command: "topup", description: "Get more tokens" },
  { command: "clear", description: "Clear conversation history" },
  { command: "balance", description: "Check token balance" },
]);

export { bot };
