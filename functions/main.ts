import { DATA_DIR } from "@/bot/constants.js";
import { activeRequests } from "@/bot/handler";
import logger from "@/bot/logger.js";
import { telegram } from "@/bot/telegram.js";
import { db, tables } from "@/db/db.js";
import { BROWSER } from "@/helpers/browser.js";
import { getEnv } from "@/helpers/env.js";
import { ToolData } from "@/helpers/function";
import { convertHtmlToMarkdown } from "@/helpers/markdown.js";
import { runModel } from "@/helpers/replicate.js";
import { runCommand } from "@/helpers/shell.js";
import { kv } from "@/kv/redis";
import { bold, fmt, italic } from "@grammyjs/parse-mode";
import { createId } from "@paralleldrive/cuid2";
import { tool } from "ai";
import axios from "axios";
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

/**
 * A set of functions which are included in every LLM call.
 *
 * These are the most essential for interacting with Telegram
 * and therefore, have to be as streamlined and useful
 * as possible.
 */
export const mainFunctions = (data: ToolData) => {
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

    get_link_contents: tool({
      description: "Get contents from a webpage in Markdown format",
      parameters: z.object({
        url: z.string(),
      }),
      async execute({ url }) {
        const page = await BROWSER.newPage();
        await page.goto(url, {
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
        const lim = tok.slice(0, 2048);
        const txt = new TextDecoder().decode(enc.decode(lim));
        enc.free();

        if (txt.length > 0) {
          return txt;
        } else {
          return "Webpage content is empty!";
        }
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

        await telegram.sendVoice(data.chatId, new InputFile(outputPath), {
          reply_parameters: {
            message_id: data.msgId,
          },
        });

        await Promise.all([
          fs.promises.rm(spokenPath, { recursive: true, force: true }),
          fs.promises.rm(outputPath, { recursive: true, force: true }),
        ]);

        return "Voice message sent to user.";
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
          "3:2",
          "2:3",
          "4:5",
          "5:4",
          "3:4",
          "4:3",
          "9:16",
          "9:21",
        ]),
      }),
      async execute({ prompt, aspect_ratio }) {
        logger.info({ prompt, aspect_ratio }, "Generating image using FLUX");
        const output = await runModel(
          "black-forest-labs/flux-schnell",
          z.object({
            seed: z
              .number()
              .int()
              .describe("Random seed. Set for reproducible generation")
              .optional(),
            prompt: z.string().describe("Prompt for generated image"),
            go_fast: z
              .boolean()
              .describe(
                "Run faster predictions with model optimized for speed (currently fp8 quantized); disable to run in original bf16",
              )
              .default(true),
            megapixels: z
              .enum(["1", "0.25"])
              .describe("Approximate number of megapixels for generated image")
              .default("1"),
            num_outputs: z
              .number()
              .int()
              .gte(1)
              .lte(4)
              .describe("Number of outputs to generate")
              .default(1),
            aspect_ratio: z
              .enum([
                "1:1",
                "16:9",
                "21:9",
                "3:2",
                "2:3",
                "4:5",
                "5:4",
                "3:4",
                "4:3",
                "9:16",
                "9:21",
              ])
              .describe("Aspect ratio for the generated image")
              .default("1:1"),
            output_format: z
              .enum(["webp", "jpg", "png"])
              .describe("Format of the output images")
              .default("webp"),
            output_quality: z
              .number()
              .int()
              .gte(0)
              .lte(100)
              .describe(
                "Quality when saving the output images, from 0 to 100. 100 is best quality, 0 is lowest quality. Not relevant for .png outputs",
              )
              .default(80),
            num_inference_steps: z
              .number()
              .int()
              .gte(1)
              .lte(4)
              .describe(
                "Number of denoising steps. 4 is recommended, and lower number of steps produce lower quality outputs, faster.",
              )
              .default(4),
            disable_safety_checker: z
              .boolean()
              .describe("Disable safety checker for generated images.")
              .default(false),
          }),
          z.array(z.string()),
          {
            prompt,
            num_outputs: 1,
            aspect_ratio,
            output_format: "png",
          },
        );

        const caption = fmt([fmt`\n${bold("Prompt")}: ${italic(prompt)}`]);

        await telegram.sendPhoto(data.chatId, output[0], {
          caption: caption.text,
          caption_entities: caption.entities,
          reply_parameters: {
            message_id: data.msgId,
            allow_sending_without_reply: true,
          },
        });

        return output;
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

    calculate: tool({
      description: [
        "Evaluate mathematical expressions.",
        "Example expressions:",
        "'1.2 * (2 + 4.5)', '12.7 cm to inch', 'sin(45 deg) ^ 2'.",
      ].join(" "),
      parameters: z.object({ expression: z.string() }),
      execute: async ({ expression }) => mathjs.evaluate(expression),
    }),

    publish_mdx: tool({
      description: "Publish a webpage with MDX content",
      parameters: z.object({
        title: z.string().describe("Title of webpage"),
        content: z.string(),
      }),
      async execute({ title, content }) {
        const result = await axios({
          method: "post",
          url: `${getEnv("RAPHTLW_URL")}/api/raphgpt/document`,
          headers: {
            Authorization: `Bearer ${getEnv("RAPHTLW_API_KEY")}`,
            "Content-Type": "application/json",
          },
          data: {
            title,
            content,
          },
        }).then((response) =>
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
            .parse(response.data),
        );

        const url = `${getEnv("RAPHTLW_URL")}/raphgpt/${result.doc._id}`;

        const publishNotification = fmt([
          "I've published a new webpage.",
          "\n",
          "You can view it at this URL: ",
          url,
        ]);
        await telegram.sendMessage(data.chatId, publishNotification.text, {
          entities: publishNotification.entities,
          reply_parameters: {
            message_id: data.msgId,
            allow_sending_without_reply: true,
          },
        });

        return url;
      },
    }),

    cancel: tool({
      description: "Interrupt and stop thinking of a response",
      parameters: z.object({}),
      async execute() {
        if (activeRequests.has(data.userId)) {
          activeRequests.get(data.userId)?.abort();
          activeRequests.delete(data.userId);
        }

        // Remove all pending requests
        await kv.DEL(`pending_requests:${data.chatId}:${data.userId}`);

        return "Stopped generating response.";
      },
    }),
  };
};
