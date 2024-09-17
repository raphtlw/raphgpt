import { bold, fmt, italic } from "@grammyjs/parse-mode";
import { createId } from "@paralleldrive/cuid2";
import { generateText, tool } from "ai";
import { eq } from "drizzle-orm";
import fs from "fs";
import got from "got";
import { InputFile } from "grammy";
import * as mathjs from "mathjs";
import path from "path";
import Replicate from "replicate";
import { pipeline as streamPipeline } from "stream/promises";
import { encoding_for_model } from "tiktoken";
import { z } from "zod";
import { DATA_DIR } from "../bot/constants.js";
import logger from "../bot/logger.js";
import { telegram } from "../bot/telegram.js";
import { db, tables } from "../db/db.js";
import { BROWSER } from "../helpers/browser.js";
import { getEnv } from "../helpers/env.js";
import { convertHtmlToMarkdown } from "../helpers/markdown.js";
import { openrouter } from "../helpers/openrouter.js";
import { runModel } from "../helpers/replicate.js";
import { runCommand } from "../helpers/shell.js";

export const mainFunctions = (
  userId: number,
  chatId: number,
  msgId: number,
) => {
  return {
    search_google: tool({
      description:
        "Get relevant search results from Google in JSON format. Use this to answer questions that require up to date info, or to get links from web results. Unable to do location searching.",
      parameters: z.object({
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
      }),
      async execute({ query, gl = "SG", link_site, search_type }) {
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

            const markdown = await convertHtmlToMarkdown(html);

            logger.debug(markdown);

            await page.close();

            // limit content length to fit context size for model
            const enc = encoding_for_model("gpt-4o");
            const tok = enc.encode(markdown);
            const lim = tok.slice(0, 512);
            const txt = new TextDecoder().decode(enc.decode(lim));
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

    read_text: tool({
      description:
        "Reads out text for the user to listen to. To be used in a chatbot-like fashion, where the user listens to your speech",
      parameters: z.object({
        text: z
          .string()
          .describe(
            [
              "Text in simple and easy to understand form. Replace all special characters with descriptions of them, e.g. 1. as 'One.' and #aaa as 'Hashtag aaa'",
              "Use emotion and adjective tags like [laughs] and [excited]",
              "You can also emulate real human-like sound effects like [clears throat]",
            ].join("\n"),
          ),
      }),
      async execute({ text }) {
        const replicate = new Replicate();
        const spoken = await replicate
          .run(
            "suno-ai/bark:b76242b40d67c76ab6742e987628a2a9ac019e11d56ab96c4e91ce03b79b2787",
            {
              input: {
                prompt: text,
                text_temp: 0.5,
                waveform_temp: 0.5,
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
        const spokenPath = path.join(DATA_DIR, `voice-${createId()}.wav`);
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

    sing_song: tool({
      description: "Generates a song using AI.",
      parameters: z.object({
        prompt: z
          .string()
          .describe("Melody description, how it should be played."),
        lyrics: z
          .string()
          .describe(
            "Song lyrics with descriptive melody tags. Do not label sections.",
          ),
      }),
      async execute({ prompt, lyrics }) {
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
        const durationAsString = duration.stdout.match(
          /duration="?(\d*\.\d*)"?/,
        );
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

    find_place: tool({
      description:
        "Search for a place or commodity on Google Maps and returns 5 most relevant results",
      parameters: z.object({
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
      }),
      async execute({ text_query, lat, lon }) {
        logger.debug({ text_query, lat, lon });

        const res = await got
          .post("https://places.googleapis.com/v1/places:searchText", {
            headers: {
              "X-Goog-Api-Key": getEnv("GOOGLE_MAPS_API_KEY"),
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

    read_file: tool({
      description: "Access local file by ID",
      parameters: z.object({
        id: z.number().describe("File ID"),
      }),
      async execute({ id }) {
        const file = await db.query.localFiles.findFirst({
          where: eq(tables.localFiles.id, id),
        });
        if (!file) throw "File does not exist";
        logger.info(`Loading file contents of ID ${file.id}`);
        return file.content;
      },
    }),

    generate_image: tool({
      description: "Generate image using flux-pro",
      parameters: z.object({
        prompt: z.string(),
        aspect_ratio: z.enum([
          "1:1",
          "16:9",
          "21:9",
          "2:3",
          "3:2",
          "4:5",
          "5:4",
          "9:16",
          "9:21",
        ]),
      }),
      async execute({ prompt, aspect_ratio }) {
        logger.info({ prompt, aspect_ratio }, "Generating image using FLUX");
        const output = await runModel(
          "black-forest-labs/flux-schnell",
          {
            prompt,
            num_outputs: 1,
            aspect_ratio,
            output_format: "png",
          },
          z.array(z.string()),
        );

        const caption = fmt([fmt`\n${bold("Prompt")}: ${italic(prompt)}`]);

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

    publish_markdown: tool({
      description: "Upload Markdown text as file, returns a URL pointing to it",
      parameters: z.object({
        md: z.string(),
      }),
      async execute({ md }) {
        logger.info("Publishing markdown to web");

        const { text: title } = await generateText({
          model: openrouter("meta-llama/llama-3.1-8b-instruct:free"),
          system: "You are a helpful assistant.",
          prompt: [
            "Generate a suitable title for the following article:",
            md,
            "Reply only with the title and nothing else.",
          ].join("\n"),
        });

        const insertResult = await db
          .insert(tables.fullResponses)
          .values({
            title,
            content: md,
          })
          .returning();
        const published = insertResult[0];
        return `Content published at ${getEnv("WEB_SITE_URL")}/telegram/${published.id}`;
      },
    }),

    get_weather: tool({
      description: "Search weather information",
      parameters: z.object({
        lat: z.number().describe("Latitude, decimal (-90; 90)"),
        lon: z.string().describe("Longitude, decimal (-180; 180)"),
        units: z.enum(["standard", "metric", "imperial"]),
      }),
      async execute({ lat, lon, units }) {
        const res = await got(
          "https://api.openweathermap.org/data/3.0/onecall",
          {
            searchParams: {
              lat,
              lon,
              units,
              appid: getEnv("OPENWEATHER_API_KEY"),
            },
          },
        ).json();

        logger.debug(res, "OpenWeather API response");

        return res;
      },
    }),

    delete_personality: tool({
      parameters: z.object({
        id: z.number().describe("ID of personality record to remove"),
      }),
      async execute({ id }) {
        await db
          .delete(tables.personality)
          .where(eq(tables.personality.id, id));

        return "Removed memory from database";
      },
    }),

    add_personality: tool({
      parameters: z.object({
        text: z
          .string()
          .describe(
            "What to remember to alter my behavior when responding to future messages, in plain text",
          ),
      }),
      async execute({ text }) {
        await db.insert(tables.personality).values({
          userId,
          content: text,
        });

        await telegram.sendMessage(chatId, "Updated personality", {
          disable_notification: true,
        });

        return "Updated personality, notified user. Continue function calls.";
      },
    }),

    calculate: tool({
      description: [
        "Evaluate mathematical expressions.",
        "Example expressions:",
        "'1.2 * (2 + 4.5)', '12.7 cm to inch', 'sin(45 deg) ^ 2'.",
      ].join(" "),
      parameters: z.object({ expression: z.string() }),
      execute: async ({ expression }) => mathjs.evaluate(expression),
    }),
  };
};
