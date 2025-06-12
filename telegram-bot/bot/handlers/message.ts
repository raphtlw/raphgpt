import { openai } from "@ai-sdk/openai";
import { fmt, i } from "@grammyjs/parse-mode";
import { createId } from "@paralleldrive/cuid2";
import {
  generateObject,
  generateText,
  streamText,
  type CoreMessage,
  type DataContent,
  type ImagePart,
  type UserContent,
} from "ai";
import type { BotContext } from "bot";
import { getConfigValue } from "bot/config";
import { DATA_DIR, LLM_TOOLS_LIMIT, TEMP_DIR } from "bot/constants";
import { insertMessage, pullMessageHistory } from "bot/context-history";
import { retrieveUser } from "bot/helpers";
import logger from "bot/logger";
import { ChatAction } from "bot/running-tasks";
import { downloadFile, telegram } from "bot/telegram";
import { $, inspect } from "bun";
import { redis } from "connections/redis";
import { runModel } from "connections/replicate";
import { vectorStore } from "connections/vector";
import { analyzeVideo } from "connections/video-parser";
import { db } from "db";
import { searchChatMemory } from "db/vector";
import { Composer, InputFile } from "grammy";
import fs from "node:fs/promises";
import path from "path";
import pdf2pic from "pdf2pic";
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

export const messageHandler = new Composer<BotContext>();

messageHandler.on(["message", "edit:text"]).filter(
  async (ctx) => {
    if (!ctx.from) throw new Error("ctx.from not found");

    if (ctx.hasChatType("private")) {
      return true;
    }
    if (
      ctx.from.id === getEnv("TELEGRAM_BOT_OWNER", z.coerce.number()) &&
      ctx.msg.text?.startsWith("-bot ")
    ) {
      return true;
    }
    return false;
  },
  async (ctx) => {
    if (!ctx.from) throw new Error("ctx.from not found");

    const userId = ctx.from.id;
    const chatId = ctx.chatId;

    // Cancel the previous request if it exists
    if (ctx.session.task) {
      ctx.session.task.abort();
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

    ctx.session.task = new AbortController();

    const user = await retrieveUser(ctx);

    // // Check if user has enough free messages
    // // Check if user has enough credits
    // // Excluding TELEGRAM_BOT_OWNER
    // const userExceedsFreeMessages =
    //   user.freeTierMessageCount >
    //   getEnv("FREE_TIER_MESSAGE_DAILY_THRESHOLD", z.coerce.number());
    // const userIsOwner =
    //   user.userId === getEnv("TELEGRAM_BOT_OWNER", z.coerce.number());
    // if (userExceedsFreeMessages && user.credits <= 0 && !userIsOwner) {
    //   return await ctx.reply(
    //     "You have run out of credits! Use /topup to get more.",
    //   );
    // }

    if (ctx.msg.text?.startsWith("-bot ")) {
      ctx.msg.text = ctx.msg.text.replace("-bot ", "");
    }

    const toSend: UserContent = [];
    const remindingSystemPrompt: string[] = [];

    if (ctx.msg.text) {
      ctx.session.chatAction = new ChatAction(ctx.chatId, "typing");

      toSend.push({ type: "text", text: ctx.msg.text });
    }
    if (ctx.msg.voice) {
      ctx.session.chatAction = new ChatAction(ctx.chatId, "record_voice");

      const file = await downloadFile(ctx);
      ctx.session.tempFiles.push(file.localPath);
      const inputFileId = createId();
      const audioFilePath = path.join(DATA_DIR, `input-${inputFileId}.mp3`);
      ctx.session.tempFiles.push(audioFilePath);
      await $`ffmpeg -i ${file.localPath} ${audioFilePath}`;

      const transcript = await runModel(
        "vaibhavs10/incredibly-fast-whisper:3ab86df6c8f54c11309d4d1f930ac292bad43ace52d10c80d87eb258b3c9f79c",
        z.object({
          task: z.string(),
          audio: z.string(),
          language: z.string(),
          batch_size: z.number(),
          diarise_audio: z.boolean(),
        }),
        z.object({
          text: z.string(),
        }),
        {
          task: "transcribe",
          audio: file.remoteUrl,
          language: "english",
          batch_size: 64,
          diarise_audio: false,
        },
        ctx.session.task.signal,
      );

      toSend.push({ type: "text", text: transcript.text });
    }
    if (ctx.msg.video_note || ctx.msg.video) {
      ctx.session.chatAction = new ChatAction(ctx.chatId, "typing");

      const file = await downloadFile(ctx);
      ctx.session.tempFiles.push(file.localPath);

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
    if (ctx.msg.photo) {
      ctx.session.chatAction = new ChatAction(ctx.chatId, "typing");

      const file = await downloadFile(ctx);
      ctx.session.tempFiles.push(file.localPath);
      const image = await sharp(file.localPath)
        .jpeg({ mozjpeg: true })
        .toBuffer();

      toSend.push({
        type: "image",
        image,
      });
    }
    if (ctx.msg.document) {
      ctx.session.chatAction = new ChatAction(ctx.chatId, "typing");

      const file = await downloadFile(ctx);
      ctx.session.tempFiles.push(file.localPath);
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
          form.append("files", Bun.file(file.localPath));

          const res = await fetch(
            "http://gotenberg:3000/forms/libreoffice/convert",
            {
              method: "POST",
              body: form,
            },
          );

          if (!res.ok) {
            throw new Error(
              `Gotenberg failed with status ${res.status}: ${await res.text()}`,
            );
          }

          const pdfPages = await pdf2pic
            .fromBuffer(Buffer.from(await res.arrayBuffer()))
            .bulk(-1, {
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
        if (["jpg", "jpeg", "png", "webp"].includes(file.fileType.ext)) {
          toSend.push({
            type: "image",
            image: file.remoteUrl,
          });
        }
        // if (file.fileType.ext === "zip") {
        //   // unzip the file
        //   const contentDir = await fs.mkdtemp(
        //     path.join(LOCAL_FILES_DIR, "zip-"),
        //   );

        //   await ctx.reply("Unzipping...", {
        //     reply_parameters: {
        //       message_id: ctx.msgId,
        //       allow_sending_without_reply: true,
        //     },
        //   });

        //   await runCommand(`unzip ${file.localPath}`, {
        //     cwd: contentDir,
        //   });

        //   const filePaths = await globby("**", {
        //     absolute: true,
        //     ignore: [
        //       "__MACOSX",
        //       ".DS_Store",
        //       ".idea",
        //       ".gradle",
        //       ".plugin_symlinks",
        //       "windows/runner",
        //       "macos/runner",
        //       "node_modules",
        //       "dart_project",
        //     ].map((p) => `**/${p}/**`),
        //     expandDirectories: true,
        //     onlyFiles: true,
        //     dot: true,
        //     cwd: contentDir,
        //   });

        //   logger.info(filePaths, "Unzipped files");

        //   const textFilePaths = [];

        //   for (const filePath of filePaths) {
        //     const binaryType = await fileTypeFromBuffer(
        //       await fs.promises.readFile(filePath),
        //     );
        //     if (!binaryType) {
        //       textFilePaths.push(filePath);
        //     }
        //   }

        //   const localFiles = await db
        //     .insert(tables.localFiles)
        //     .values(
        //       textFilePaths.map((p) => ({
        //         path: p,
        //         content: fs.readFileSync(p, "utf-8"),
        //       })),
        //     )
        //     .returning();

        //   await fs.promises.rm(contentDir, { recursive: true, force: true });

        //   toSend.push({
        //     type: "text",
        //     text: [
        //       `ZIP file processed. File IDs:`,
        //       ...localFiles.map((f) => f.id),
        //     ].join("\n"),
        //   });
        //   toSend.push({
        //     type: "text",
        //     text: "You should call read_file tool to read files you may need.",
        //   });
        // }
      } else {
        toSend.push({
          type: "text",
          text: "Text file contents:",
        });
        toSend.push({
          type: "text",
          text: await Bun.file(file.localPath).text(),
        });
      }
    }
    if (ctx.msg.location) {
      ctx.session.chatAction = new ChatAction(ctx.chatId, "typing");

      toSend.push({
        type: "text",
        text: JSON.stringify(ctx.msg.location),
      });
    }
    if (ctx.msg.sticker) {
      ctx.session.chatAction = new ChatAction(ctx.chatId, "typing");

      const file = await downloadFile(ctx);
      ctx.session.tempFiles.push(file.localPath);

      let images: DataContent[];
      if (ctx.msg.sticker.is_animated) {
        const mp4FilePath = await new TGS(file.localPath).convertToMp4(
          path.join(TEMP_DIR, `${createId()}.mp4`),
        );
        ctx.session.tempFiles.push(mp4FilePath);
        const { transcript, frames, summary } = await analyzeVideo(
          Bun.file(mp4FilePath),
          "en",
        );
        images = frames;
      } else if (file.fileType?.mime.startsWith("video")) {
        const stickerPath = path.join(TEMP_DIR, `sticker_${createId()}.mp4`);
        ctx.session.tempFiles.push(stickerPath);
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
                text: `The user has sent a Telegram sticker: ${JSON.stringify(
                  ctx.msg.sticker,
                )}. Describe everything about it most accurately for another LLM to understand and interpret, and add references to pop culture or things it might look like.`,
              },
              ...(images.map((image) => ({
                type: "image",
                image,
              })) as ImagePart[]),
            ],
          },
        ],
      });
      // if (userExceedsFreeMessages && !userIsOwner) {
      //   await deductCredits(ctx, usage);
      // }

      toSend.push({
        type: "text",
        text: `Telegram sticker contents: ${text}`,
      });
    }
    if (ctx.msg.caption) {
      ctx.session.chatAction = new ChatAction(ctx.chatId, "typing");

      toSend.push({
        type: "text",
        text: ctx.msg.caption,
      });
    }

    logger.debug(
      `User message content: ${inspect({ toSend, remindingSystemPrompt })}`,
    );

    const { object: summary } = await generateObject({
      model: openai("gpt-4o"),
      system:
        "You are an assistant summarizing multimodal content into search-friendly text.",
      schema: z.object({
        query: z.string(),
        title: z.string(),
      }),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are an assistant helping index messages for semantic search.
Given the following content extracted from a user's message, summarize it in a single sentence for indexing and storage.
Query should be what you would use to search a RAG db for related messages.
Title should be what this set of messages would be stored as in the RAG db.`,
            },
            ...toSend,
          ],
        },
      ],
    });

    const relatedTurns = await searchChatMemory(chatId, summary.query, 4);

    logger.debug(`Most relevant conversation turns: ${inspect(relatedTurns)}`);

    const messages: CoreMessage[] = [];

    for (const turn of relatedTurns) {
      const relatedMessages = await pullMessageHistory(turn.messageIds);
      messages.push(...relatedMessages);
    }

    logger.debug(`Message history: ${inspect(messages)}`);

    messages.push({
      role: "system",
      content: remindingSystemPrompt.join("\n"),
    });

    const pendingRequests = await redis
      .LRANGE(`pending_requests:${ctx.chatId}:${userId}`, 0, -1)
      .then((jsons) =>
        jsons.map((c: string) => SuperJSON.parse<UserContent>(c)),
      );

    logger.debug(`Pending requests: ${inspect(pendingRequests)}`);

    const content = [...pendingRequests.flat(1), ...toSend] as UserContent;

    messages.push({
      role: "user",
      content,
    });

    logger.debug(`Sending message to model: ${inspect(content)}`);

    await redis.RPUSH(
      `pending_requests:${ctx.chatId}:${userId}`,
      SuperJSON.stringify(toSend),
    );

    const tools = mergeTools(
      await searchTools(
        summary.query,
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

    const { textStream, response } = streamText({
      model: openai("o4-mini", {
        structuredOutputs: false,
      }),
      tools,
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
        userName: ctx.from.username ?? ctx.from.first_name,
      }),
      messages,
      maxSteps: 5,
      async onFinish(result) {
        // Remove all pending requests
        await redis.del(`pending_requests:${ctx.chatId}:${userId}`);
        ctx.session.task = null;

        logger.debug(`Model finished with ${result.finishReason}`);

        if (result.finishReason === "tool-calls") {
          logger.info(
            `Not saving this time because generation stopped from a tool call! id: ${result.response.id}`,
          );
          return;
        }

        {
          const s3Bucket = getEnv("S3_BUCKET", z.string());
          const s3Region = getEnv("S3_REGION", z.string());
          const messageIds: number[] = [];

          messageIds.push(
            await insertMessage({
              chatId: ctx.chatId,
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
                chatId: ctx.chatId,
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
            metadata: { chatId, messageIds },
          });
        }
      },
      async onError({ error }) {
        logger.error(error, "Encountered error during AI streaming");
        ctx.session.task?.abort();
      },
      abortSignal: ctx.session.task.signal,
    });

    let textBuffer = "";
    let firstMessageSent = false;

    const flushBuffer = async () => {
      logger.debug(`About to flush: ${textBuffer}`);

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

    if (ctx.msg.audio || ctx.msg.voice) {
      try {
        const fullResponse = await response;
        const fullText = fullResponse.messages
          .filter((m) => m.role === "assistant")
          .map((m) => m.content)
          .join("\n");

        const ttsInput = {
          text: fullText,
          voice_id: "Deep_Voice_Man",
          speed: 1,
          volume: 1,
          pitch: 0,
          emotion: "auto",
          english_normalization: true,
          sample_rate: 32000,
          bitrate: 128000,
          channel: "mono",
          language_boost: "English",
        };

        const ttsSchema = z.object({
          text: z.string(),
          voice_id: z.string(),
          speed: z.number(),
          volume: z.number(),
          pitch: z.number().int(),
          emotion: z.string(),
          english_normalization: z.boolean(),
          sample_rate: z.number(),
          bitrate: z.number(),
          channel: z.string(),
          language_boost: z.string(),
        });

        const audioUrl = await runModel(
          "minimax/speech-02-turbo",
          ttsSchema,
          z.string(),
          ttsInput,
        );

        await fs.mkdir(TEMP_DIR, { recursive: true });
        const rawPath = path.join(TEMP_DIR, `voice-${createId()}.mp3`);
        const arrayBuffer = await (await fetch(audioUrl)).arrayBuffer();
        await fs.writeFile(rawPath, Buffer.from(arrayBuffer));
        const oggPath = rawPath.replace(/\.[^.]+$/, ".ogg");
        await $`ffmpeg -i ${rawPath} -acodec libopus -filter:a volume=4dB ${oggPath}`;

        await telegram.sendVoice(ctx.chatId, new InputFile(oggPath), {
          reply_to_message_id: ctx.msgId,
        });

        await fs.rm(rawPath, { force: true });
        await fs.rm(oggPath, { force: true });
      } catch (e) {
        logger.error({ e }, "Error generating or sending voice message");
      }
    }

    // if (!userIsOwner) {
    //   if (userExceedsFreeMessages) {
    //     await deductCredits(ctx, modelUsage);
    //   } else {
    //     await db
    //       .update(tables.users)
    //       .set({
    //         freeTierMessageCount: sql`${tables.users.freeTierMessageCount} + 1`,
    //       })
    //       .where(eq(tables.users.userId, ctx.from.id));
    //   }
    // }
  },
);
