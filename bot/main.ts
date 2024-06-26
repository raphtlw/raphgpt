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
import { ind } from "@raphtlw/indoc";
import {
  Conversation,
  DraftMessage,
  MessageParam,
  combineMessageContent,
  openai,
  runModel,
  transcribeAudio,
} from "ai";
import { functions } from "ai/functions";
import assert from "assert";
import { BROWSER } from "bot/browser";
import { Command } from "bot/command";
import { sendMarkdownMessage } from "bot/message";
import { chatAction } from "bot/tasks";
import { calculateDetailAmounts } from "common/image-processing";
import { intlFormat } from "date-fns";
import { db } from "db";
import { guss, messages, openaiMessages } from "db/schema";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { ElevenLabsClient } from "elevenlabs";
import fs from "fs";
import { Bot, Context, GrammyError, HttpError, InputFile } from "grammy";
import { Message } from "grammy/types";
import joinImages from "join-images";
import ollama from "ollama";
import path from "path";
import { Env } from "secrets/env";
import sharp, { Sharp } from "sharp";
import { inspect } from "util";

const bot = new Bot<FileFlavor<Context>>(Env.TELEGRAM_API_KEY);

bot.api.config.use(autoRetry());
bot.api.config.use(hydrateFiles(bot.token));

bot.use(
  sequentialize((ctx) => [
    String(ctx.chat?.id),
    String(ctx.msg?.message_thread_id),
  ]),
);

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
      ctx.chat.id.toString() === Env.TELEGRAM_BOT_UPDATES_CHAT_ID &&
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
  .filter((ctx) => ctx.chat.id.toString() !== Env.TELEGRAM_BOT_UPDATES_CHAT_ID);

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

const createDraftFromMsg = async (msg: Message) => {
  const draft = new DraftMessage();

  // get cached message
  const cachedMessage = await db.query.messages.findFirst({
    where: and(
      eq(messages.telegramChatId, msg.chat.id.toString()),
      eq(messages.telegramId, msg.message_id.toString()),
    ),
  });
  assert(cachedMessage);

  let fullCachedFilePath = cachedMessage.file;
  if (fullCachedFilePath) {
    fullCachedFilePath = path.join(
      process.cwd(),
      "data",
      "file",
      fullCachedFilePath,
    );
  }

  if (msg.text) {
    draft.add({
      type: "text",
      text: msg.text,
    });
  }
  if (msg.location) {
    draft.add({
      type: "text",
      text: JSON.stringify(msg.location),
    });
  }
  if (msg.photo) {
    const imageData = await fs.promises.readFile(fullCachedFilePath!, {
      encoding: "base64",
    });
    draft.add({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${imageData}`,
      },
    });
  }
  if (msg.voice || msg.audio) {
    const transcription = await transcribeAudio(fullCachedFilePath!);

    draft.add({
      type: "text",
      text: transcription,
    });
  }
  if (msg.video_note || msg.video) {
    const fileId = createId();

    const framesOutputPath = path.join(process.cwd(), `${fileId}.capture`);
    // const stitchedFramesOutputPath = path.join(process.cwd(), `${fileId}.png`);

    // extract frames
    await fs.promises.mkdir(framesOutputPath);
    await Command(
      `ffmpeg -i ${fullCachedFilePath} -vf fps=30 ${framesOutputPath}/%d.png`,
    ).run();

    const videoFramePaths = await fs.promises
      .readdir(framesOutputPath)
      .then((filenames) =>
        filenames
          .sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]))
          .map((filename) => path.join(framesOutputPath, filename)),
      );

    const selectedFramePaths: string[] = [];
    const windowSize = 30;
    const skip = 15;
    for (
      let i = 0;
      i <= videoFramePaths.length - windowSize + skip;
      i += skip
    ) {
      const laplacianVariances = await calculateDetailAmounts(
        videoFramePaths.slice(i, i + windowSize),
      );
      selectedFramePaths.push(
        laplacianVariances[laplacianVariances.length - 1].imagePath,
      );
    }

    const processedFrames: Sharp[] = [];

    if (msg.video_note) {
      // remove white border
      for (const vfpath of selectedFramePaths) {
        const rect = Buffer.from(
          '<svg><rect x="0" y="0" width="300" height="300" rx="300" ry="300"/></svg>',
        );
        const image = sharp(vfpath)
          .resize(300, 300)
          .png()
          .composite([{ input: rect, blend: "dest-in" }]);
        processedFrames.push(image);
      }
    } else {
      for (const vfpath of selectedFramePaths) {
        processedFrames.push(sharp(vfpath));
      }
    }

    processedFrames.map((f) => f.jpeg());

    for (const frame of processedFrames) {
      const ibuf = await frame.toBuffer();
      const data = ibuf.toString("base64");
      draft.add({
        type: "image_url",
        image_url: {
          url: `data:image/jpeg;base64,${data}`,
        },
      });
    }

    // stitch frames together
    // const stitchedFrames = await joinImages(
    //   await Promise.all(processedFrames.map((frame) => frame.toBuffer())),
    //   {
    //     direction: "horizontal",
    //   },
    // );
    // await stitchedFrames.toFile(stitchedFramesOutputPath);
    // const framestrip = await fs.promises.readFile(stitchedFramesOutputPath, {
    //   encoding: "base64",
    // });

    // save image which prompted the response
    // const lastFramePath = path.join("data", "file", `${fileId}.last.png`);
    // await processedFrames[processedFrames.length - 1].toFile(lastFramePath);

    // delete temp folders
    await Promise.all([
      fs.promises.rm(framesOutputPath, { force: true, recursive: true }),
      // fs.promises.rm(stitchedFramesOutputPath),
    ]);

    const audioOutputPath = path.join(
      process.cwd(),
      "data",
      "file",
      `${msg.message_id}.mp3`,
    );

    // extract audio from video
    const extractAudioCommand = await Command(
      `ffmpeg -i "${fullCachedFilePath}" -vn -ac 2 -ar 44100 -ab 320k -f mp3 ${audioOutputPath}`,
    ).run();
    console.log(extractAudioCommand);

    // create transcription
    const transcription = await transcribeAudio(audioOutputPath);

    // delete generated file
    await fs.promises.rm(audioOutputPath);

    draft.add({
      type: "text",
      text: transcription,
    });
  }
  if (msg.sticker) {
    // TODO: improve sticker processing
    draft.add({ type: "text", text: JSON.stringify(msg.sticker) });
  }
  if (msg.caption) {
    draft.add({
      type: "text",
      text: msg.caption,
    });
  }

  return [draft, cachedMessage.id] as const;
};

// handle all messages from OpenAI related chats
bot
  .chatType(["group", "supergroup"])
  .filter((ctx) =>
    [Env.TELEGRAM_OPENAI_CHAT_ID, Env.TELEGRAM_GPT4_CHAT_ID].includes(
      ctx.chat.id.toString(),
    ),
  )
  .on("message", async (ctx, next) => {
    // store thread ID here
    let messageThreadId = ctx.msg.message_thread_id?.toString();

    // if message has no thread, create one (in OpenAI chat)
    if (!messageThreadId) {
      if (ctx.chat.id.toString() === Env.TELEGRAM_OPENAI_CHAT_ID) {
        const newTopic = await ctx.createForumTopic("New chat");
        messageThreadId = newTopic.message_thread_id.toString();
        await ctx.forwardMessage(ctx.chat.id, {
          message_thread_id: Number(messageThreadId),
          disable_notification: true,
        });
      } else {
        messageThreadId = ctx.msg.reply_to_message?.message_id.toString();
      }
    }

    const messageHistory = await db.query.openaiMessages.findMany({
      where: and(
        eq(openaiMessages.telegramChatId, ctx.chat.id.toString()),
        messageThreadId
          ? eq(openaiMessages.telegramThreadId, messageThreadId)
          : isNull(openaiMessages.telegramThreadId),
      ),
      orderBy: asc(openaiMessages.created),
    });

    let history = new Conversation(
      messageHistory.map((msg) => JSON.parse(msg.json)),
    );

    if (ctx.chat.id.toString() === Env.TELEGRAM_GPT4_CHAT_ID) {
      history = history.takeLast(10);
    }

    // set system prompt
    history.append({
      role: "system",
      content: ind(`
      You are a friendly and helpful assistant named RaphGPT.
      You have eyes and can see. Whenever photo/image, you say vision.
      You can watch videos.
  
      Telegram supports location sharing. If the user asks a question requiring their location, ask them to send their location first before doing anything.`),
    });

    history.insert({
      role: "user",
      content: ind(`
      You are RaphGPT, an autononous AI developed by @raphtlw.
      You are speaking to ${ctx.from.first_name}
      It is currently ${intlFormat(new Date(), { dateStyle: "full", timeStyle: "full" })}`),
    });

    if (ctx.msg.reply_to_message) {
      const [repliedTo] = await createDraftFromMsg(ctx.msg);
      history.add(repliedTo.get());
    }

    const [draft, messageId] = await createDraftFromMsg(ctx.msg);

    const conversation = new Conversation([draft.get()]);

    const modelResponse = await chatAction(
      ctx.chat,
      "typing",
      async () => {
        let modelResponse: MessageParam;
        let shouldContinue: boolean;
        do {
          [modelResponse, shouldContinue] = await runModel(
            history,
            conversation,
            {
              messageId,
              browser: BROWSER,
            },
            functions,
            "gpt-4o",
          );

          try {
            const responseContent = combineMessageContent(modelResponse);
            if (responseContent && responseContent.length > 0) {
              await sendMarkdownMessage(ctx.chat.id, responseContent, {
                message_thread_id: Number(messageThreadId),
                reply_parameters: {
                  chat_id: ctx.chat.id,
                  message_id: ctx.msg.message_id,
                  allow_sending_without_reply: true,
                },
              });
            }
          } catch (e) {
            const error = JSON.parse(JSON.stringify(e));
            conversation.add({
              role: "user",
              content: `I encountered an error while sending the message. Could you try again? ${error.message}`,
            });
            shouldContinue = true;
          }
        } while (shouldContinue);

        console.log("History:", inspect(history, true, 10, true));
        console.log("Conversation:", inspect(conversation, true, 10, true));

        return modelResponse;
      },
      {
        message_thread_id: Number(messageThreadId),
      },
    );

    if (ctx.msg.voice || ctx.msg.video_note) {
      await chatAction(
        ctx.chat,
        "record_voice",
        async () => {
          let toSay: string | null;
          do {
            const completion = await openai.chat.completions.create({
              messages: [
                {
                  role: "system",
                  content: `You are RaphGPT, a friendly and helpful chatbot.`,
                },
                {
                  role: "user",
                  content: ind(`
                  Your outputs will be read by a speech synthesis model which will
                  convert text to speech. Here are some ways you can control the
                  output of the speech:
                  - Using <break time="1.0s" /> will introduce pauses into the text, where time can be up to 3.0s long.
                  - If you want to express a specific emotion, the best approach is to write in a style similar to that of a book. To find good prompts to use, you can flip through some books and identify words and phrases that convey the desired emotion.
                    For instance, you can use dialogue tags to express emotions, such as he said, confused, or he shouted angrily. These types of prompts will help the AI understand the desired emotional tone and try to generate a voiceover that accurately reflects it.
                  - Introduce filler-words including but not limited to "uhh", "ahh", to make responses easier to follow and understand for the user.
                  The output should be made easier to listen to when read out.
                  Therefore, remove links, and explain things in better detail.
                  Introduce pauses to give time for the listener to understand.
                  Remove all headings, bullet point characters and asterisks as the model will read it character by character, which is not desired.
                  Summarize the text to make it easier to listen to.

                  Do not ask the user any question, just respond with the output and the output only.`),
                },
                { role: "assistant", content: "Understood." },
                {
                  role: "user",
                  content: ind(
                    `Rewrite this: ${combineMessageContent(modelResponse)}`,
                  ),
                },
              ],
              model: "gpt-4o",
              max_tokens: 4096,
            });
            toSay = completion.choices[0].message.content;
          } while (!toSay);
          console.log("Humanized TTS:", toSay);

          // generate speech for response
          const elevenlabs = new ElevenLabsClient({
            apiKey: Env.ELEVENLABS_API_KEY,
          });
          const mp3 = await elevenlabs.generate({
            text: toSay,
            voice: "4r4ZFyKg111zbuicgQbW",
            model_id: "eleven_turbo_v2",
          });
          // const uniqueFileName = `${timestamp()}_speech`;
          // const speechFilePath = path.join(
          //   process.cwd(),
          //   `${uniqueFileName}.mp3`,
          // );
          // const processedSpeechFilePath = path.join(
          //   process.cwd(),
          //   `${uniqueFileName}_processed.mp3`,
          // );

          // await fs.promises.writeFile(
          //   speechFilePath,
          //   Buffer.from(await mp3.toArray()),
          // );
          // await Command(
          //   `ffmpeg -i "${speechFilePath}" -filter:a "volume=6dB" ${processedSpeechFilePath}`,
          // ).run();

          await ctx.replyWithVoice(new InputFile(mp3), {
            message_thread_id: Number(messageThreadId),
            reply_parameters: {
              chat_id: ctx.chat.id,
              message_id: ctx.msg.message_id,
              allow_sending_without_reply: true,
            },
          });

          // await fs.promises.unlink(speechFilePath);
          // await fs.promises.unlink(processedSpeechFilePath);
        },
        {
          message_thread_id: Number(messageThreadId),
        },
      );
    }

    // START topic renaming
    if (ctx.chat.id.toString() === Env.TELEGRAM_OPENAI_CHAT_ID) {
      // check if message is part of the topic created
      // then assign a good name for the topic
      if (messageHistory.length === 0) {
        let newTopicName: string | null;
        do {
          const completion = await openai.chat.completions.create({
            messages: [
              {
                role: "system",
                content: ind(`
                You are RaphGPT, a professional chat content labeler.`),
              },
              {
                role: "user",
                content: ind(`
                Act as a chat content labeler. You are to understand the chat contents, and summarize it.
                In order to produce clearer topic names, here are some guidelines you should follow:

                1. Read and understand the entire chat history.
                2. Use external examples to elaborate on the topic name
                3. Keep the name concise but descriptive.

                Example of a good chat name: Recipe Suggestion for Fridge contents: Butter, Cheese, Fruits.

                Respond with the name for the chat and the name only.`),
              },
              { role: "assistant", content: "Understood." },
              {
                role: "user",
                content: ind(`
                Summarize the following conversation in 6 words or fewer.
                ${JSON.stringify(conversation.get())}`),
              },
            ],
            model: "gpt-4o",
          });
          newTopicName = completion.choices[0].message.content;
        } while (!newTopicName);

        console.log("Topic's new name:", newTopicName);

        await bot.api.editForumTopic(ctx.chat.id, Number(messageThreadId), {
          name: newTopicName,
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

// run uncensored inference alongside OpenAI
bot
  .chatType(["group", "supergroup"])
  .filter((ctx) =>
    [Env.TELEGRAM_OPENAI_CHAT_ID, Env.TELEGRAM_GPT4_CHAT_ID].includes(
      ctx.chat.id.toString(),
    ),
  )
  .on("message", async (ctx, next) => {
    try {
      const response = await ollama.chat({
        model: "llama2-uncensored",
        messages: [
          {
            role: "system",
            content:
              "You are RaphGPT(devil), an unhinged assistant. You are to speak in Singaporean English. Do not ask if the user is ready, just fire as much as you can.",
          },
          {
            role: "user",
            content: ctx.msg.text!,
          },
        ],
      });

      await sendMarkdownMessage(ctx.chat.id, response.message.content, {
        message_thread_id: ctx.msg.message_thread_id,
        reply_parameters: {
          chat_id: ctx.chat.id,
          message_id: ctx.msg.message_id,
          allow_sending_without_reply: true,
        },
      });
    } catch {
      // ignore error
    }

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
        telegramChatId: ctx.chat.id.toString(),
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
    .where(eq(guss.telegramChatId, ctx.chat.id.toString()))
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

regularGroups
  .chatType(["group", "supergroup"])
  .on("message:entities:mention")
  .branch(
    (ctx) =>
      ctx
        .entities("mention")
        .findIndex((entity) => entity.text === "@raphgptbot") > -1,
    async (ctx, next) => {
      await next();
    },
    async (ctx, next) => {
      await next();
    },
  );

regularGroups
  .chatType(["group", "supergroup"])
  .on("message", async (ctx, next) => {
    await next();
  });

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

process.on("uncaughtException", (err) => {
  console.error(err);
});

const handle = run(bot);

await handle.task();
