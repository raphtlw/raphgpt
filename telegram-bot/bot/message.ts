import { openai } from "@ai-sdk/openai";
import { TZDate } from "@date-fns/tz";
import { createId } from "@paralleldrive/cuid2";
import {
  generateObject,
  streamText,
  ToolExecutionError,
  type CoreMessage,
  type DataContent,
  type UserContent,
} from "ai";
import type { BotContext } from "bot";
import { getConfigValue } from "bot/config";
import {
  DATA_DIR,
  LLM_TOOL_MAX_RETRIES,
  LLM_TOOLS_LIMIT,
  TEMP_DIR,
} from "bot/constants";
import {
  insertMessage,
  pullMessageHistory,
  pullMessagesByChatAndUser,
} from "bot/context-history";
import { ChatAction } from "bot/running-tasks";
import { telegram } from "bot/telegram";
import { $, inspect, s3 } from "bun";
import { redis } from "connections/redis";
import { replicate } from "connections/replicate";
import { vectorStore } from "connections/vector";
import { analyzeVideo } from "connections/video-parser";
import { db } from "db";
import { searchChatMemory } from "db/vector";
import { InputFile } from "grammy";
import type { Message } from "grammy/types";
import path from "path";
import type { FileOutput } from "replicate";
import sharp from "sharp";
import SuperJSON from "superjson";
import telegramifyMarkdown from "telegramify-markdown";
import { agenticTools } from "tools/agentic";
import { generateImage } from "tools/generate-image";
import { ltaAgent } from "tools/lta-agent";
import { raphgptTools } from "tools/raphgpt";
import { telegramTools } from "tools/telegram";
import { walletExplorerAgent } from "tools/wallet-explorer-agent";
import { getEnv } from "utils/env";
import { buildPrompt } from "utils/prompt";
import TGS from "utils/tgs";
import { mergeTools, searchTools } from "utils/tools";
import { z } from "zod";

export async function processTelegramMessage(ctx: BotContext, msg: Message) {
  if (!ctx.from) throw new Error("ctx.from not found");
  if (!ctx.chatId) throw new Error("ctx.chatId not found");

  const userId = ctx.from.id;
  const chatId = ctx.chatId;

  if (msg.text?.startsWith("-bot ")) {
    msg.text = msg.text.replace("-bot ", "");
  }
  if (msg.caption?.startsWith("-bot ")) {
    msg.caption = msg.caption.replace("-bot ", "");
  }

  const toSend: UserContent = [];
  const remindingSystemPrompt: string[] = [];

  if (msg.text) {
    toSend.push({ type: "text", text: msg.text });
  }
  if (msg.voice) {
    const file = await ctx.downloadFile();
    const inputFileId = createId();
    const audioFilePath = path.join(DATA_DIR, `input-${inputFileId}.mp3`);
    await $`ffmpeg -i ${file.localPath} ${audioFilePath}`;

    const transcript = (await replicate.run(
      "vaibhavs10/incredibly-fast-whisper:3ab86df6c8f54c11309d4d1f930ac292bad43ace52d10c80d87eb258b3c9f79c",
      {
        input: {
          task: "transcribe",
          audio: file.remoteUrl,
          language: "english",
          batch_size: 64,
          diarise_audio: false,
        },
        signal: ctx.session.task?.signal,
      },
    )) as { text: string };

    toSend.push({ type: "text", text: transcript.text });
  }
  if (msg.video_note || msg.video) {
    const file = await ctx.downloadFile();

    const { transcript, frames, summary } = await analyzeVideo(
      Bun.file(file.localPath),
      "en",
    );

    remindingSystemPrompt.push(
      "You have been given periodic frames from a video. Frames with the least amount of blur were extracted.",
      "When responding, pretend you have watched a video.",
      "To avoid confusing the user, do not say they are images.",
    );
    for (const b64 of frames) {
      toSend.push({
        type: "image",
        image: b64,
      });
    }
    toSend.push({ type: "text", text: transcript });
  }
  if (msg.photo) {
    const file = await ctx.downloadFile();
    const key = `images/${ctx.chatId}/${userId}/${path.basename(file.localPath)}`;
    await s3.file(key).write(Bun.file(file.localPath));
    const image = await sharp(file.localPath)
      .jpeg({ mozjpeg: true })
      .toBuffer();

    toSend.push({
      type: "image",
      image,
    });
    toSend.push({
      type: "text",
      text: `Image uploaded as ${key}`,
    });
  }
  if (msg.document) {
    const file = await ctx.downloadFile();
    const key = `documents/${ctx.chatId}/${userId}/${path.basename(file.localPath)}`;
    await s3.file(key).write(Bun.file(file.localPath));

    toSend.push(
      {
        type: "text",
        text: `File uploaded to S3 path ${key}`,
      },
      {
        type: "text",
        text: `File size in bytes: ${msg.document.file_size}`,
      },
      {
        type: "text",
        text: `Mime type: ${msg.document.mime_type}`,
      },
    );

    if (!file.fileType) {
      const charsToRead = 10;
      toSend.push({
        type: "text",
        text: `First ${charsToRead} characters: ${(await Bun.file(file.localPath).text()).slice(0, charsToRead)}`,
      });
    }
  }
  if (msg.location) {
    toSend.push({
      type: "text",
      text: `Location: ${JSON.stringify(msg.location)}`,
    });
  }
  if (msg.sticker) {
    const file = await ctx.downloadFile();

    let images: DataContent[];
    if (msg.sticker.is_animated) {
      const mp4FilePath = await new TGS(file.localPath).convertToMp4(
        path.join(TEMP_DIR, `${createId()}.mp4`),
      );
      const { transcript, frames, summary } = await analyzeVideo(
        Bun.file(mp4FilePath),
        "en",
      );
      images = frames;
    } else if (file.fileType?.mime.startsWith("video")) {
      const stickerPath = path.join(TEMP_DIR, `sticker_${createId()}.mp4`);
      await $`ffmpeg -i ${file.localPath} ${stickerPath}`;
      const { transcript, frames, summary } = await analyzeVideo(
        Bun.file(stickerPath),
        "en",
      );
      images = frames;
    } else {
      const stickerBuffer = await sharp(file.localPath)
        .jpeg({ mozjpeg: true })
        .toBuffer();
      images = [stickerBuffer];
    }

    toSend.push({
      type: "text",
      text: `Telegram sticker: ${JSON.stringify(msg.sticker)}`,
    });
    toSend.push(
      ...images.map((img) => ({
        type: "image" as const,
        image: img,
      })),
    );
  }
  if (msg.caption) {
    toSend.push({
      type: "text",
      text: msg.caption,
    });
  }

  return [toSend, remindingSystemPrompt] as const;
}

export async function gatherAndRunLLM(
  ctx: BotContext,
  toSend: Exclude<UserContent, string>,
  remindingSystemPrompt: string[],
) {
  if (!ctx.from) throw new Error("ctx.from not found");
  if (!ctx.chatId) throw new Error("ctx.chatId not found");

  const userId = ctx.from.id;
  const chatId = ctx.chatId;

  // Get context history, limited to config value
  const recentMessages = await pullMessagesByChatAndUser({
    chatId,
    userId,
    limit: await getConfigValue(ctx.from.id, "messagehistsize"),
  });

  // Log context history but don't push it yet.
  console.log(`Recent messages: ${inspect(recentMessages)}`);

  const { object: summary } = await generateObject({
    model: openai("gpt-4o-mini"),
    system: `You are an assistant summarizing multimodal content into search-friendly text.
With previous messages in mind, produce queries for indexing and storage. Place more emphasis on last message.`,
    schema: z.object({
      toolQuery: z
        .string()
        .describe(
          "Text to use when searching for tools." +
            "Include google_lens or photo when images are included.",
        ),
      query: z.string().describe("Search query for vector search"),
      title: z
        .string()
        .describe(
          "What to label this conversation as, when performing retrieval later on.",
        ),
    }),
    messages: [
      ...recentMessages,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Look at this message and summarize it`,
          },
          ...toSend,
        ],
      },
    ],
    abortSignal: ctx.session.task?.signal,
  });

  console.log(`Summary from LLM: ${inspect(summary)}`);

  // Find most relevant conversations from chat-memory vector db
  const relatedTurns = await searchChatMemory(chatId, summary.query, 4);
  console.log(`Most relevant conversation turns: ${inspect(relatedTurns)}`);

  const messages: CoreMessage[] = [];

  // Append relevant conversation turns
  for (const turn of relatedTurns) {
    const relatedMessages = await pullMessageHistory(turn.messageIds);
    messages.push(...relatedMessages);
  }

  // Context history should come after relevant conversations
  messages.push(...recentMessages);

  // Remind the model what its main task is
  messages.push({
    role: "system",
    content: remindingSystemPrompt.join("\n"),
  });

  // Gather all pending requests and send it to the model
  const pendingRequests = await redis
    .LRANGE(`pending_requests:${ctx.chatId}:${userId}`, 0, -1)
    .then((jsons) => jsons.map((c: string) => SuperJSON.parse<UserContent>(c)));

  // Includes all current + previous requests
  console.log(`Pending requests: ${inspect(pendingRequests)}`);

  // Flatten it because it is an array of UserContent
  const content = pendingRequests.flat(1) as UserContent;

  messages.push({
    role: "user",
    content,
  });

  console.log(`Sending message to model: ${inspect(content)}`);

  ctx.session.chatAction = new ChatAction(ctx.chatId, "typing");

  const tools = mergeTools(
    await searchTools(
      summary.toolQuery,
      mergeTools(
        raphgptTools({ ctx }),
        generateImage({ ctx }),
        ltaAgent({ ctx }),
        walletExplorerAgent({ ctx }),
        agenticTools,
      ),
      LLM_TOOLS_LIMIT,
    ),
    telegramTools(ctx),
  );

  const instrRows = await db.query.systemInstructions.findMany({
    columns: { content: true },
  });
  const instructions = instrRows.map((r) => r.content).join("\n");

  const exampleRows = await db.query.interactionExamples.findMany({
    columns: { userInput: true, botResponse: true },
  });
  const examples = exampleRows
    .map((r) => `User: ${r.userInput}\nBot: ${r.botResponse}`)
    .join("\n\n");

  const system = await buildPrompt("system", {
    me: JSON.stringify(ctx.me),
    date: new TZDate(
      new Date(),
      await getConfigValue(ctx.from.id, "timezone"),
    ).toString(),
    language: await getConfigValue(ctx.from.id, "language"),
    personality: (
      await db.query.personality.findMany({ columns: { content: true } })
    )
      .map((r) => r.content)
      .join("\n"),
    userName: ctx.from.username ?? ctx.from.first_name,
    instructions,
    examples,
    owner: getEnv("TELEGRAM_BOT_OWNER"),
  });

  let toolRetryCount = 0;

  const runLLM = async () => {
    let toolError: unknown = undefined;

    const { textStream } = streamText({
      model: openai("o4-mini", {
        structuredOutputs: false,
      }),
      tools,
      system,
      messages,
      maxSteps: 5,
      async onFinish(result) {
        console.log(`Model finished with ${result.finishReason}`);

        if (result.finishReason === "tool-calls") {
          if (toolRetryCount < LLM_TOOL_MAX_RETRIES) {
            console.log(result.response.messages);
            messages.push(...result.response.messages);
            const finalToolCalls = result.toolCalls;
            const lastToolCall = finalToolCalls[finalToolCalls.length - 1];
            if (lastToolCall) {
              messages.push({
                role: "tool",
                content: [
                  {
                    toolCallId: lastToolCall.toolCallId,
                    toolName: lastToolCall.toolName,
                    result: { toolError },
                    type: "tool-result",
                  },
                ],
              });
            }
            console.log(
              "Calling model again with last tool call updated:",
              messages[messages.length - 1],
            );

            toolRetryCount++;
            return await runLLM();
          } else {
            console.error("MAX RETRIES REACHED");
            console.error(
              `Not saving this time because generation stopped from a tool call! id: ${result.response.id}`,
            );
            return;
          }
        }

        if (ctx.msg?.audio || ctx.msg?.voice) {
          ctx.session.chatAction = new ChatAction(ctx.chatId!, "record_voice");
          const audioFile = (await replicate.run("minimax/speech-02-turbo", {
            input: {
              text: result.text.split("<|message|>").join("<#0.5#>"),
              voice_id: "English_FriendlyPerson",
              speed: 1,
              volume: 2,
              pitch: 0,
              emotion: "auto",
              english_normalization: true,
              sample_rate: 32000,
              bitrate: 128000,
              channel: "mono",
              language_boost: "English",
            },
            signal: ctx.session.task?.signal,
          })) as FileOutput;

          const rawPath = path.join(TEMP_DIR, `voice-${createId()}.mp3`);
          await Bun.write(rawPath, await audioFile.blob());
          const oggPath = rawPath.replace(/\.[^.]+$/, ".ogg");
          await $`ffmpeg -i ${rawPath} -acodec libopus -filter:a volume=4dB ${oggPath}`;

          await telegram.sendVoice(ctx.chatId!, new InputFile(oggPath), {
            reply_parameters: {
              message_id: ctx.msgId!,
              allow_sending_without_reply: true,
            },
          });
        }

        // This marks the end of this turn
        await redis.del(`pending_requests:${ctx.chatId}:${userId}`);
        ctx.session.task = null;
        ctx.session.chatAction?.stop();

        {
          const s3Bucket = getEnv("S3_BUCKET", z.string());
          const s3Region = getEnv("S3_REGION", z.string());
          const messageIds: number[] = [];

          messageIds.push(
            await insertMessage({
              chatId: ctx.chatId!,
              userId,
              role: "user",
              content: toSend,
              s3Bucket,
              s3Region,
            }),
          );
          for (const msg of result.response.messages) {
            messageIds.push(
              await insertMessage({
                chatId: ctx.chatId!,
                userId,
                role: msg.role,
                content: msg.content,
                s3Bucket,
                s3Region,
              }),
            );
          }

          await vectorStore.upsert({
            id: createId(),
            data: summary.title,
            metadata: { chatId, messageIds, createdAt: new Date() },
          });
        }
      },
      async onError({ error }) {
        console.error("Encountered error during AI streaming:\n", error);
        if (ToolExecutionError.isInstance(error)) {
          toolError = error;
        } else {
          ctx.session.task?.abort();
        }
      },
      abortSignal: ctx.session.task?.signal,
    });

    let textBuffer = "";
    let firstMessageSent = false;

    const flushBuffer = async () => {
      console.log(`About to flush: ${textBuffer}`);

      // flush the buffer
      if (textBuffer.trim().length > 0) {
        const mdv2 = telegramifyMarkdown(textBuffer, "escape");
        await telegram.sendMessage(ctx.chatId!, mdv2, {
          parse_mode: "MarkdownV2",
          ...(ctx.editedMessage &&
            !firstMessageSent && {
              reply_parameters: {
                message_id: ctx.msgId!,
              },
            }),
        });
        textBuffer = "";
        firstMessageSent = true;
      }
    };

    try {
      for await (const textPart of textStream) {
        if (ctx.session.task?.signal.aborted) return;

        textBuffer += textPart;

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
    } catch (e) {
      console.log("Error during stream iteration:", e);
    }
  };

  await runLLM();
}
