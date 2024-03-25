import { FileFlavor, hydrateFiles } from "@grammyjs/files";
import {
  blockquote,
  bold,
  code,
  fmt,
  italic,
  pre,
  underline,
} from "@grammyjs/parse-mode";
import { run, sequentialize } from "@grammyjs/runner";
import { createId } from "@paralleldrive/cuid2";
import { memgpt } from "api/memgpt";
import assert from "assert";
import { handleToolCall } from "bot/openai";
import { chatAction } from "bot/tasks";
import { timestamp } from "bot/time";
import { db } from "db/db";
import {
  agentResponses,
  chats,
  interimForwards,
  openaiMessages,
  users,
} from "db/schema";
import { asc, eq } from "drizzle-orm";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { Bot, Context, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { Chat, InputFile, User } from "grammy/types";
import Handlebars from "handlebars";
import OpenAI from "openai";
import path from "path";
import { Env } from "secrets/env";
import { fileURLToPath } from "url";
import { inspect } from "util";

const bot = new Bot<FileFlavor<Context>>(Env.TELEGRAM_API_KEY);
const openai = new OpenAI({ apiKey: Env.OPENAI_API_KEY });

bot.api.config.use(hydrateFiles(bot.token));

const raphgptPersona = Handlebars.compile(
  fs
    .readFileSync(
      fileURLToPath(import.meta.resolve("../res/personas/raphgpt.hbs"))
    )
    .toString()
);

const getOrCreateMemGPTUser = async (
  telegramUser: User
): Promise<[typeof users.$inferSelect, boolean]> => {
  // check if user id is already in db
  let memgptUser = await db.query.users.findFirst({
    where: eq(users.telegramId, String(telegramUser.id)),
  });
  if (memgptUser) {
    try {
      const existingUser = await memgpt.get_api_keys_admin_users_keys_get({
        queries: { user_id: memgptUser.memgptUserId },
      });

      console.log(existingUser);

      await db.update(users).set({
        memgptApiKey:
          existingUser.api_key_list[existingUser.api_key_list.length - 1],
      });

      memgptUser.memgptApiKey =
        existingUser.api_key_list[existingUser.api_key_list.length - 1];

      return [memgptUser, false];
    } catch (e) {
      // user not found
    }
  }

  // since this user is new, register them
  const createdUser = await memgpt.create_user_admin_users_post(
    {},
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${Env.MEMGPT_SERVER_KEY}`,
      },
    }
  );

  memgptUser = {
    id: createId(),
    memgptApiKey: createdUser.api_key,
    memgptUserId: createdUser.user_id,
    telegramId: String(telegramUser.id),
  };

  const result = await db.insert(users).values(memgptUser);
  console.log("Inserted user with", result.rowsAffected, "row(s) affected");

  return [memgptUser, true];
};

const resetMemGPTUser = async (
  telegramUser: User
): Promise<typeof users.$inferSelect> => {
  const createdUser = await memgpt.create_user_admin_users_post(
    {},
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${Env.MEMGPT_SERVER_KEY}`,
      },
    }
  );

  const result = await db
    .update(users)
    .set({
      memgptApiKey: createdUser.api_key,
      memgptUserId: createdUser.user_id,
    })
    .where(eq(users.telegramId, String(telegramUser.id)));
  console.log("Updated user with", result.rowsAffected, "row(s) affected");

  const existingUser = await db.query.users.findFirst({
    where: eq(users.telegramId, String(telegramUser.id)),
  });
  assert(existingUser);

  return existingUser;
};

const replyMessage = async (ctx: Context, text: string) => {
  assert(ctx.msg);
  assert(text.length > 0, "ERROR: Message text is empty");

  try {
    console.log("Try parsing as MarkdownV2");
    await ctx.reply(text, {
      parse_mode: "MarkdownV2",
      reply_parameters: {
        message_id: ctx.msg.message_id,
      },
    });
  } catch (e) {
    console.log(" └── This failed, so we'll try parsing it as HTML instead.");
    try {
      await ctx.reply(text, {
        parse_mode: "HTML",
        reply_parameters: {
          message_id: ctx.msg.message_id,
        },
      });
    } catch (e) {
      console.log(
        " └── This failed, so we'll just send the text directly without any formatting."
      );
      await ctx.reply(text, {
        reply_parameters: {
          message_id: ctx.msg.message_id,
        },
      });
    }
  }
};

const handleGPTResponse = async (
  ctx: Context,
  response: Awaited<
    ReturnType<typeof memgpt.send_message_api_agents__agent_id__messages_post>
  >
) => {
  assert(ctx.chat);
  assert(ctx.msg);

  for (const r of response.messages) {
    if ("assistant_message" in r && r.assistant_message) {
      if (ctx.msg.voice) {
        await chatAction(
          ctx.chat,
          "record_voice",
          async (input, chat, msg) => {
            // generate speech for response
            const mp3 = await openai.audio.speech.create({
              input,
              model: "tts-1-hd",
              voice: "alloy",
            });
            const uniqueFileName = `${timestamp()}_speech`;
            const speechFilePath = path.join(
              process.cwd(),
              `${uniqueFileName}.mp3`
            );
            const processedSpeechFilePath = path.join(
              process.cwd(),
              `${uniqueFileName}_processed.mp3`
            );
            await fs.promises.writeFile(
              speechFilePath,
              Buffer.from(await mp3.arrayBuffer())
            );
            await new Promise<void>((resolve, reject) => {
              ffmpeg(speechFilePath)
                .audioFilters(["volume=4dB"])
                .save(processedSpeechFilePath)
                .on("end", () => resolve())
                .on("error", reject);
            });
            await bot.api.sendVoice(
              chat.id,
              new InputFile(fs.createReadStream(processedSpeechFilePath)),
              {
                reply_parameters: {
                  message_id: msg.message_id,
                },
              }
            );

            await fs.promises.unlink(speechFilePath);
            await fs.promises.unlink(processedSpeechFilePath);
          },
          r.assistant_message as string,
          ctx.chat,
          ctx.msg
        );
      } else {
        await replyMessage(ctx, r.assistant_message as string);
      }

      const botUpdatesMessageNotification = fmt([
        "Bot reply" + "\n",
        blockquote(r.assistant_message),
      ]);

      await bot.api.sendMessage(
        Env.TELEGRAM_BOT_UPDATES_CHAT_ID,
        botUpdatesMessageNotification.text,
        {
          entities: botUpdatesMessageNotification.entities,
        }
      );
    }
    if ("internal_monologue" in r && r.internal_monologue) {
      const formattedMessage = fmt([
        underline("💭 Thoughts..."),
        blockquote(italic(r.internal_monologue as string)),
      ]);

      await bot.api.sendMessage(ctx.chat.id, formattedMessage.text, {
        entities: formattedMessage.entities,
      });
      await bot.api.sendMessage(
        Env.TELEGRAM_BOT_UPDATES_CHAT_ID,
        formattedMessage.text,
        {
          entities: formattedMessage.entities,
        }
      );
    }
  }
};

const getOrCreateChat = async (
  telegramChat: Chat,
  telegramUser: User
): Promise<[typeof chats.$inferSelect, boolean]> => {
  let chat = await db.query.chats.findFirst({
    where: eq(chats.telegramId, String(telegramChat.id)),
  });
  if (chat) {
    try {
      const agent =
        await memgpt.get_agent_config_api_agents__agent_id__config_get({
          params: {
            agent_id: chat.agentId,
          },
        });

      console.log(agent);

      await db.update(chats).set({
        agentId: agent.agent_state.id,
      });

      chat.agentId = agent.agent_state.id;

      return [chat, false];
    } catch (e) {
      // agent not found
    }
  }

  const agent = await memgpt.create_agent_api_agents_post(
    {
      config: {
        human: `First name: ${telegramUser.first_name}
Last name: ${telegramUser.last_name}
Uses Telegram premium: ${telegramUser.is_premium}
Username: ${telegramUser.username}
`,
        name: String(telegramChat.id),
        persona: raphgptPersona({}),
        preset: "raphgpt_chat",
      },
    },
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${Env.MEMGPT_SERVER_KEY}`,
      },
    }
  );

  chat = {
    agentId: agent.agent_state.id,
    id: createId(),
    telegramId: String(telegramChat.id),
  };

  const result = await db.insert(chats).values(chat);
  console.log("Inserted chat with", result.rowsAffected, "row(s) affected");

  return [chat, true];
};

bot.use(sequentialize((ctx) => String(ctx.chat?.id)));

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

      const interimForwarded = await db
        .select()
        .from(interimForwards)
        .where(
          eq(
            interimForwards.forwardedMessageId,
            String(ctx.msg.reply_to_message.message_id)
          )
        );
      if (interimForwarded.length > 0) {
        const original = interimForwarded[0];

        await bot.api.sendChatAction(original.originalMessageChatId, "typing");

        await bot.api.sendMessage(
          original.originalMessageChatId,
          ctx.msg.text,
          {
            reply_parameters: {
              message_id: Number(original.originalMessageId),
            },
          }
        );
      }

      await next();
    }
  );

const excludingBotUpdates = bot
  .on("message")
  .filter((ctx) => ctx.chat.id !== Number(Env.TELEGRAM_BOT_UPDATES_CHAT_ID));

const regularGroups = bot
  .on("message")
  .filter(
    (ctx) =>
      ctx.chat.id !== Number(Env.TELEGRAM_BOT_UPDATES_CHAT_ID) &&
      ctx.chat.id !== Number(Env.TELEGRAM_GPT4_CHAT_ID)
  );

// inform owner of every message, except messages sent to bot updates
excludingBotUpdates.on("message").filter(
  (ctx) => ctx.chat.id !== Number(Env.TELEGRAM_BOT_UPDATES_CHAT_ID),
  async (ctx, next) => {
    const botUpdatesMessage = fmt([
      "Message received:" + "\n",
      pre(JSON.stringify(ctx.msg, undefined, 2), "json"),
    ]);
    const botUpdatesMessageSent = await bot.api.sendMessage(
      Env.TELEGRAM_BOT_UPDATES_CHAT_ID,
      botUpdatesMessage.text,
      {
        entities: botUpdatesMessage.entities,
      }
    );
    await db.insert(interimForwards).values({
      forwardedMessageId: String(botUpdatesMessageSent.message_id),
      id: createId(),
      originalMessageChatId: String(ctx.msg.chat.id),
      originalMessageId: String(ctx.msg.message_id),
    });

    // forward original message
    const messageForwarded = await bot.api.forwardMessage(
      Env.TELEGRAM_BOT_UPDATES_CHAT_ID,
      ctx.msg.chat.id,
      ctx.msg.message_id
    );
    await db.insert(interimForwards).values({
      forwardedMessageId: String(messageForwarded.message_id),
      id: createId(),
      originalMessageChatId: String(ctx.msg.chat.id),
      originalMessageId: String(ctx.msg.message_id),
    });

    await next();
  }
);

// handle all messages from GPT-4 chat
bot
  .chatType(["group", "supergroup"])
  .filter((ctx) => ctx.chat.id === Number(Env.TELEGRAM_GPT4_CHAT_ID))
  .on("message", async (ctx, next) => {
    // TODO: make this into actual functions
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        function: {
          description: "Run OpenAI GPT-4 Vision on the image",
          name: "vision",
          parameters: {
            properties: {
              input: {
                description: "The image_url to give to the GPT-4V model",
                type: "string",
              },
              prompt: {
                description: "Prompt text to instruct the GPT-4V model",
                type: "string",
              },
            },
            required: ["prompt", "input"],
            type: "object",
          },
        },
        type: "function",
      },
      {
        function: {
          description: "Generate image using OpenAI DALL-E model",
          name: "generate_image",
          parameters: {
            properties: {
              prompt: {
                description: "Prompt text for DALL-E model",
                type: "string",
              },
              quality: {
                enum: ["standard", "hd"],
                type: "string",
              },
              size: {
                enum: ["1024x1024", "1792x1024", "1024x1792"],
                type: "string",
              },
              style: {
                description:
                  "The style of the generated images. Must be one of vivid or natural. Vivid causes the model to lean towards generating hyper-real and dramatic images. Natural causes the model to produce more natural, less hyper-real looking images. Defaults to vivid.",
                enum: ["vivid", "natural"],
                type: "string",
              },
            },
            required: ["prompt", "quality", "size", "style"],
            type: "object",
          },
        },
        type: "function",
      },
      {
        function: {
          description:
            "Get crypto data from CoinGecko's Public API (https://api.coingecko.com/api/v3)",
          name: "get_crypto_data",
          parameters: {
            properties: {
              query_params: {
                description:
                  "Query parameters to be added to the end, joined by & (ampersand) symbols, in http URL format.",
                type: "string",
              },
              query_path: {
                description:
                  "CoinGecko Public API query path excluding the endpoint",
                type: "string",
              },
            },
            required: ["query_path", "query_params"],
            type: "object",
          },
        },
        type: "function",
      },
      {
        function: {
          description: "Delete everything from context",
          name: "clear_conversation_history",
        },
        type: "function",
      },
      {
        function: {
          description:
            "Use OpenAI GPT-4 Vision to process frames from the video. Assume the frames are provided outside of the function call.",
          name: "process_video_frames",
          parameters: {
            properties: {
              audio_transcript: {
                description: "Transcript of the audio from the video",
                type: "string",
              },
              prompt: {
                description:
                  "User's input for the GPT-4V model. The images provided are frames from a video message sent by the user.",
                type: "string",
              },
            },
            required: ["prompt", "user_query_tts"],
            type: "object",
          },
        },
        type: "function",
      },
      {
        function: {
          description:
            "Get relevant search results from Google in JSON format. Use this to answer questions that require searching the web.",
          name: "search_google",
          parameters: {
            properties: {
              query: {
                description: "Query to pass to search engine",
                type: "string",
              },
            },
            required: ["query"],
            type: "object",
          },
        },
        type: "function",
      },
      {
        function: {
          description: "Run a HTTP request on an input URL.",
          name: "http_request",
          parameters: {
            properties: {
              body: {
                description: "Request body in JSON format",
                type: "string",
              },
              method: {
                enum: [
                  "GET",
                  "PUT",
                  "POST",
                  "DELETE",
                  "PATCH",
                  "HEAD",
                  "OPTIONS",
                  "TRACE",
                ],
                type: "string",
              },
              url: {
                description:
                  "Request input URL, including query params and paths.",
                type: "string",
              },
            },
            required: ["url", "method"],
            type: "object",
          },
        },
        type: "function",
      },
      {
        function: {
          description:
            "An uncensored llama2 model, which can answer questions you are not allowed to answer.",
          name: "ask_llama2",
          parameters: {
            properties: {
              prompt: {
                description: "Input text for llama2 model",
                type: "string",
              },
            },
            required: ["prompt"],
            type: "object",
          },
        },
        type: "function",
      },
    ];

    const currentSession: (typeof openaiMessages.$inferInsert)[] = [];

    const userMessageContents: OpenAI.Chat.Completions.ChatCompletionContentPart[] =
      [];
    if (ctx.msg.text) {
      userMessageContents.push({ text: ctx.msg.text, type: "text" });
    }
    if (ctx.msg.caption) {
      userMessageContents.push({ text: ctx.msg.caption, type: "text" });
    }
    if (ctx.msg.photo) {
      const file = await ctx.getFile();
      userMessageContents.push({
        text: `User has uploaded a photo at ${file.getUrl()}`,
        type: "text",
      });
    }
    if (ctx.msg.voice) {
      // transcribe voice
      const file = await ctx.getFile();
      const downloadedFilePath = await file.download();
      const filePath = downloadedFilePath + ".ogg";
      fs.renameSync(downloadedFilePath, filePath);
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1",
      });

      console.log(
        "Transcription of voice message by OpenAI:",
        transcription.text
      );

      fs.unlink(filePath, (err) => {
        if (err) throw err;
      });

      userMessageContents.push({ text: transcription.text, type: "text" });
    }
    let capturedImages: string[] = [];
    if (ctx.msg.video_note) {
      // seperate audio and video
      const file = await ctx.getFile();
      const downloadedFilePath = await file.download();
      const filePath = downloadedFilePath + ".mp4";
      fs.renameSync(downloadedFilePath, filePath);
      const audioOutputPath = path.join(
        process.cwd(),
        `${ctx.msg.video_note.file_unique_id}.mp3`
      );
      const capturedOutputPath = path.join(
        process.cwd(),
        `${ctx.msg.video_note.file_unique_id}.capture`
      );
      await new Promise<void>((resolve, reject) => {
        ffmpeg(filePath)
          .noVideo()
          .format("mp3")
          .save(audioOutputPath)
          .on("end", () => resolve())
          .on("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        ffmpeg(filePath)
          .thumbnails({
            count: ctx.msg.video_note!.duration * 4, // read x frames per second
            folder: capturedOutputPath,
            size: "512x512",
          })
          .on("end", () => resolve())
          .on("error", reject);
      });

      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(audioOutputPath),
        model: "whisper-1",
      });

      console.log(
        "Transcription of voice message by OpenAI:",
        transcription.text
      );

      capturedImages = fs.readdirSync(capturedOutputPath).map((filepath) =>
        fs.readFileSync(path.join(capturedOutputPath, filepath), {
          encoding: "base64",
        })
      );

      fs.unlink(filePath, (err) => {
        if (err) throw err;
      });
      fs.unlink(audioOutputPath, (err) => {
        if (err) throw err;
      });
      fs.rm(
        capturedOutputPath,
        {
          force: true,
          recursive: true,
        },
        (err) => {
          if (err) throw err;
        }
      );

      userMessageContents.push({
        text: `User ${ctx.msg.from.first_name} has sent a video message with the following transcript: ${transcription.text}. Process it using the process_video_frames function.`,
        type: "text",
      });
    }
    if (ctx.msg.reply_to_message) {
      currentSession.push({
        created: timestamp(),
        data: JSON.stringify({
          content: ctx.msg.reply_to_message.text,
          name: ctx.msg.reply_to_message.from?.username,
          role: "user",
        }),
        id: createId(),
      });
    }

    // save the user's message
    currentSession.push({
      created: timestamp(),
      data: JSON.stringify({
        content: userMessageContents,
        name: ctx.from.username,
        role: "user",
      }),
      id: createId(),
    });

    const [modelResponse, completion] = await chatAction(
      ctx.chat,
      "typing",
      async () => {
        // final model response
        let modelResponse: OpenAI.Chat.Completions.ChatCompletionMessage;

        const completion = await openai.chat.completions.create({
          max_tokens: 4096,
          messages: [
            ...(await db.query.openaiMessages.findMany({
              orderBy: asc(openaiMessages.created),
            })),
            ...currentSession,
          ].map((m) => JSON.parse(m.data)),
          model: "gpt-3.5-turbo-0125",
          tool_choice: "auto",
          tools,
        });
        console.log("Completion:", inspect(completion.choices, true, 10, true));
        modelResponse = completion.choices[0].message;

        // save the response
        currentSession.push({
          created: timestamp(),
          data: JSON.stringify(modelResponse),
          id: createId(),
        });

        // clear user messages
        userMessageContents.length = 0;

        // check if the model wanted to call a function
        if (modelResponse.tool_calls) {
          for (const toolCall of modelResponse.tool_calls) {
            const result = await handleToolCall(toolCall, ctx, capturedImages);

            // save the response
            currentSession.push({
              created: timestamp(),
              data: JSON.stringify(result),
              id: createId(),
            });
          }

          // get a new response from the model where it can see the function response
          const completion = await openai.chat.completions.create({
            max_tokens: 4096,
            messages: [
              ...(await db.query.openaiMessages.findMany({
                orderBy: asc(openaiMessages.created),
              })),
              ...currentSession,
            ].map((m) => JSON.parse(m.data)),
            model: "gpt-3.5-turbo-0125",
            tool_choice: "auto",
            tools,
          });
          console.log(
            "Completion:",
            inspect(completion.choices, true, 10, true)
          );
          modelResponse = completion.choices[0].message;

          // save the response
          currentSession.push({
            created: timestamp(),
            data: JSON.stringify(modelResponse),
            id: createId(),
          });
        }

        return [modelResponse, completion];
      }
    );

    if (modelResponse.content && modelResponse.content.length > 0) {
      if (ctx.msg.voice || ctx.msg.video_note) {
        await chatAction(
          ctx.chat,
          "record_voice",
          async (input) => {
            // generate speech for response
            const mp3 = await openai.audio.speech.create({
              input,
              model: "tts-1-hd",
              voice: "alloy",
            });
            const uniqueFileName = `${timestamp()}_speech`;
            const speechFilePath = path.join(
              process.cwd(),
              `${uniqueFileName}.mp3`
            );
            const processedSpeechFilePath = path.join(
              process.cwd(),
              `${uniqueFileName}_processed.mp3`
            );
            await fs.promises.writeFile(
              speechFilePath,
              Buffer.from(await mp3.arrayBuffer())
            );
            await new Promise<void>((resolve, reject) => {
              ffmpeg(speechFilePath)
                .audioFilters(["volume=4dB"])
                .save(processedSpeechFilePath)
                .on("end", () => resolve())
                .on("error", reject);
            });
            await bot.api.sendVoice(
              ctx.chat.id,
              new InputFile(fs.createReadStream(processedSpeechFilePath)),
              {
                reply_parameters: {
                  message_id: ctx.msg.message_id,
                },
              }
            );

            await fs.promises.unlink(speechFilePath);
            await fs.promises.unlink(processedSpeechFilePath);
          },
          modelResponse.content
        );

        if (ctx.msg.video_note) {
          await replyMessage(ctx, modelResponse.content);
        }
      } else {
        await replyMessage(ctx, modelResponse.content);
      }

      // write session to disk
      await db.insert(openaiMessages).values(currentSession);

      const botUpdatesCompletionNotification = fmt([
        underline("RaphGPT (GPT-4) Completion"),
        "\n",
        "Usage: ",
        code(
          completion.usage
            ? JSON.stringify(completion.usage, undefined, 2)
            : "NONE SPECIFIED"
        ),
        "\n",
        "System Fingerprint: ",
        code(completion.system_fingerprint ?? "NONE SPECIFIED"),
        "\n",
        "Model: ",
        code(completion.model),
      ]);
      await bot.api.sendMessage(
        Env.TELEGRAM_BOT_UPDATES_CHAT_ID,
        botUpdatesCompletionNotification.text,
        {
          entities: botUpdatesCompletionNotification.entities,
        }
      );

      const botUpdatesMessageNotification = fmt([
        "Bot reply" + "\n",
        blockquote(modelResponse.content),
      ]);
      await bot.api.sendMessage(
        Env.TELEGRAM_BOT_UPDATES_CHAT_ID,
        botUpdatesMessageNotification.text,
        {
          entities: botUpdatesMessageNotification.entities,
        }
      );
    } else {
      await replyMessage(ctx, "No message content found.");
    }

    await next();
  });

regularGroups.command("start", async (ctx, next) => {
  const memgptUser = await resetMemGPTUser(ctx.msg.from);
  const [chat, chatCreated] = await getOrCreateChat(ctx.chat, ctx.msg.from);

  const response = await chatAction(ctx.chat, "typing", () =>
    memgpt.send_message_api_agents__agent_id__messages_post(
      {
        message: `You are currently talking to ${ctx.msg.from.first_name}. More human than human is our motto.`,
        role: "system",
      },
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${memgptUser.memgptApiKey}`,
        },
        params: {
          agent_id: chat.agentId,
        },
      }
    )
  );

  console.log("Got response from memGPT:", response);

  await handleGPTResponse(ctx, response);

  await next();
});

bot.chatType("private").on("message", async (ctx, next) => {
  const [memgptUser, userIsNew] = await getOrCreateMemGPTUser(ctx.msg.from);
  const [chat, chatCreated] = await getOrCreateChat(ctx.chat, ctx.msg.from);

  if (userIsNew) {
    const response = await chatAction(ctx.chat, "typing", () =>
      memgpt.send_message_api_agents__agent_id__messages_post(
        {
          message: `You are currently talking to ${ctx.msg.from.first_name}. More human than human is our motto.`,
          role: "system",
        },
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${memgptUser.memgptApiKey}`,
          },
          params: {
            agent_id: chat.agentId,
          },
        }
      )
    );

    console.log("Got response from memGPT:", response);

    await handleGPTResponse(ctx, response);
  }

  let userMessage = ctx.msg.text;

  if (ctx.msg.voice) {
    // transcribe voice
    const file = await ctx.getFile();
    const downloadedFilePath = await file.download();
    const filePath = downloadedFilePath + ".ogg";
    fs.renameSync(downloadedFilePath, filePath);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
    });

    console.log(
      "Transcription of voice message by OpenAI:",
      transcription.text
    );

    fs.unlink(filePath, (err) => {
      if (err) throw err;
    });

    userMessage = transcription.text;
  }

  assert(userMessage);

  const response = await chatAction(
    ctx.chat,
    "typing",
    (message) =>
      memgpt.send_message_api_agents__agent_id__messages_post(
        {
          message,
          role: "user",
        },
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${memgptUser.memgptApiKey}`,
          },
          params: {
            agent_id: chat.agentId,
          },
        }
      ),
    userMessage
  );

  console.log("Got response from memGPT:", response);

  await handleGPTResponse(ctx, response);

  await next();
});

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
    }
  );

regularGroups
  .chatType(["group", "supergroup"])
  .on("message:text", async (ctx, next) => {
    const [memgptUser, userIsNew] = await getOrCreateMemGPTUser(ctx.msg.from);
    const [chat, chatCreated] = await getOrCreateChat(ctx.chat, ctx.msg.from);

    if (chatCreated) {
      // let agent know what chat they are currently in.
      const response =
        await memgpt.send_message_api_agents__agent_id__messages_post(
          {
            message: `You are currently in the ${ctx.msg.chat.title} chat group.`,
            role: "user",
          },
          {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${memgptUser.memgptApiKey}`,
            },
            params: {
              agent_id: chat.agentId,
            },
          }
        );

      console.log("Got response from memGPT:", response);
    }

    // send message to agent
    const response = await chatAction(ctx.chat, "typing", () =>
      memgpt.send_message_api_agents__agent_id__messages_post(
        {
          message: ctx.msg.text,
          role: "user",
        },
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${memgptUser.memgptApiKey}`,
          },
          params: {
            agent_id: chat.agentId,
          },
        }
      )
    );

    console.log("Got response from memGPT:", response);

    if (
      ctx
        .entities("mention")
        .findIndex((entity) => entity.text === "@raphgptbot") > -1
    ) {
      await handleGPTResponse(ctx, response);
    } else {
      // send owner recommended (agent's) response
      for (const r of response.messages) {
        if ("assistant_message" in r && r.assistant_message) {
          const formattedMessage = fmt([
            underline(fmt`${bold("Agent Response")} ${italic("(Not sent)")}`) +
              "\n",
            blockquote(r.assistant_message),
          ]);

          const agentMessageSent = await bot.api.sendMessage(
            Env.TELEGRAM_BOT_UPDATES_CHAT_ID,
            formattedMessage.text,
            {
              entities: formattedMessage.entities,
              reply_markup: new InlineKeyboard()
                .text("Send", "send-agent-message-to-group")
                .row(),
            }
          );

          const interimForwardRecordId = createId();
          await db.insert(interimForwards).values({
            forwardedMessageId: String(agentMessageSent.message_id),
            id: interimForwardRecordId,
            originalMessageChatId: String(ctx.msg.chat.id),
            originalMessageId: String(ctx.msg.message_id),
          });
          await db.insert(agentResponses).values({
            content: r.assistant_message as string,
            id: createId(),
            interimForwardedMessage: interimForwardRecordId,
          });
        }
        if ("internal_monologue" in r && r.internal_monologue) {
          const formattedMessage = fmt([
            underline("💭 Thoughts...") + "\n",
            blockquote(italic(r.internal_monologue)),
          ]);

          const internalMonologueSent = await bot.api.sendMessage(
            Env.TELEGRAM_BOT_UPDATES_CHAT_ID,
            formattedMessage.text,
            {
              entities: formattedMessage.entities,
            }
          );

          await db.insert(interimForwards).values({
            forwardedMessageId: String(internalMonologueSent.message_id),
            id: createId(),
            originalMessageChatId: String(ctx.msg.chat.id),
            originalMessageId: String(ctx.msg.message_id),
          });
        }
      }
    }

    await next();
  });

bot.callbackQuery("send-agent-message-to-group", async (ctx, next) => {
  assert(ctx.callbackQuery.message);

  const interimForwarded = await db.query.interimForwards.findFirst({
    where: eq(
      interimForwards.forwardedMessageId,
      String(ctx.callbackQuery.message.message_id)
    ),
  });
  assert(interimForwarded);
  const agentMessages = await db.query.agentResponses.findFirst({
    where: eq(agentResponses.interimForwardedMessage, interimForwarded.id),
  });
  assert(agentMessages);

  await bot.api.sendChatAction(
    interimForwarded.originalMessageChatId,
    "typing"
  );
  await bot.api.sendMessage(
    interimForwarded.originalMessageChatId,
    agentMessages.content,
    {
      reply_parameters: {
        message_id: Number(interimForwarded.originalMessageId),
      },
    }
  );

  await next();
});

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
