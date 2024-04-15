import { autoRetry } from "@grammyjs/auto-retry";
import { FileFlavor, hydrateFiles } from "@grammyjs/files";
import {
  FormattedString,
  bold,
  fmt,
  pre,
  underline,
} from "@grammyjs/parse-mode";
import { run, sequentialize } from "@grammyjs/runner";
import { createId } from "@paralleldrive/cuid2";
import {
  Conversation,
  DraftMessage,
  message,
  runModel,
  transcribeAudio,
} from "ai";
import assert from "assert";
import { Command } from "bot/command";
import { debugPrint } from "bot/debug";
import { sendMarkdownMessage } from "bot/message";
import { chatAction } from "bot/tasks";
import { timestamp } from "bot/time";
import { db } from "db";
import { guss, messages, openaiMessages } from "db/schema";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import fs from "fs";
import { Bot, Context, GrammyError, HttpError, InputFile } from "grammy";
import { OpenAIChatApi } from "llm-api";
import ollama from "ollama";
import OpenAI from "openai";
import path from "path";
import { Env } from "secrets/env";
import { z } from "zod";
import zodGPT from "zod-gpt";

const bot = new Bot<FileFlavor<Context>>(Env.TELEGRAM_API_KEY);

bot.api.config.use(autoRetry());
bot.api.config.use(hydrateFiles(bot.token));

bot.use(sequentialize((ctx) => String(ctx.chat?.id)));

if (!fs.existsSync("data")) {
  fs.mkdirSync("data");
  console.log("Wrote data/ folder");
}

if (!fs.existsSync("data/file")) {
  fs.mkdirSync("data/file");
  console.log("Wrote data/file/ folder");
}

const ME = await bot.api.getMe();

// handle message replies from RaphGPT Bot updates chat
bot
  .chatType(["group", "supergroup"])
  .on("message:text")
  .filter(
    (ctx) =>
      ctx.chat.id === Number(Env.TELEGRAM_BOT_UPDATES_CHAT_ID) &&
      ctx.msg.reply_to_message !== undefined,
    async (ctx, next) => {
      assert(ctx.msg.reply_to_message);

      const message = await db.query.messages.findFirst({
        where: eq(
          messages.telegramId,
          String(ctx.msg.reply_to_message.message_id),
        ),
      });

      if (message) {
        const msg = JSON.parse(message.contextData).originalMessage;
        await bot.api.sendMessage(msg.chat.id, ctx.msg.text, {
          reply_parameters: {
            message_id: msg.message_id,
          },
        });
      }

      await next();
    },
  );

const excludingBotUpdates = bot
  .on("message")
  .filter((ctx) => ctx.chat.id !== Number(Env.TELEGRAM_BOT_UPDATES_CHAT_ID));

const regularGroups = bot
  .on("message")
  .filter(
    (ctx) =>
      ![
        Env.TELEGRAM_BOT_UPDATES_CHAT_ID,
        Env.TELEGRAM_OPENAI_CHAT_ID,
        Env.TELEGRAM_GPT4_CHAT_ID,
      ].includes(ctx.chat.id.toString()),
  );

// on every message, except messages sent to bot updates
excludingBotUpdates.on("message", async (ctx, next) => {
  let filename: string | undefined;

  try {
    const file = await ctx.getFile();

    assert(file.file_path);

    const ext = path.extname(file.file_path);
    filename = `${file.file_id}${ext}`;

    await file.download(path.join("data", "file", filename));
  } catch (e) {
    // message doesn't contain file
  }

  // cache message to db
  await db.insert(messages).values({
    id: createId(),
    telegramId: ctx.msg.message_id.toString(),
    telegramChatId: ctx.chat.id.toString(),
    telegramAuthorId: ctx.msg.from.id.toString(),
    contextData: JSON.stringify(ctx.msg),
    text: ctx.msg.text,
    file: filename,
  });

  // send message notification
  const botUpdatesMessage = fmt([
    "Message received:" + "\n",
    pre(JSON.stringify(ctx.msg, undefined, 2), "json"),
  ]);
  const botUpdatesMessageSent = await bot.api.sendMessage(
    Env.TELEGRAM_BOT_UPDATES_CHAT_ID,
    botUpdatesMessage.text,
    {
      entities: botUpdatesMessage.entities,
    },
  );
  await db.insert(messages).values({
    id: createId(),
    telegramId: botUpdatesMessageSent.message_id.toString(),
    telegramChatId: botUpdatesMessageSent.chat.id.toString(),
    telegramAuthorId: ME.id.toString(),
    contextData: JSON.stringify(botUpdatesMessageSent),
    text: botUpdatesMessage.text,
  });

  // forward original message
  const messageForwarded = await bot.api.forwardMessage(
    Env.TELEGRAM_BOT_UPDATES_CHAT_ID,
    ctx.msg.chat.id,
    ctx.msg.message_id,
  );
  await db.insert(messages).values({
    id: createId(),
    telegramId: messageForwarded.message_id.toString(),
    telegramChatId: messageForwarded.chat.id.toString(),
    telegramAuthorId: ME.id.toString(),
    contextData: JSON.stringify({
      originalMessage: ctx.msg,
      ...messageForwarded,
    }),
  });

  await next();
});

// OpenAI chat commands
bot
  .chatType(["group", "supergroup"])
  .filter((ctx) => ctx.chat.id.toString() === Env.TELEGRAM_OPENAI_CHAT_ID)
  .command(["createtopic", "newthread", "newtopic"], async (ctx) => {
    const newTopic = await ctx.createForumTopic(
      ctx.match.length > 0 ? ctx.match : `${ctx.from.first_name}'s chat`,
    );

    await ctx.reply(`🤖 Created forum topic (${newTopic.name})`, {
      reply_parameters: {
        message_id: ctx.msg.message_id,
      },
    });
  });
await bot.api.setMyCommands(
  [{ command: "createtopic", description: "Create new thread" }],
  {
    scope: {
      type: "chat",
      chat_id: Number(Env.TELEGRAM_OPENAI_CHAT_ID),
    },
  },
);

// handle all messages from OpenAI related chats
bot
  .chatType(["group", "supergroup"])
  .filter((ctx) =>
    [Env.TELEGRAM_OPENAI_CHAT_ID, Env.TELEGRAM_GPT4_CHAT_ID].includes(
      ctx.chat.id.toString(),
    ),
  )
  .on("message", async (ctx, next) => {
    const draft = new DraftMessage();

    // get cached message
    const cachedMessage = await db.query.messages.findFirst({
      where: eq(messages.telegramId, ctx.msg.message_id.toString()),
    });
    assert(cachedMessage);

    if (ctx.msg.text) {
      draft.add({
        type: "text",
        text: ctx.msg.text,
      });
    }
    if (ctx.msg.photo) {
      const file = await ctx.getFile();
      draft.add({
        type: "text",
        text: `Image file: ${file.getUrl()}`,
      });
    }
    if (ctx.msg.caption) {
      draft.add({
        type: "text",
        text: ctx.msg.caption,
      });
    }
    if (ctx.msg.location) {
      draft.add({
        type: "text",
        text: JSON.stringify(ctx.msg.location),
      });
    }
    if (ctx.msg.voice) {
      assert(cachedMessage.file);

      const transcription = await transcribeAudio(
        path.join("data", "file", cachedMessage.file),
      );

      draft.add({
        type: "text",
        text: transcription,
      });
    }
    if (ctx.msg.video_note || ctx.msg.video) {
      assert(cachedMessage.file);

      const videoPath = path.join("data", "file", cachedMessage.file);

      const audioOutputPath = path.join(process.cwd(), `${createId()}.mp3`);

      const extractAudioCommand = await Command(
        `ffmpeg -i "${videoPath}" -vn -ac 2 -ar 44100 -ab 320k -f mp3 ${audioOutputPath}`,
      ).run();
      console.log(extractAudioCommand);

      // create transcription
      const transcription = await transcribeAudio(audioOutputPath);

      // delete temp folders
      await Promise.all([fs.promises.rm(audioOutputPath)]);

      draft.add({
        type: "text",
        text: `Video ${ctx.msg.video_note ? "note (is_video_note=true)" : "file (is_video_note=false)"}: ${videoPath}`,
      });
      draft.add({
        type: "text",
        text: `Transcript: ${transcription}`,
      });
    }

    // store thread ID here
    let messageThreadId: string | undefined =
      ctx.msg.message_thread_id?.toString();

    // if message has no thread, create one (in OpenAI chat)
    if (
      !messageThreadId &&
      ctx.chat.id.toString() === Env.TELEGRAM_OPENAI_CHAT_ID
    ) {
      const newTopic = await ctx.createForumTopic("New chat");
      messageThreadId = newTopic.message_thread_id.toString();
    }

    const messageHistory = await db.query.openaiMessages.findMany({
      where: and(
        eq(openaiMessages.telegramChatId, ctx.chat.id.toString()),
        messageThreadId
          ? eq(openaiMessages.telegramThreadId, messageThreadId)
          : undefined,
      ),
      orderBy: asc(openaiMessages.created),
    });

    let history = new Conversation(
      messageHistory.map((msg) => JSON.parse(msg.json)),
    );

    if (ctx.chat.id.toString() === Env.TELEGRAM_GPT4_CHAT_ID) {
      history = history.takeLast(10);
    }

    history.addSystem(
      "You are a friendly and helpful assistant named RaphGPT.",
      "You have eyes and can see. Whenever photo/image, you say vision",
      "Telegram supports location sharing. Just ask the user to send it.",
      `It is currently ${new Date().toLocaleString()}`,
      `Current chat chat_id=${ctx.chat.id} thread_id=${messageThreadId}`,
    );

    history.addUserInstructions(
      "My name is",
      ctx.from.first_name,
      "You are RaphGPT, an autononous AI developed by @raphtlw.",
      "Please use the tools you have at your disposal",
    );

    const conversation = new Conversation([draft.get()]);

    const response = await chatAction(
      ctx.chat,
      "typing",
      async () => {
        let [firstResponse, latestResponse] = await runModel(
          history,
          conversation,
        );
        while (latestResponse.role === "tool") {
          const functionCall = message(firstResponse).getCombinedContent();
          if (functionCall && functionCall.length > 0) {
            await sendMarkdownMessage(ctx.chat.id, functionCall, {
              message_thread_id:
                ctx.chat.id.toString() === Env.TELEGRAM_OPENAI_CHAT_ID
                  ? Number(messageThreadId)
                  : undefined,
              reply_parameters: {
                chat_id: ctx.chat.id,
                message_id: ctx.msg.message_id,
                allow_sending_without_reply: true,
              },
            });
          }

          [firstResponse, latestResponse] = await runModel(
            history,
            conversation,
          );
        }

        // console.log("History:", inspect(history, true, 10, true));
        // console.log("Conversation:", inspect(conversation, true, 10, true));

        return latestResponse;
      },
      {
        message_thread_id:
          ctx.chat.id.toString() === Env.TELEGRAM_OPENAI_CHAT_ID
            ? Number(messageThreadId)
            : undefined,
      },
    );

    const responseContent = message(response).getCombinedContent()!;
    await sendMarkdownMessage(ctx.chat.id, responseContent, {
      message_thread_id:
        ctx.chat.id.toString() === Env.TELEGRAM_OPENAI_CHAT_ID
          ? Number(messageThreadId)
          : undefined,
      reply_parameters: {
        chat_id: ctx.chat.id,
        message_id: ctx.msg.message_id,
        allow_sending_without_reply: true,
      },
    });

    if (ctx.msg.voice || ctx.msg.video_note) {
      await chatAction(
        ctx.chat,
        "record_voice",
        async () => {
          const openai = new OpenAI({ apiKey: Env.OPENAI_API_KEY });

          // generate speech for response
          const mp3 = await openai.audio.speech.create({
            input: responseContent,
            model: "tts-1-hd",
            voice: "alloy",
          });
          const uniqueFileName = `${timestamp()}_speech`;
          const speechFilePath = path.join(
            process.cwd(),
            `${uniqueFileName}.mp3`,
          );
          const processedSpeechFilePath = path.join(
            process.cwd(),
            `${uniqueFileName}_processed.mp3`,
          );

          await fs.promises.writeFile(
            speechFilePath,
            Buffer.from(await mp3.arrayBuffer()),
          );
          const boostVolumeCommand = await Command(
            `ffmpeg -i "${speechFilePath}" -filter:a "volume=6dB" ${processedSpeechFilePath}`,
          ).run();
          console.log(boostVolumeCommand);

          await ctx.replyWithVoice(
            new InputFile(fs.createReadStream(processedSpeechFilePath)),
            {
              message_thread_id:
                ctx.chat.id.toString() === Env.TELEGRAM_OPENAI_CHAT_ID
                  ? Number(messageThreadId)
                  : undefined,
              reply_parameters: {
                chat_id: ctx.chat.id,
                message_id: ctx.msg.message_id,
                allow_sending_without_reply: true,
              },
            },
          );

          await fs.promises.unlink(speechFilePath);
          await fs.promises.unlink(processedSpeechFilePath);
        },
        {
          message_thread_id:
            ctx.chat.id.toString() === Env.TELEGRAM_OPENAI_CHAT_ID
              ? Number(messageThreadId)
              : undefined,
        },
      );
    }

    // START topic renaming
    if (ctx.chat.id.toString() === Env.TELEGRAM_OPENAI_CHAT_ID) {
      // check if message is part of the topic created
      // then assign a good name for the topic
      if (messageHistory.length === 0) {
        const openai = new OpenAIChatApi(
          { apiKey: Env.OPENAI_API_KEY },
          {
            model: "gpt-3.5-turbo-0125",
          },
        );
        const response = await zodGPT.completion(
          openai,
          [
            JSON.stringify(conversation.get()),
            "Summarize the conversation in 6 words or fewer",
          ].join("\n"),
          {
            schema: z.object({
              title: z
                .string()
                .describe(
                  "Summarization which best describes the chat's contents",
                ),
            }),
          },
        );
        debugPrint(response);
        await bot.api.editForumTopic(ctx.chat.id, Number(messageThreadId), {
          name: response.data.title,
        });
      }
    }
    // END topic rename

    await db.insert(openaiMessages).values(
      conversation.get().map((msg) => ({
        id: createId(),
        telegramChatId: ctx.chat.id.toString(),
        telegramThreadId: messageThreadId,
        json: JSON.stringify(msg),
      })),
    );

    await next();
  });

regularGroups.command("start", async (ctx, next) => {
  await next();
});

bot.chatType("private").on("message", async (ctx, next) => {
  const fullConversation = await db.query.messages.findMany({
    where: and(
      eq(messages.telegramChatId, ctx.chat.id.toString()),
      isNotNull(messages.text),
    ),
    orderBy: asc(messages.created),
  });

  if (ctx.msg.text) {
    const conversation = fullConversation.slice(-5).map((message) => ({
      role:
        message.telegramAuthorId === ME.id.toString() ? "assistant" : "user",
      content: message.text!,
    }));

    const response = await ollama.chat({
      model: "llama2-uncensored",
      messages: conversation,
    });

    const sentResponse = await ctx.reply(response.message.content, {
      reply_parameters: {
        message_id: ctx.msg.message_id,
      },
    });
    await db.insert(messages).values({
      id: createId(),
      telegramId: sentResponse.message_id.toString(),
      telegramChatId: sentResponse.chat.id.toString(),
      telegramAuthorId: ME.id.toString(),
      contextData: JSON.stringify(sentResponse),
      text: sentResponse.text,
    });
  }

  await next();
});

const devChatGroup = bot
  .chatType(["group", "supergroup"])
  .filter((ctx) => ctx.chat.id.toString() === Env.TELEGRAM_DEV_CHAT_CHAT_ID);

devChatGroup.command(["l", "L", "w", "W"], async (ctx, next) => {
  const operation = ctx.hasCommand(["l", "L"]) ? "loss" : "win";

  if (ctx.msg.reply_to_message?.from?.id === ctx.msg.from.id) {
    await ctx.reply("❌ You cannot mark yourself!", {
      reply_parameters: {
        message_id: ctx.msg.message_id,
      },
    });

    return await next();
  }

  let record: typeof guss.$inferSelect | undefined;

  if (ctx.msg.reply_to_message?.from) {
    record = await db
      .insert(guss)
      .values({
        id: createId(),
        telegramUserId: ctx.msg.reply_to_message.from.id.toString(),
        [operation]: 1,
        fromMessage: await db.query.messages
          .findFirst({
            where: eq(
              messages.telegramId,
              ctx.msg.reply_to_message.message_id.toString(),
            ),
          })
          .then((msg) => msg?.id),
        reason: ctx.match,
      })
      .returning()
      .get();

    if (record) {
      const groupMember = await ctx.getChatMember(
        Number(record.telegramUserId),
      );
      const msg = fmt`Awarded ${record[operation] ?? 0} ${operation === "loss" ? "Ls" : "dubs"} to ${groupMember.user.username ?? groupMember.user.first_name}`;
      const sentMessage = await ctx.reply(msg.text, {
        reply_parameters: {
          message_id: ctx.msg.message_id,
        },
        entities: msg.entities,
      });
      await db.update(guss).set({
        sentMessage: sentMessage.message_id.toString(),
      });
    }
  } else {
    record = await db.select().from(guss).orderBy(desc(guss.created)).get();
    if (record) {
      record = await db
        .update(guss)
        .set({
          [operation]: sql`${guss[operation]} + 1`,
        })
        .where(eq(guss.id, record.id))
        .returning()
        .get();

      const groupMember = await ctx.getChatMember(
        Number(record.telegramUserId),
      );
      const totalScore = (record.win ?? 0) - (record.loss ?? 0);
      const msg = fmt([
        `Awarded ${record[operation] ?? 0} ${operation === "loss" ? "Ls" : "dubs"} to `,
        `${groupMember.user.username ?? groupMember.user.first_name}`,
        `\nCurrent score: ${Math.abs(totalScore)} ${totalScore < 0 ? "Ls" : totalScore > 0 ? "Ws" : ""}`,
      ]);
      await ctx.api.editMessageText(
        ctx.chat.id,
        Number(record.sentMessage),
        msg.text,
        {
          entities: msg.entities,
        },
      );
    }
  }

  await next();
});

devChatGroup.command(["scoreboard", "score"], async (ctx, next) => {
  const players = await db
    .select({
      userId: guss.telegramUserId,
      loss: sql<number>`IFNULL(SUM(${guss.loss}), 0)`.mapWith(Number),
      win: sql<number>`IFNULL(SUM(${guss.win}), 0)`.mapWith(Number),
    })
    .from(guss)
    .groupBy(sql`${guss.telegramUserId}`);

  const message: FormattedString[] = [fmt`${bold("SCOREBOARD")}`];

  if (players.length === 0) {
    message.push(fmt`\n`);
    message.push(fmt`\n`);
    message.push(fmt`Nobody wants to play :(`);
  }

  for (const player of players) {
    const groupMember = await ctx.getChatMember(Number(player.userId));
    message.push(fmt`\n`);
    message.push(fmt`\n`);
    message.push(
      fmt`${underline(groupMember.user.username ?? groupMember.user.first_name)}`,
    );
    message.push(fmt`\n- ${player.win} Ws`);
    message.push(fmt`\n- ${player.loss} Ls`);
    message.push(fmt`\nTotal score: ${player.win - player.loss}`);
  }

  const messageCombined = fmt(message);

  await ctx.reply(messageCombined.text, {
    entities: messageCombined.entities,
    reply_parameters: {
      message_id: ctx.msg.message_id,
      allow_sending_without_reply: true,
    },
  });

  await next();
});

await bot.api.setMyCommands(
  [
    { command: "l", description: "Award loss" },
    { command: "w", description: "Award win" },
    { command: "scoreboard", description: "Show scoreboard" },
  ],
  {
    scope: { type: "chat", chat_id: Env.TELEGRAM_DEV_CHAT_CHAT_ID },
  },
);

// regularGroups
//   .chatType(["group", "supergroup"])
//   .on("message:entities:mention")
//   .branch(
//     (ctx) =>
//       ctx
//         .entities("mention")
//         .findIndex((entity) => entity.text === "@raphgptbot") > -1,
//     async (ctx, next) => {
//       await next();
//     },
//     async (ctx, next) => {
//       await next();
//     }
//   );

// regularGroups
//   .chatType(["group", "supergroup"])
//   .on("message", async (ctx, next) => {
//     await next();
//   });

await bot.api.setMyCommands([
  { command: "start", description: "Start the bot" },
]);

bot.catch((err) => {
  const ctx = err.ctx;

  console.error(`Error while handling update: ${ctx.update.update_id}`);

  if (err.error instanceof GrammyError) {
    console.error("Error in request:", err.error.description);
  } else if (err.error instanceof HttpError) {
    console.error("Could not contact Telegram:", err.error);
  } else {
    console.error("Unknown error:", err.error);
  }
});

const handle = run(bot);

await handle.task();
