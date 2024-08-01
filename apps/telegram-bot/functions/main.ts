import { bold, fmt, italic, pre, underline } from "@grammyjs/parse-mode";
import { createId } from "@paralleldrive/cuid2";
import { hyper, hyperStore } from "@raphtlw/hyperfunc";
import { db, schema } from "@repo/db";
import { fileTypeFromStream } from "file-type";
import fs from "fs";
import got from "got";
import { InputFile } from "grammy";
import {
  InputMediaAudio,
  InputMediaDocument,
  InputMediaPhoto,
  InputMediaVideo,
} from "grammy/types";
import OpenAI from "openai";
import os from "os";
import path from "path";
import Replicate from "replicate";
import { pipeline as streamPipeline } from "stream/promises";
import { encoding_for_model } from "tiktoken";
import { z } from "zod";
import logger from "../bot/logger.js";
import { telegram } from "../bot/telegram.js";
import { runCommand } from "../bot/util.js";
import { BROWSER } from "../helpers/browser.js";
import { callPython } from "../helpers/python.js";

export const mainFunctions = hyperStore<{ chatId: number; msgId: number }>({
  search_google: hyper({
    description:
      "Get relevant search results from Google in JSON format. Use this to answer questions that require up to date info, or to get links from web results. Unable to do location searching.",
    args: {
      query: z.string().describe("Search query"),
      gl: z.string().describe("two-letter country code").optional(),
      link_site: z
        .string()
        .describe("Site URL to limit search results to")
        .optional(),
      search_type: z
        .enum(["image"])
        .describe("Specifies the search type")
        .optional(),
    },
    async handler({ query, gl = "SG", link_site, search_type }) {
      const params = new URLSearchParams({
        cx: process.env.GOOGLE_SEARCH_ENGINE_ID!,
        key: process.env.GOOGLE_SEARCH_API_KEY!,
        q: query,
      });
      if (gl) params.append("gl", gl);
      if (link_site) params.append("linkSite", link_site);
      if (search_type) params.append("searchType", search_type);
      const res = await got(
        `https://customsearch.googleapis.com/customsearch/v1?` + params,
      ).json<any>();
      logger.debug(res, "Google Search Response");

      const results: {
        title: string;
        link: string;
        snippet: string;
        content?: string;
      }[] = res.items.map(({ title, link, snippet }: any) => ({
        title,
        link,
        snippet,
      }));

      // get first 5 result contents
      for (let i = 0; i < 5; i++) {
        try {
          const page = await BROWSER.newPage();
          await page.goto(results[i].link, {
            waitUntil: "domcontentloaded",
          });
          const html = await page.content();

          logger.debug(html);

          const markdown = z.object({ result: z.string() }).parse(
            await got
              .post(`${process.env.PYTHON_URL}/getMarkdownFromHtml`, {
                json: { html },
              })
              .json(),
          );

          logger.debug(markdown.result);

          await page.close();

          // limit content length to fit context size for model
          const enc = encoding_for_model("gpt-4o");
          const tok = enc.encode(markdown.result);
          const lim = tok.slice(0, 512);
          const txt = enc.decode(lim).toString();
          enc.free();

          if (txt.length > 0) {
            results[i].content = txt;
          }
        } catch (e) {
          console.error(e);
        }
      }

      return results;
    },
  }),

  read_text: hyper({
    description:
      "Reads out text for the user to listen to. To be used in a chatbot-like fashion, where the user listens to your speech",
    args: {
      text: z
        .string()
        .describe(
          [
            "Text in simple and easy to understand form. Replace all special characters with descriptions of them, e.g. 1. as 'One.' and #aaa as 'Hashtag aaa'",
            "Use emotion and adjective tags like [laughs] and [excited]",
          ].join("\n"),
        ),
    },
    async handler({ text }, { chatId, msgId }) {
      const replicate = new Replicate();
      const spoken = await replicate
        .run(
          "suno-ai/bark:b76242b40d67c76ab6742e987628a2a9ac019e11d56ab96c4e91ce03b79b2787",
          {
            input: {
              prompt: text,
            },
          },
        )
        .then((o) =>
          z
            .object({
              audio_out: z.string(),
            })
            .parse(o),
        );
      const spokenPath = `voice-${createId()}.wav`;
      const outputPath = `${spokenPath.split(".")[0]}.ogg`;
      await streamPipeline(
        got.stream(spoken.audio_out),
        fs.createWriteStream(spokenPath),
      );
      await runCommand(
        `ffmpeg -i ${spokenPath} -acodec libopus -filter:a "volume=4dB" ${outputPath}`,
      );

      await telegram.sendVoice(chatId, new InputFile(outputPath), {
        reply_parameters: {
          message_id: msgId,
        },
      });

      await Promise.all([
        fs.promises.rm(spokenPath, { recursive: true, force: true }),
        fs.promises.rm(outputPath, { recursive: true, force: true }),
      ]);

      return "Voice message sent to user.";
    },
  }),

  sing_song: hyper({
    description: "Generates a song using AI.",
    args: {
      prompt: z
        .string()
        .describe("Melody description, how it should be played."),
      lyrics: z
        .string()
        .describe(
          "Song lyrics with descriptive melody tags. Do not label sections.",
        ),
    },
    async handler({ prompt, lyrics }, { chatId, msgId }) {
      const fileId = createId();
      const lyricsPath = `lyrics-${fileId}.wav`;
      const musicPath = `music-${fileId}.wav`;
      const resultPath = `output-${fileId}.mp3`;
      const replicate = new Replicate();
      const lyricsOut = await replicate
        .run(
          "suno-ai/bark:b76242b40d67c76ab6742e987628a2a9ac019e11d56ab96c4e91ce03b79b2787",
          {
            input: {
              prompt: lyrics,
              text_temp: 0.7,
              waveform_temp: 0.7,
              history_prompt: "fr_speaker_1",
            },
          },
        )
        .then((o) =>
          z
            .object({
              audio_out: z.string(),
            })
            .parse(o),
        );
      await streamPipeline(
        got.stream(lyricsOut.audio_out),
        fs.createWriteStream(lyricsPath),
      );
      const duration = await runCommand(
        `ffprobe -v error -select_streams a:0 -show_format -show_streams ${lyricsPath}`,
      );
      logger.debug({ duration }, "FFprobe output");
      const durationAsString = duration.stdout.match(/duration="?(\d*\.\d*)"?/);
      if (durationAsString && durationAsString[1]) {
        const fduration = parseFloat(durationAsString[1]);
        const musicOut = await replicate
          .run(
            "meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb",
            {
              input: {
                prompt,
                duration: Math.ceil(fduration),
                temperature: 1,
                continuation: false,
                model_version: "stereo-large",
                output_format: "wav",
                continuation_start: 0,
                multi_band_diffusion: false,
                normalization_strategy: "peak",
                classifier_free_guidance: 3,
              },
            },
          )
          .then((o) => z.string().parse(o));
        await streamPipeline(
          got.stream(musicOut),
          fs.createWriteStream(musicPath),
        );

        // Downmix each input into single output channel
        await runCommand(
          `ffmpeg -i ${lyricsPath} -i ${musicPath} -filter_complex amix=inputs=2:duration=longest ${resultPath}`,
        );

        await telegram.sendAudio(chatId, new InputFile(resultPath), {
          reply_parameters: {
            message_id: msgId,
          },
        });

        await Promise.all([
          fs.promises.rm(lyricsPath, { recursive: true, force: true }),
          fs.promises.rm(musicPath, { recursive: true, force: true }),
          fs.promises.rm(resultPath, { recursive: true, force: true }),
        ]);

        return "Voice message sent to user.";
      } else {
        return "Unable to detect song duration, aborted. Do not try again.";
      }
    },
  }),

  find_place: hyper({
    description:
      "Search for a place or commodity on Google Maps and returns 5 most relevant results",
    args: {
      text_query: z
        .string()
        .describe(
          "Query in plain text, e.g. Spicy Vegetarian Food in Eunos, Singapore, or 'best satay in singapore'. Try to be descriptive.",
        ),
      lat: z
        .number()
        .describe(
          "Latitude of results to search around, preferably the users current location.",
        )
        .optional(),
      lon: z
        .number()
        .describe(
          "Longitude of results to search around, preferably the users current location.",
        )
        .optional(),
    },
    async handler({ text_query, lat, lon }) {
      const res = await got
        .post("https://places.googleapis.com/v1/places:searchText", {
          headers: {
            "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
            "X-Goog-FieldMask":
              "places.displayName,places.formattedAddress,places.priceLevel,places.googleMapsUri,places.currentOpeningHours.openNow,places.currentOpeningHours.weekdayDescriptions",
          },
          json: {
            textQuery: text_query,
            ...(lat &&
              lon && {
                locationBias: {
                  circle: {
                    center: {
                      latitude: lat,
                      longitude: lon,
                    },
                    radius: 500.0,
                  },
                },
              }),
            pageSize: 5,
          },
        })
        .json();

      return res;
    },
  }),

  read_file: hyper({
    description: "Reads a file at the given path",
    args: {
      file_path: z
        .string()
        .describe("Full absolute path to file. Should begin with /"),
    },
    async handler({ file_path }) {
      logger.info(`Reading file at ${file_path}`);
      if (!fs.existsSync(file_path)) throw "File does not exist";
      const contents = await fs.promises.readFile(file_path, {
        encoding: "utf-8",
      });
      return contents;
    },
  }),

  // text_editor: hyper({
  //   description: "Natural language code/text editor, accepts zip files only.",
  //   args: {
  //     instructions: z
  //       .string()
  //       .describe(
  //         "What to do to the file(s), in natural language. Specify as much of the users query as possible.",
  //       ),
  //     filepath: z.string().describe("Full folder/file path"),
  //   },
  //   async handler({ instructions, filepath }, { chatId, msgId }) {
  //     const openai = new OpenAI();

  //     const toSend: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  //     const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
  //       {
  //         role: "system",
  //         content: [
  //           "You are a virtual programmer, with tools you can use to work with files.",
  //           `Today is ${new Date().toLocaleString()}`,
  //           `You don't need to respond with long messages.`,
  //           `Keep it short, just let the user know roughly what you have done to the code.`,
  //           `Only read one file at a time. Avoid reading multiple in parallel.`,
  //           `Only modify the file you read previously.`,
  //         ].join("\n"),
  //       },
  //     ];
  //     toSend.push({
  //       type: "text",
  //       text: instructions,
  //     });

  //     const filetype = await fileTypeFromFile(filepath);

  //     // unzip the file
  //     const contentDir = await fs.promises.mkdtemp(
  //       path.join(os.tmpdir(), "zip-"),
  //     );

  //     if (filetype?.ext === "zip") {
  //       await telegram.sendMessage(chatId, "Unzipping...", {
  //         reply_parameters: {
  //           message_id: msgId,
  //           allow_sending_without_reply: true,
  //         },
  //       });

  //       await runCommand(`unzip ${filepath}`, {
  //         cwd: contentDir,
  //       });

  //       const filePaths = await globby("**", {
  //         absolute: true,
  //         ignore: [
  //           "__MACOSX",
  //           ".DS_Store",
  //           ".idea",
  //           ".gradle",
  //           ".plugin_symlinks",
  //           "windows/runner",
  //           "macos/runner",
  //           "node_modules",
  //           "dart_project",
  //         ].map((p) => `**/${p}/**`),
  //         expandDirectories: true,
  //         onlyDirectories: false,
  //         onlyFiles: false,
  //         dot: true,
  //         cwd: contentDir,
  //       });

  //       logger.info(filePaths);

  //       toSend.push({
  //         type: "text",
  //         text: [`zip file contents:`, ...filePaths].join("\n"),
  //       });
  //     } else {
  //       throw "File type not supported by this tool.";
  //     }

  //     messages.push({ role: "user", content: toSend });

  //     logger.debug({ messages }, "Text editor messages");

  //     const funcs = hyperStore({
  //       read_file: hyper({
  //         description:
  //           "Read file line by line. Returns lines followed by line content, delimited by full stop.",
  //         args: {
  //           filepath: z.string(),
  //         },
  //         async handler({ filepath }) {
  //           let fc = await fs.promises.readFile(filepath, "utf-8");
  //           let result: string[] = [];

  //           // limit content length to fit context size for model
  //           const enc = encoding_for_model("gpt-4o");
  //           const tok = enc.encode(fc);
  //           const lim = tok.slice(0, 4096);
  //           const txt = enc.decode(lim).toString();
  //           enc.free();

  //           if (txt.length > 0) {
  //             fc = txt;
  //           }

  //           const lines = fc.split("\n");

  //           for (let i = 0; i < lines.length; i++) {
  //             result.push(`${i}. ${lines[i]}`);
  //           }

  //           return result.join("\n");
  //         },
  //       }),

  //       edit_file: hyper({
  //         description:
  //           "Modify all lines between start and end. Inclusive of start and end.",
  //         args: {
  //           filepath: z.string(),
  //           start: z.number(),
  //           end: z.number(),
  //           new_content: z.string().describe("Content to replace lines with"),
  //         },
  //         async handler({ filepath, start, end, new_content }) {
  //           const content = await fs.promises.readFile(filepath, "utf-8");
  //           const lines = content.split("\n");
  //           const updated = new_content.split("\n");

  //           const deleted = lines.splice(start, end, ...updated);

  //           logger.debug({ deletedElements: deleted });

  //           return `Modified ${end - start} lines`;
  //         },
  //       }),

  //       add_file: hyper({
  //         description: "Create a new file at specified path, with content",
  //         args: {
  //           filepath: z.string(),
  //           content: z.string(),
  //         },
  //         async handler({ filepath, content }) {
  //           await fs.promises.writeFile(filepath, content, "utf-8");
  //           return "File created and content written";
  //         },
  //       }),
  //     });

  //     let lastResponse = await openai.chat.completions.create({
  //       model: "gpt-4o",
  //       messages,
  //       tools: funcs.asTools(),
  //     });

  //     while (lastResponse.choices[0].message.tool_calls) {
  //       // Inform user of current function run (text from model)
  //       if (lastResponse.choices[0].message.content) {
  //         const sent = await telegram.sendMessage(
  //           chatId,
  //           lastResponse.choices[0].message.content,
  //         );
  //         logger.debug(sent, "Message sent");
  //       }

  //       // Run function calls
  //       for (const toolCall of lastResponse.choices[0].message.tool_calls) {
  //         try {
  //           const result = await funcs.callTool(toolCall, {});
  //           messages.push({
  //             tool_call_id: toolCall.id,
  //             role: "tool",
  //             content: JSON.stringify(result),
  //           });
  //           logger.info(
  //             { result, function: toolCall.function },
  //             "Function called",
  //           );
  //         } catch (e) {
  //           messages.push({
  //             tool_call_id: toolCall.id,
  //             role: "tool",
  //             content: JSON.stringify(e),
  //           });
  //           logger.info(e, "Error calling function");
  //         }
  //       }

  //       // Get a second response from the model where it can see the function response
  //       lastResponse = await openai.chat.completions.create({
  //         model: "gpt-4o-mini",
  //         messages,
  //       });
  //       messages.push(lastResponse.choices[0].message);

  //       logger.debug({ messages }, "Text editor messages");
  //     }

  //     let result: string[] = [lastResponse.choices[0].message.content!];

  //     if (filetype.ext === "zip") {
  //       const zipped = `${createId()}.zip`;
  //       await runCommand(`zip ${zipped} -r ${contentDir}`);

  //       await telegram.sendDocument(chatId, new InputFile(zipped), {
  //         reply_parameters: {
  //           message_id: msgId,
  //           allow_sending_without_reply: true,
  //         },
  //       });

  //       result.push("ZIP file sent to user");
  //     }

  //     return result.join("\n");
  //   },
  // }),

  generate_image_dalle: hyper({
    description: "Generate an image using DALLE 3",
    args: {
      model: z.enum(["dall-e-2", "dall-e-3"]).default("dall-e-2"),
      prompt: z.string().describe("Prompt to be used to generate the image"),
      size: z
        .enum(["1024x1024", "1024x1792", "1792x1024"])
        .describe("Size of image to generate")
        .default("1792x1024"),
      quality: z.enum(["standard", "hd"]).default("standard"),
      style: z
        .enum(["natural", "vivid"])
        .default("vivid")
        .describe("Style to use. Specify natural when generating sketches"),
      n: z
        .number()
        .describe("How many images to generate. Only supported for dall-e-2")
        .default(1),
    },
    async handler({ model, prompt, size, quality, n }, { chatId, msgId }) {
      const openai = new OpenAI();
      logger.info(
        { model, prompt, size, quality, n },
        "Generating image with params",
      );
      const result = await openai.images.generate({
        model,
        prompt,
        size,
        quality,
        n,
      });
      let media: Array<
        InputMediaAudio | InputMediaDocument | InputMediaPhoto | InputMediaVideo
      > = [];
      for (const [index, image] of result.data.entries()) {
        let caption = fmt`Image ${index + 1}`;
        if (image.revised_prompt) {
          caption = fmt([
            fmt`${bold(`✨ Revised Prompt:`)} ${italic(fmt`${image.revised_prompt}`)}`,
            fmt`\n${bold("Model")}: ${model}`,
            fmt`\n${bold("Prompt")}: ${prompt}`,
            fmt`\n${bold("Size")}: ${size}`,
            fmt`\n${bold("Quality")}: ${quality}`,
          ]);
        }

        if (result.data.length === 1) {
          await telegram.sendPhoto(chatId, result.data[0].url!, {
            caption: caption.text,
            caption_entities: caption.entities,
          });
          return result.data[0];
        }

        media.push({
          media: new InputFile(await got.stream(image.url).toArray()),
          type: "photo",
          caption: caption.text,
          caption_entities: caption.entities,
        });
      }

      await telegram.sendMediaGroup(chatId, media, {
        reply_parameters: {
          message_id: msgId,
          allow_sending_without_reply: true,
        },
      });

      return "Resulting AI generated images sent to user";
    },
  }),

  generate_image_sdxl: hyper({
    description: "Generate an image using Stable Diffusion",
    args: {
      prompt: z
        .string()
        .describe(
          "Prompt to use to generate image. Improve and expand on it. Example: An astronaut riding a rainbow unicorn, cinematic, dramatic",
        ),
      width: z.number().default(1024),
      height: z.number().default(1024),
      negative_prompt: z
        .string()
        .default(
          [
            "Ugly",
            "Bad anatomy",
            "Bad proportions",
            "Bad quality",
            "Blurry",
            "Cropped",
            "Deformed",
            "Disconnected limbs",
            "Out of frame",
            "Out of focus",
            "Dehydrated",
            "Error",
            "Disfigured",
            "Disgusting",
            "Extra arms",
            "Extra limbs",
            "Extra hands",
            "Fused fingers",
            "Gross proportions",
            "Long neck",
            "Low res",
            "Low quality",
            "Jpeg",
            "Jpeg artifacts",
            "Malformed limbs",
            "Mutated",
            "Mutated hands",
            "Mutated limbs",
            "Missing arms",
            "Missing fingers",
            "Picture frame",
            "Poorly drawn hands",
            "Poorly drawn face",
            "Text",
            "Signature",
            "Username",
            "Watermark",
            "Worst quality",
            "Collage",
            "Pixel",
            "Pixelated",
            "Grainy",
          ].join(" "),
        ),
    },
    async handler(
      { prompt, width, height, negative_prompt },
      { chatId, msgId },
    ) {
      const replicate = new Replicate();
      logger.info(
        { prompt, width, height, negative_prompt },
        "Generating image using SDXL with params",
      );
      const output = await replicate
        .run(
          "stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc",
          {
            input: {
              width,
              height,
              prompt,
              negative_prompt,
              prompt_strength: 0.8,
              high_noise_frac: 0.8,
              guidance_scale: 7.5,
              refine: "expert_ensemble_refiner",
              apply_watermark: false,
              num_inference_steps: 50,
              disable_safety_checker: true,
            },
          },
        )
        .then((o) => z.array(z.string()).parse(o));

      const caption = fmt([
        fmt`\n${bold("Prompt")}: ${prompt}`,
        fmt`\n${bold("Negative Prompt")}: ${negative_prompt ?? "None"}`,
        fmt`\n${bold("Width")}: ${width}`,
        fmt`\n${bold("Height")}: ${height}`,
      ]);

      await telegram.sendPhoto(chatId, output[0], {
        caption: caption.text,
        caption_entities: caption.entities,
        reply_parameters: {
          message_id: msgId,
          allow_sending_without_reply: true,
        },
      });

      return output;
    },
  }),

  rembg: hyper({
    description:
      "Removes background from images. Specify absolute filepath or URL",
    args: {
      filepath_or_url: z.string(),
    },
    async handler({ filepath_or_url }, { chatId, msgId }) {
      let filepath: string | null = null;
      let url: URL | null = null;

      try {
        url = new URL(filepath_or_url);
        const file = got.stream(url);
        filepath = path.join(
          os.tmpdir(),
          `rembg-${createId()}.${fileTypeFromStream(file)}`,
        );
        await streamPipeline(file, fs.createWriteStream(filepath));
      } catch {
        if (!fs.existsSync(filepath_or_url)) return "File not found.";
        filepath = filepath_or_url;
      }

      const replicate = new Replicate();
      const result = await replicate
        .run(
          "cjwbw/rembg:fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003",
          {
            input: {
              image: url ? url : await fs.promises.readFile(filepath),
            },
          },
        )
        .then((o) => z.string().parse(o));

      await telegram.sendPhoto(chatId, result, {
        reply_parameters: {
          message_id: msgId,
          allow_sending_without_reply: true,
        },
      });

      return ["Output image sent to user.", result].join("\n");
    },
  }),

  publish_markdown: hyper({
    description: "Upload Markdown text as file, returns a URL pointing to it",
    args: {
      md: z.string(),
    },
    async handler({ md }) {
      logger.info("Publishing markdown to web");

      const completion: OpenAI.Chat.ChatCompletion = await got
        .post("https://openrouter.ai/api/v1/chat/completions", {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          },
          json: {
            model: "meta-llama/llama-3.1-8b-instruct:free",
            messages: [
              {
                role: "system",
                content: "You are a helpful assistant.",
              },
              {
                role: "user",
                content: [
                  "Generate a suitable title for the following article:",
                  md,
                  "Reply only with the title and nothing else.",
                ].join("\n"),
              },
            ],
          },
        })
        .json();

      const insertResult = await db
        .insert(schema.fullResponses)
        .values({
          title: completion.choices[0].message.content,
          content: md,
        })
        .returning();
      const published = insertResult[0];
      return `Content published at ${process.env.WEB_SITE_URL}/telegram/${published.id}`;
    },
  }),

  code_interpreter: hyper({
    description:
      "Python interpreter. Can be used for arithmetic operations and other tasks.",
    args: {
      code: z
        .string()
        .describe(
          [
            "Code to execute. Will be interpreted. Returns stdout.",
            "Use print() or set output variable to get result.",
            "Inline expressions will be evaluated.",
          ].join("\n"),
        ),
    },
    async handler({ code }, { chatId }) {
      const result = await callPython("exec", {
        code,
      });

      const resultNotification = fmt([
        underline("Code interpreter output"),
        pre(JSON.stringify(result, undefined, 4), "json"),
      ]);
      await telegram.sendMessage(chatId, resultNotification.text, {
        entities: resultNotification.entities,
        disable_notification: true,
      });

      return result;
    },
  }),
});
