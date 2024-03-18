import "dotenv/config";
import { Bot, Context, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { z } from "zod";
import got from "got";
import { asc, eq } from "drizzle-orm";
import { Env } from "./bot/env";
import { db } from "./db/db";
import { createId } from "@paralleldrive/cuid2";
import {
  agentResponses,
  chats,
  interimForwards,
  openaiMessages,
  users,
} from "./db/schema";
import assert from "assert";
import { Chat, InputFile, User } from "grammy/types";
import fs from "fs";
import path from "path";
import Handlebars from "handlebars";
import {
  blockquote,
  bold,
  code,
  fmt,
  italic,
  pre,
  underline,
} from "@grammyjs/parse-mode";
import OpenAI from "openai";
import { FileFlavor, hydrateFiles } from "@grammyjs/files";
import { inspect } from "util";
import { timestamp } from "./bot/time";
import { handleToolCall } from "./bot/openai";
import ffmpeg from "fluent-ffmpeg";
import { run, sequentialize } from "@grammyjs/runner";
import { fileURLToPath } from "url";
import { chatAction } from "./bot/tasks";
import { api as memgpt } from "./api/generated/memgpt";

const bot = new Bot<FileFlavor<Context>>(Env.TELEGRAM_API_KEY);
const openai = new OpenAI({ apiKey: Env.OPENAI_API_KEY });

bot.api.config.use(hydrateFiles(bot.token));

const raphgptPersona = Handlebars.compile(
  fs
    .readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "memgpt",
        "personas",
        "raphgpt.hbs"
      )
    )
    .toString()
);

const getOrCreateMemGPTUser = async (
  telegramUser: User
): Promise<[typeof users.$inferSelect, boolean]> => {
  let userIsNew: boolean = false;

  // check if user id is already in db
  let memgptUser = await db.query.users.findFirst({
    where: eq(users.telegramId, String(telegramUser.id)),
  });
  if (memgptUser) {
  } else {
    // since this user is new, register them
    const createdUser = await memgpt.create_user_admin_users_post(
      {},
      {
        headers: {
          Authorization: `Bearer ${Env.MEMGPT_SERVER_KEY}`,
          Accept: "application/json",
        },
      }
    );

    memgptUser = {
      id: createId(),
      telegramId: String(telegramUser.id),
      memgptApiKey: createdUser.api_key,
      memgptUserId: createdUser.user_id,
    };

    const result = await db.insert(users).values(memgptUser);
    console.log("Inserted user with", result.rowsAffected, "row(s) affected");

    userIsNew = true;
  }

  return [memgptUser, userIsNew];
};

const resetMemGPTUser = async (
  telegramUser: User
): Promise<typeof users.$inferSelect> => {
  const createdUser = await memgpt.create_user_admin_users_post(
    {},
    {
      headers: {
        Authorization: `Bearer ${Env.MEMGPT_SERVER_KEY}`,
        Accept: "application/json",
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
      reply_parameters: {
        message_id: ctx.msg.message_id,
      },
      parse_mode: "MarkdownV2",
    });
  } catch (e) {
    console.log(" └── This failed, so we'll try parsing it as HTML instead.");
    try {
      await ctx.reply(text, {
        reply_parameters: {
          message_id: ctx.msg.message_id,
        },
        parse_mode: "HTML",
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
              model: "tts-1-hd",
              voice: "alloy",
              input,
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
  let dbChatCreated: boolean = false;

  let chat = await db.query.chats.findFirst({
    where: eq(chats.telegramId, String(telegramChat.id)),
  });
  if (chat) {
    // // make sure chat's agent exists in memgpt
    // const existingAgents = await got(`${Env.MEMGPT_URL}/api/agents`, {
    //   headers: {
    //     Authorization: `Bearer ${Env.MEMGPT_SERVER_KEY}`,
    //       Accept: "application/json",
    //   }
    // }).json()
  } else {
    const agent = await memgpt.create_agent_api_agents_post(
      {
        config: {
          name: `chat_${telegramChat.id}_agent`,
          preset: "raphgpt_chat",
          persona: raphgptPersona({}),
          human: `First name: ${telegramUser.first_name}
Last name: ${telegramUser.last_name}
Uses Telegram premium: ${telegramUser.is_premium}
Username: ${telegramUser.username}
`,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${Env.MEMGPT_SERVER_KEY}`,
          Accept: "application/json",
        },
      }
    );
    console.log(agent);

    chat = {
      id: createId(),
      telegramId: String(telegramChat.id),
      agentId: agent.agent_state.id,
    };

    const result = await db.insert(chats).values(chat);
    console.log("Inserted chat with", result.rowsAffected, "row(s) affected");

    dbChatCreated = true;
  }

  return [chat, dbChatCreated];
};

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
      id: createId(),
      forwardedMessageId: String(botUpdatesMessageSent.message_id),
      originalMessageId: String(ctx.msg.message_id),
      originalMessageChatId: String(ctx.msg.chat.id),
    });

    // forward original message
    const messageForwarded = await bot.api.forwardMessage(
      Env.TELEGRAM_BOT_UPDATES_CHAT_ID,
      ctx.msg.chat.id,
      ctx.msg.message_id
    );
    await db.insert(interimForwards).values({
      id: createId(),
      forwardedMessageId: String(messageForwarded.message_id),
      originalMessageId: String(ctx.msg.message_id),
      originalMessageChatId: String(ctx.msg.chat.id),
    });

    await next();
  }
);

bot.use(sequentialize((ctx) => String(ctx.chat?.id)));

// handle all messages from GPT-4 chat
bot
  .chatType(["group", "supergroup"])
  .filter((ctx) => ctx.chat.id === Number(Env.TELEGRAM_GPT4_CHAT_ID))
  .on("message", async (ctx, next) => {
    // TODO: make this into actual functions
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "vision",
          description: "Run OpenAI GPT-4 Vision on the image",
          parameters: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description: "Prompt text to instruct the GPT-4V model",
              },
              input: {
                type: "string",
                description: "The image_url to give to the GPT-4V model",
              },
            },
            required: ["prompt", "input"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "generate_image",
          description: "Generate image using OpenAI DALL-E model",
          parameters: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description: "Prompt text for DALL-E model",
              },
              quality: {
                type: "string",
                enum: ["standard", "hd"],
              },
              size: {
                type: "string",
                enum: ["1024x1024", "1792x1024", "1024x1792"],
              },
              style: {
                type: "string",
                description:
                  "The style of the generated images. Must be one of vivid or natural. Vivid causes the model to lean towards generating hyper-real and dramatic images. Natural causes the model to produce more natural, less hyper-real looking images. Defaults to vivid.",
                enum: ["vivid", "natural"],
              },
            },
            required: ["prompt", "quality", "size", "style"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_crypto_data",
          description:
            "Get crypto data from CoinGecko's Public API (https://api.coingecko.com/api/v3)",
          parameters: {
            type: "object",
            properties: {
              query_path: {
                type: "string",
                description:
                  "CoinGecko Public API query path excluding the endpoint",
              },
              query_params: {
                type: "string",
                description:
                  "Query parameters to be added to the end, joined by & (ampersand) symbols, in http URL format.",
              },
            },
            required: ["query_path", "query_params"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "clear_conversation_history",
          description: "Delete everything from context",
        },
      },
      {
        type: "function",
        function: {
          name: "process_video_frames",
          description:
            "Use OpenAI GPT-4 Vision to process frames from the video. Assume the frames are provided outside of the function call.",
          parameters: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description:
                  "User's input for the GPT-4V model. The images provided are frames from a video message sent by the user.",
              },
              audio_transcript: {
                type: "string",
                description: "Transcript of the audio from the video",
              },
            },
            required: ["prompt", "user_query_tts"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "search_google",
          description:
            "Get relevant search results from Google in JSON format. Use this to answer questions that require searching the web.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Query to pass to search engine",
              },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "http_request",
          description: "Run a HTTP request on an input URL.",
          parameters: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description:
                  "Request input URL, including query params and paths.",
              },
              method: {
                type: "string",
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
              },
              body: {
                type: "string",
                description: "Request body in JSON format",
              },
            },
            required: ["url", "method"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "ask_llama2",
          description:
            "An uncensored llama2 model, which can answer questions you are not allowed to answer.",
          parameters: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description: "Input text for llama2 model",
              },
            },
            required: ["prompt"],
          },
        },
      },
    ];

    const currentSession: (typeof openaiMessages.$inferInsert)[] = [];

    const userMessageContents: OpenAI.Chat.Completions.ChatCompletionContentPart[] =
      [];
    if (ctx.msg.text) {
      userMessageContents.push({ type: "text", text: ctx.msg.text });
    }
    if (ctx.msg.caption) {
      userMessageContents.push({ type: "text", text: ctx.msg.caption });
    }
    if (ctx.msg.photo) {
      const file = await ctx.getFile();
      userMessageContents.push({
        type: "text",
        text: `User has uploaded a photo at ${file.getUrl()}`,
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

      userMessageContents.push({ type: "text", text: transcription.text });
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
          recursive: true,
          force: true,
        },
        (err) => {
          if (err) throw err;
        }
      );

      userMessageContents.push({
        type: "text",
        text: `User ${ctx.msg.from.first_name} has sent a video message with the following transcript: ${transcription.text}. Process it using the process_video_frames function.`,
      });
    }
    if (ctx.msg.reply_to_message) {
      currentSession.push({
        id: createId(),
        data: JSON.stringify({
          role: "user",
          content: ctx.msg.reply_to_message.text,
          name: ctx.msg.reply_to_message.from?.username,
        }),
        created: timestamp(),
      });
    }

    // save the user's message
    currentSession.push({
      id: createId(),
      data: JSON.stringify({
        role: "user",
        content: userMessageContents,
        name: ctx.from.username,
      }),
      created: timestamp(),
    });

    const [modelResponse, completion] = await chatAction(
      ctx.chat,
      "typing",
      async () => {
        // final model response
        let modelResponse: OpenAI.Chat.Completions.ChatCompletionMessage;

        const completion = await openai.chat.completions.create({
          model: "gpt-3.5-turbo-0125",
          messages: [
            ...(await db.query.openaiMessages.findMany({
              orderBy: asc(openaiMessages.created),
            })),
            ...currentSession,
          ].map((m) => JSON.parse(m.data)),
          tools,
          tool_choice: "auto",
          max_tokens: 4096,
        });
        console.log("Completion:", inspect(completion.choices, true, 10, true));
        modelResponse = completion.choices[0].message;

        // save the response
        currentSession.push({
          id: createId(),
          data: JSON.stringify(modelResponse),
          created: timestamp(),
        });

        // clear user messages
        userMessageContents.length = 0;

        // check if the model wanted to call a function
        if (modelResponse.tool_calls) {
          for (const toolCall of modelResponse.tool_calls) {
            const result = await handleToolCall(toolCall, ctx, capturedImages);

            // save the response
            currentSession.push({
              id: createId(),
              data: JSON.stringify(result),
              created: timestamp(),
            });
          }

          // get a new response from the model where it can see the function response
          const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo-0125",
            messages: [
              ...(await db.query.openaiMessages.findMany({
                orderBy: asc(openaiMessages.created),
              })),
              ...currentSession,
            ].map((m) => JSON.parse(m.data)),
            tools,
            tool_choice: "auto",
            max_tokens: 4096,
          });
          console.log(
            "Completion:",
            inspect(completion.choices, true, 10, true)
          );
          modelResponse = completion.choices[0].message;

          // save the response
          currentSession.push({
            id: createId(),
            data: JSON.stringify(modelResponse),
            created: timestamp(),
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
              model: "tts-1-hd",
              voice: "alloy",
              input,
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
        message: `More human than human is our motto. You are currently talking to ${ctx.msg.from.first_name}.`,
        role: "system",
      },
      {
        params: {
          agent_id: chat.agentId,
        },
        headers: {
          Authorization: `Bearer ${memgptUser.memgptApiKey}`,
          Accept: "application/json",
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
          message: `More human than human is our motto. You are currently talking to ${ctx.msg.from.first_name}.`,
          role: "system",
        },
        {
          params: {
            agent_id: chat.agentId,
          },
          headers: {
            Authorization: `Bearer ${memgptUser.memgptApiKey}`,
            Accept: "application/json",
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
          params: {
            agent_id: chat.agentId,
          },
          headers: {
            Authorization: `Bearer ${memgptUser.memgptApiKey}`,
            Accept: "application/json",
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
            params: {
              agent_id: chat.agentId,
            },
            headers: {
              Authorization: `Bearer ${memgptUser.memgptApiKey}`,
              Accept: "application/json",
            },
          }
        );

      console.log("Got response from memGPT:", response);
    }

    // send message to agent
    const response = await chatAction(ctx.chat, "typing", () =>
      memgpt.send_message_api_agents__agent_id__messages_post(
        {
          message: `You are currently in the ${ctx.msg.chat.title} chat group.`,
          role: "user",
        },
        {
          params: {
            agent_id: chat.agentId,
          },
          headers: {
            Authorization: `Bearer ${memgptUser.memgptApiKey}`,
            Accept: "application/json",
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
            id: interimForwardRecordId,
            forwardedMessageId: String(agentMessageSent.message_id),
            originalMessageId: String(ctx.msg.message_id),
            originalMessageChatId: String(ctx.msg.chat.id),
          });
          await db.insert(agentResponses).values({
            id: createId(),
            interimForwardedMessage: interimForwardRecordId,
            content: r.assistant_message as string,
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
            id: createId(),
            forwardedMessageId: String(internalMonologueSent.message_id),
            originalMessageId: String(ctx.msg.message_id),
            originalMessageChatId: String(ctx.msg.chat.id),
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
