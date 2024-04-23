import {
  Client as GoogleMapsClient,
  Status,
} from "@googlemaps/google-maps-services-js";
import { fmt, italic } from "@grammyjs/parse-mode";
import { createId } from "@paralleldrive/cuid2";
import decodeQR from "@paulmillr/qr/decode";
import { ind } from "@raphtlw/indoc";
import {
  Conversation,
  combineMessageContent,
  runModel,
  transcribeAudio,
} from "ai";
import { hyper, hyperStore } from "ai/hyper";
import * as GoogleSearch from "api/google-search";
import assert from "assert";
import axios from "axios";
import { Command } from "bot/command";
import { sendMarkdownMessage } from "bot/message";
import { calculateDetailAmounts } from "common/image-processing";
import { addDays, addHours, intlFormat, parseISO } from "date-fns";
import { db } from "db";
import { messages, openaiMessages } from "db/schema";
import { and, eq } from "drizzle-orm";
import fs from "fs";
import got from "got";
import { Api } from "grammy";
import { Message } from "grammy/types";
import { minify } from "html-minifier";
import Jimp from "jimp";
import { joinImages } from "join-images";
import { evaluate } from "mathjs";
import mime from "mime";
import OpenAI from "openai";
import path from "path";
import { Browser } from "puppeteer";
import sanitizeHTML from "sanitize-html";
import { Env } from "secrets/env";
import sharp, { Sharp } from "sharp";
import { pipeline } from "stream/promises";
import { encoding_for_model } from "tiktoken";
import TurndownService from "turndown";
import { inspect } from "util";
import { z } from "zod";

const openai = new OpenAI({ apiKey: Env.OPENAI_API_KEY });

export type ContextType = { messageId: string; browser: Browser };

export const functions = hyperStore<ContextType>({
  transcribe_audio: hyper({
    description: "Transcribe audio file",
    args: {
      audio: z.string().describe("The audio file url/path to transcribe"),
    },
    async handler({ audio }) {
      const fileId = createId();

      let url = audio;

      const localPath = path.join(process.cwd(), "data", "file", audio);
      if (!fs.existsSync(url)) {
        if (fs.existsSync(localPath)) {
          url = localPath;
        } else {
          const outPath = path.join(
            process.cwd(),
            "data",
            "file",
            `${fileId}.unknown`,
          );
          await pipeline(got.stream(url), fs.createWriteStream(outPath));
          url = outPath;
        }
      }

      return await transcribeAudio(url);
    },
  }),
  recognise_song: hyper({
    description:
      "Detect song from audio using sound recognition. To be used only if the user explicitly requests for music recognition.",
    args: {
      audio: z.string().describe("URL or path to audio file to process"),
    },
    async handler({ audio }) {
      const fileId = createId();

      let url = audio;

      const localPath = path.join(process.cwd(), "data", "file", audio);
      if (!fs.existsSync(url)) {
        if (fs.existsSync(localPath)) {
          url = localPath;
        } else {
          const outPath = path.join(
            process.cwd(),
            "data",
            "file",
            `${fileId}.unknown`,
          );
          await pipeline(got.stream(url), fs.createWriteStream(outPath));
          url = outPath;
        }
      }

      const audioOutputPath = path.join(
        process.cwd(),
        "data",
        "file",
        `${fileId}.output.mp3`,
      );

      // convert file to mp3
      await Command(
        `ffmpeg -i "${url}" -vn -ac 2 -ar 44100 -ab 320k -f mp3 ${audioOutputPath}`,
      ).run();

      const response = await axios({
        method: "post",
        url: "https://api.audd.io/recognize",
        data: {
          api_token: Env.AUDD_API_TOKEN,
          file: fs.createReadStream(audioOutputPath),
          return: "spotify,apple_music",
        },
        headers: { "Content-Type": "multipart/form-data" },
        responseType: "json",
      });

      await fs.promises.rm(audioOutputPath);

      return response.data.result || "No song found.";
    },
  }),
  vision: hyper({
    description: "Use OpenAI to describe an image",
    args: {
      image: z.string().describe("Link/path to image for GPT-4V model"),
      usage: z
        .string()
        .describe(
          "Description of intended purpose, instruction for the model on exactly what kind of information to extract",
        ),
      format: z.string().describe("Format of extracted data"),
      system: z
        .string()
        .describe(
          "Instructions for model to better understand what it needs to do, in extended detail.",
        ),
    },
    async handler({ image, usage, format, system }) {
      let url = image;

      const localPath = path.join(process.cwd(), "data", "file", image);
      if (fs.existsSync(localPath)) {
        url = localPath;
      }
      if (fs.existsSync(url)) {
        const data = await fs.promises.readFile(url, {
          encoding: "base64",
        });
        const mimeType = mime.getType(localPath);
        url = `data:${mimeType};base64,${data}`;
      }

      const completion = await openai.chat.completions.create({
        max_tokens: 2048,
        messages: [
          {
            role: "system",
            content: [
              "You are an image analysis model, created to",
              usage,
              "You are to extract the data in the following format:",
              format,
              system,
              ind(`
              If image is a receipt:
              You are to extract every bit of information from the receipt.
              When extracting, please make sure to list every item individually.
              Expand and elaborate on its name for brevity. Give additional tags
              to what the item might be named.
              If an item has more than one quantity, do not state its quantity.
              Instead, repeat the item for the amount of quantities in the receipt,
              and write its price next to it.

              Receipts are left to right. The information on the left always
              shows the name of the item. If there are any sub-items, list them.
              The prices are shown on the right. List the prices of every
              individual item in detail.

              If the receipt contains a GST record, list it.
              If the receipt contains a Service Charge (S.C.) record, list it.
              List all other properties of the receipt.`),
            ].join("\n"),
          },
          {
            content: [
              { text: "Analyze the image in detail", type: "text" },
              {
                image_url: {
                  url,
                },
                type: "image_url",
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-4-turbo",
      });
      console.log("Completion:", inspect(completion.choices, true, 10, true));

      return completion.choices[0].message.content;
    },
  }),
  process_video: hyper({
    description: "Analyze frames from a video using GPT-4V",
    args: {
      video: z.string().describe("Link/path to video"),
    },
    async handler({ video }, { messageId }) {
      const fileId = createId();

      let url = video;

      const localPath = path.join(process.cwd(), "data", "file", video);
      if (!fs.existsSync(url)) {
        if (fs.existsSync(localPath)) {
          url = localPath;
        } else {
          const outPath = path.join(
            process.cwd(),
            "data",
            "file",
            `${fileId}.unknown`,
          );
          await pipeline(got.stream(url), fs.createWriteStream(outPath));
          url = outPath;
        }
      }

      const message = await db.query.messages.findFirst({
        where: eq(messages.id, messageId),
      });
      assert(message, "Failed to retrieve message from DB");
      const msg: Message = JSON.parse(message.contextData);

      const framesOutputPath = path.join(process.cwd(), `${fileId}.capture`);
      const stitchedFramesOutputPath = path.join(
        process.cwd(),
        `${fileId}.png`,
      );

      // extract frames
      await fs.promises.mkdir(framesOutputPath);
      await Command(
        `ffmpeg -i ${url} -vf fps=30 ${framesOutputPath}/%d.png`,
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

      // stitch frames together
      const stitchedFrames = await joinImages(
        await Promise.all(processedFrames.map((frame) => frame.toBuffer())),
        {
          direction: "horizontal",
        },
      );
      await stitchedFrames.toFile(stitchedFramesOutputPath);
      const framestrip = await fs.promises.readFile(stitchedFramesOutputPath, {
        encoding: "base64",
      });

      // save image which prompted the response
      const lastFramePath = path.join("data", "file", `${fileId}.last.png`);
      await processedFrames[processedFrames.length - 1].toFile(lastFramePath);

      // delete temp folders
      await Promise.all([
        fs.promises.rm(framesOutputPath, { force: true, recursive: true }),
        fs.promises.rm(stitchedFramesOutputPath),
      ]);

      // ask GPT-4 to describe video, with audio transcript
      const completion = await openai.chat.completions.create({
        max_tokens: 2048,
        messages: [
          {
            content: [
              {
                text: `The image shows video frames in sequence. Describe what's likely going on in each frame.`,
                type: "text",
              },
              {
                image_url: {
                  url: `data:image/jpeg;base64,${framestrip}`,
                },
                type: "image_url",
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-4-turbo",
      });

      return [
        completion.choices[0].message.content,
        `Analyze the video's last frame to better respond to the transcript: ${lastFramePath}`,
      ].join("\n");
    },
  }),
  generate_image: hyper({
    description:
      "Generate image using DALL-E model. Only to be used when user explicitly requests for an AI generated image.",
    args: {
      prompt: z
        .string()
        .describe("Prompt text, almost exactly what user requests for"),
      quality: z.enum(["standard", "hd"]),
      size: z.enum(["1024x1024", "1792x1024", "1024x1792"]),
      style: z.enum(["vivid", "natural"]).optional(),
    },
    async handler({ prompt, quality, size, style = "vivid" }, { messageId }) {
      const message = await db.query.messages.findFirst({
        where: eq(messages.id, messageId),
      });
      assert(message, "Failed to retrieve message from DB");
      const msg: Message = JSON.parse(message.contextData);

      const response = await openai.images.generate({
        model: "dall-e-3",
        prompt,
        quality: quality,
        size: size,
        style: style,
      });
      console.log("DALL-E Generation:", inspect(response, true, 10, true));

      const responses: string[] = [];

      const tg = new Api(Env.TELEGRAM_API_KEY);
      await tg
        .sendMediaGroup(
          msg.chat.id,
          response.data.map((img) => {
            const imgcaption = fmt`💭 ${italic(img.revised_prompt ?? "Generated image")} ✨`;

            return {
              media: img.url!,
              type: "photo",
              caption: imgcaption.text,
              caption_entities: imgcaption.entities,
            };
          }),
          {
            message_thread_id:
              msg.message_thread_id ??
              msg.reply_to_message?.message_id ??
              msg.message_id,
            reply_parameters: {
              message_id: msg.message_id,
              allow_sending_without_reply: true,
            },
          },
        )
        .catch((e) => console.error(e));

      responses.push(JSON.stringify(response));

      return responses;
    },
  }),
  nutrition_analyzer: hyper({
    description:
      "Analyze foods nutritional content using natural language understanding. Incapable of calculating price of food items.",
    args: {
      foods: z.string().describe("Clear and elaborate description of food"),
      instruction: z
        .string()
        .describe(
          "Prompt for the GPT-4 model to determine what kind of analysis to be done, in detail",
        ),
    },
    async handler({ foods, instruction }, { messageId }) {
      const message = await db.query.messages.findFirst({
        where: eq(messages.id, messageId),
      });
      assert(message, "Failed to retrieve message from DB");
      const msg: Message = JSON.parse(message.contextData);

      const history = new Conversation();
      const current = new Conversation([
        { role: "system", content: ind(`You are a food analysis assistant.`) },
        {
          role: "user",
          content: ind(`
          Given the following food: ${foods}
          ${instruction}`),
        },
      ]);

      const apiTools = hyperStore({
        ingredient_search: hyper({
          description:
            "Search for ingredients in a food database. Example: Red bean",
          args: {
            ingredient_name: z
              .string()
              .describe(
                "Search query for simple whole foods (e.g. fruits, vegetables). No more than 3 words.",
              ),
          },
          async handler({ ingredient_name }) {
            const response = await axios.get(
              "https://api.spoonacular.com/food/ingredients/search",
              {
                params: { query: ingredient_name },
                headers: {
                  "x-api-key": Env.SPOONTACULAR_API_KEY,
                },
                responseType: "json",
              },
            );

            return response.data;
          },
        }),
        ingredient_information: hyper({
          description:
            "Uses the spoonacular API to get nutritional data for a single ingredient",
          args: {
            ingredient_id: z.number().describe("Food ID from database"),
            amount: z
              .number()
              .describe("Amount of specified ingredient")
              .optional(),
            unit: z.string().describe("Unit for given amount").optional(),
          },
          async handler({ ingredient_id, amount, unit }) {
            const response = await axios.get(
              `https://api.spoonacular.com/food/ingredients/${ingredient_id}/information`,
              {
                params: { amount, unit },
                headers: {
                  "x-api-key": Env.SPOONTACULAR_API_KEY,
                },
                responseType: "json",
              },
            );

            return response.data;
          },
        }),
        recipe_search: hyper({
          description:
            "Search through thousands of recipes using advanced filtering and ranking",
          args: {
            query: z
              .string()
              .describe(
                "The recipe search query in natural language. No more than 3 words. Example: aglio olio",
              ),
            cuisine: z
              .string()
              .describe(
                "The cuisine of the recipes. One or more, comma separated",
              )
              .optional(),
            equipment: z
              .string()
              .describe(
                "The equipment required. Multiple values will be interpreted as 'or'. Example: blender,frying pan,bowl",
              )
              .optional(),
          },
          async handler({ query, cuisine, equipment }) {
            const response = await axios.get(
              "https://api.spoonacular.com/recipes/complexSearch",
              {
                params: {
                  query,
                  cuisine,
                  equipment,
                  addRecipeInformation: true,
                },
                headers: {
                  "x-api-key": Env.SPOONTACULAR_API_KEY,
                },
                responseType: "json",
              },
            );

            return response.data;
          },
        }),
        recipe_information: hyper({
          description:
            "Uses the spoonacular API to get recipe data by ID. Only call this once you have confirmed the recipe to show the user.",
          args: {
            id: z.number().describe("Recipe ID"),
          },
          async handler({ id }) {
            const response = await axios.get(
              `https://api.spoonacular.com/recipes/${id}/information`,
              {
                params: {},
                headers: {
                  "x-api-key": Env.SPOONTACULAR_API_KEY,
                },
                responseType: "json",
              },
            );

            return response.data;
          },
        }),
      });

      let modelResponse: OpenAI.Chat.Completions.ChatCompletionMessage;
      let shouldContinue: boolean;
      do {
        [modelResponse, shouldContinue] = await runModel(
          history,
          current,
          {},
          apiTools,
          "gpt-4-turbo",
        );

        const responseContent = combineMessageContent(modelResponse);
        if (responseContent && responseContent.length > 0) {
          await sendMarkdownMessage(msg.chat.id, responseContent, {
            message_thread_id: msg.message_thread_id,
            reply_parameters: {
              chat_id: msg.chat.id,
              message_id: msg.message_id,
              allow_sending_without_reply: true,
            },
          });
        }
      } while (shouldContinue);

      return modelResponse.content;
    },
  }),
  date: hyper({
    description: "Date manipulation, using natural language",
    args: {
      date: z
        .string()
        .describe(
          "Date, in any particular format. The date you wish to perform operations on.",
        ),
      timezone: z.string().describe("Users' timezone. Example: Asia/Singapore"),
      instructions: z
        .string()
        .describe("What exactly to do with the date, in detail."),
    },
    async handler({ date, timezone, instructions }, { messageId }) {
      const message = await db.query.messages.findFirst({
        where: eq(messages.id, messageId),
      });
      assert(message, "Failed to retrieve message from DB");
      const msg: Message = JSON.parse(message.contextData);

      const history = new Conversation();
      const current = new Conversation([
        {
          role: "system",
          content: ind(`
          You are a date manipulation assistant. Make use of all the functions you have access to and
          perform the task at hand.`),
        },
        {
          role: "user",
          content: ind(`
          Start by parsing the date ${date} with reference to ${new Date().toISOString()}
          as a default, and perform the task:
          ${instructions}.
          My current timezone: ${timezone}`),
        },
      ]);

      let dateObj = new Date();

      let modelResponse: OpenAI.Chat.Completions.ChatCompletionMessage;
      while (
        ([modelResponse] = await runModel(
          history,
          current,
          {},
          hyperStore({
            parse_date: hyper({
              description: "Parse a date from an ISO string",
              args: {
                date: z
                  .string()
                  .describe(
                    "Date to parse, in ISO 8601 calendar date extended format",
                  ),
              },
              handler({ date }) {
                dateObj = parseISO(date);
              },
            }),
            add_hours: hyper({
              description: "Add hours to date",
              args: {
                hours: z.number().describe("Hours to add"),
              },
              handler({ hours }) {
                dateObj = addHours(dateObj, hours);
              },
            }),
            add_days: hyper({
              description: "Add days to date",
              args: {
                days: z.number().describe("Days to add"),
              },
              handler({ days }) {
                dateObj = addDays(dateObj, days);
              },
            }),
            get_date: hyper({
              description: "Format processed date in localized format",
              args: {
                timezone: z
                  .string()
                  .describe("Timezone to convert date to before formatting."),
              },
              handler() {
                return intlFormat(dateObj, {
                  dateStyle: "full",
                  timeStyle: "full",
                  timeZone: "Asia/Singapore",
                });
              },
            }),
          }),
          "gpt-4-turbo",
        ))[1] === true
      ) {
        const responseContent = combineMessageContent(modelResponse);
        if (responseContent && responseContent.length > 0) {
          await sendMarkdownMessage(msg.chat.id, responseContent, {
            message_thread_id: msg.message_thread_id,
            reply_parameters: {
              chat_id: msg.chat.id,
              message_id: msg.message_id,
              allow_sending_without_reply: true,
            },
          });
        }
      }

      return modelResponse.content;
    },
  }),
  get_crypto_data: hyper({
    description:
      "Fetch crypto data from CoinGecko's Public API. Only used to answer crypto related questions.",
    args: {
      query_params: z
        .string()
        .describe(
          "Query parameters to be added to the end, joined by & (ampersand) symbols, in http URL format.",
        ),
      query_path: z
        .string()
        .describe("CoinGecko Public API query path excluding the endpoint"),
    },
    async handler({ query_params, query_path }) {
      return await got(
        `https://api.coingecko.com/api/v3/${query_path}?x_cg_demo_api_key=${Env.COINGECKO_API_KEY}&${query_params}`,
      ).json();
    },
  }),
  search_google: hyper({
    description:
      "Get relevant search results from Google in JSON format. Use this to answer questions that require browsing the web/up to date info, or to get links from web results. Unable to do location searching.",
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
    async handler({ query, gl = "SG", link_site, search_type }, { browser }) {
      const params = new URLSearchParams({
        cx: Env.GOOGLE_CUSTOM_SEARCH_ENGINE_ID,
        key: Env.GOOGLE_CUSTOM_SEARCH_API_KEY,
        q: query,
      });
      if (gl) params.append("gl", gl);
      if (link_site) params.append("linkSite", link_site);
      if (search_type) params.append("searchType", search_type);
      const res = await got(
        `https://customsearch.googleapis.com/customsearch/v1?` + params,
      ).json<GoogleSearch.Root>();
      // console.log("Google Search Response:", inspect(res, true, 10, true));

      const results: {
        title: string;
        link: string;
        snippet: string;
        content?: string;
      }[] = res.items.map(({ title, link, snippet }) => ({
        title,
        link,
        snippet,
      }));

      // get first 5 result contents
      for (let i = 0; i < 5; i++) {
        try {
          const page = await browser.newPage();
          await page.goto(results[i].link, {
            waitUntil: "domcontentloaded",
          });
          let html = await page.content();
          html = html.replace(/<\//g, "</");
          html = sanitizeHTML(html, {
            allowedTags: sanitizeHTML.defaults.allowedTags.concat([
              "img",
              "iframe",
            ]),
          });
          html = minify(html, {
            caseSensitive: true,
            collapseBooleanAttributes: true,
            collapseInlineTagWhitespace: true,
            collapseWhitespace: true,
            conservativeCollapse: true,
            continueOnParseError: true,
            decodeEntities: true,
            html5: true,
            includeAutoGeneratedTags: true,
            keepClosingSlash: true,
            minifyCSS: true,
            minifyJS: true,
            minifyURLs: false,
            preserveLineBreaks: true,
            preventAttributesEscaping: true,
            processConditionalComments: true,
            removeAttributeQuotes: true,
            removeComments: true,
            removeEmptyAttributes: true,
            removeEmptyElements: true,
            removeOptionalTags: true,
            removeRedundantAttributes: true,
            removeScriptTypeAttributes: true,
            removeStyleLinkTypeAttributes: true,
            removeTagWhitespace: true,
            sortAttributes: true,
            sortClassName: true,
            trimCustomFragments: true,
            useShortDoctype: true,
          });

          const td = new TurndownService();
          const md = td.turndown(html);

          console.log(md);

          await page.close();

          // limit content length to fit context size for model
          const encoder = encoding_for_model("gpt-3.5-turbo-0125");
          const encoded = encoder.encode(md);
          const truncatedToFitModelContextLength = encoded.slice(1024);
          const truncated = new TextDecoder().decode(
            encoder.decode(truncatedToFitModelContextLength),
          );
          // free up memory
          encoder.free();

          if (truncated.length > 0) {
            results[i].content = truncated;
          }
        } catch (e) {
          console.error(e);
        }
      }

      return results;
    },
  }),
  delete_older_function_calls: hyper({
    description:
      "Clean out older function calls with lesser importance from context history.",
    args: {},
    async handler(args, { messageId }) {
      const message = await db.query.messages.findFirst({
        where: eq(messages.id, messageId),
      });
      assert(message, "Failed to retrieve message from DB");
      const msg: Message = JSON.parse(message.contextData);

      const records = await db.query.openaiMessages.findMany({
        where: and(
          eq(openaiMessages.telegramChatId, message.telegramChatId),
          eq(
            openaiMessages.telegramThreadId,
            (msg.message_thread_id ?? msg.message_id).toString(),
          ),
        ),
      });

      let deletedCount = 0;

      for (const message of records) {
        const data = JSON.parse(message.json);
        console.log(message);
        if (
          (data.role === "assistant" && data.tool_calls) ||
          data.role === "tool"
        ) {
          await db
            .delete(openaiMessages)
            .where(eq(openaiMessages.id, message.id));
          deletedCount++;
        }
      }

      return `Deleted ${deletedCount} records from DB`;
    },
  }),
  find_nearby_places: hyper({
    description:
      "Search for places within a specified area by text query. A Nearby Search must always include a location. Can be used to retrieve links and photos for a particular establishment.",
    args: {
      keywords: z
        .string()
        .describe("Keywords to search. No more than 3 words."),
      latitude: z.number().describe("Latitude to search around"),
      longitude: z.number().describe("Longitude to search around"),
      filter: z
        .array(
          z
            .enum([
              "address_components",
              "formatted_address",
              "formatted_phone_number",
              "adr_address",
              "editorial_summary",
              "geometry",
              "plus_code",
              "icon",
              "icon_background_color",
              "icon_mask_base_uri",
              "international_phone_number",
              "name",
              "opening_hours",
              "permanently_closed",
              "business_status",
              "photos",
              "place_id",
              "price_level",
              "rating",
              "user_ratings_total",
              "reviews",
              "types",
              "url",
              "utc_offset",
              "vicinity",
              "website",
            ])
            .describe("Field names. Can be either one. No duplicates."),
        )
        .describe("What fields to retrieve. Will be included in results."),
      is_open_now: z
        .enum(["true", "false"])
        .describe("Only return results that are open now")
        .optional(),
    },
    async handler({ keywords, latitude, longitude, filter, is_open_now }) {
      const client = new GoogleMapsClient();
      const response = await client.textSearch({
        params: {
          location: {
            latitude,
            longitude,
          },
          query: keywords,
          opennow: is_open_now === "true",
          key: Env.GOOGLE_MAPS_API_KEY,
        },
      });
      const result = response.data;

      if (result.status === Status.OK) {
        return result.results.map((r) => {
          const filtered: Partial<Record<(typeof filter)[0], unknown>> = {
            url: r.url,
          };
          for (const key of Object.keys(r) as typeof filter) {
            if (filter.includes(key)) {
              filtered[key] = r[key];
            }
          }
          return filtered;
        });
      } else {
        return result.error_message;
      }
    },
  }),
  download_place_photos: hyper({
    description:
      "Download and resize photos related to a specified place using the Google Maps API Photo service.",
    args: {
      photo_reference: z.string().describe("Photo reference to download"),
      max_width: z
        .number()
        .describe("Maximum width of the resized photo")
        .optional(),
      max_height: z
        .number()
        .describe("Maximum height of the resized photo")
        .optional(),
    },
    async handler({ photo_reference, max_width, max_height }) {
      const client = new GoogleMapsClient();
      const response = await client.placePhoto({
        params: {
          photoreference: photo_reference,
          maxwidth: max_width || 400,
          maxheight: max_height || 300,
          key: Env.GOOGLE_MAPS_API_KEY,
        },
        responseType: "stream",
      });

      const photoPath = `data/file/${photo_reference}.png`;
      response.data.pipe(fs.createWriteStream(photoPath));

      return ind(`Saved path to photo: ${photoPath}`);
    },
  }),
  get_place_details: hyper({
    description: "Get details of place using the Google Maps API.",
    args: {
      place_id: z
        .string()
        .describe(
          "A textual identifier that uniquely identifies a place, returned from a Place Search.",
        ),
    },
    async handler({ place_id }) {
      const client = new GoogleMapsClient();
      const response = await client.placeDetails({
        params: {
          place_id,
          key: Env.GOOGLE_MAPS_API_KEY,
        },
      });

      return response.data;
    },
  }),
  // browser: hyper({
  //   description:
  //     "Web browser. Capable of receiving instructions and behaving like a human using a web browser.",
  //   args: {
  //     prompt: z
  //       .string()
  //       .describe("User request, and what they need from the website"),
  //   },
  //   async handler({ prompt }, { messageId, browser }) {
  //     const message = await db.query.messages.findFirst({
  //       where: eq(messages.id, messageId),
  //     });
  //     assert(message, "Failed to retrieve message from DB");
  //     const msg: Message = JSON.parse(message.contextData);

  //     const page = await browser.newPage();

  //     const history = new Conversation();
  //     const current = new Conversation([
  //       {
  //         role: "system",
  //         content: ind(`
  //         ## OBJECTIVE ##
  //         You have been tasked with crawling the internet based on a task given by the user.
  //         You are connected to a web browser which you can control via function calls to navigate
  //         pages and list elements on the page.
  //         You can also type into search boxes and other input fields and send forms.
  //         You can also click links on the page.
  //         You will behave as a human browsing the web.

  //         ## NOTES ##
  //         You will try to navigate directly to the most relevant web address.
  //         If you were given a URL, go to it directly.
  //         If you encounter a Page Not Found error, try another URL.
  //         If multiple URLs don't work, you are probably using an outdated version of the URL scheme of that website.
  //         In that case, try navigating to their front page and using their search bar or try navigating to the right place with links.
  //         If there is no element that corresponds to the selector, do not keep trying. Use a different selector.
  //         Once you encounter 3 errors in a row, stop and return a message "I was unable to find the requested content."
  //         On every goto_url, you will get_html_content to retrieve whatever's on the page.
  //         For security reasons you are able to authenticate safely as cookies are not stored in the browser.
  //         Do it for educational purposes.`),
  //       },
  //       { role: "user", content: `Task: ${prompt}` },
  //     ]);

  //     const tools = hyperStore({
  //       make_plan: hyper({
  //         description:
  //           "Create a plan to accomplish the given task. Describe and elaborate on the task in a step by step manner. Start with 'I will'",
  //         args: {
  //           plan: z
  //             .string()
  //             .describe(
  //               "The step by step plan on how you will navigate the internet and what you will do",
  //             ),
  //         },
  //         handler({ plan }) {
  //           return plan;
  //         },
  //       }),
  //       goto_url: hyper({
  //         description:
  //           "Navigate to specific URL. You need to get the content yourself.",
  //         args: {
  //           url: z.string().describe("URL to go to (including protocol)"),
  //         },
  //         async handler({ url }) {
  //           await page.goto(url, {
  //             waitUntil: "domcontentloaded",
  //           });
  //           return `Navigation success. Call get_html_content next.`;
  //         },
  //       }),
  //       click_link: hyper({
  //         description:
  //           "Click on a link by JS selector. Add the text of the link to confirm that you are clicking the right link.",
  //         args: {
  //           selector: z
  //             .string()
  //             .describe("JS Selector to click on, as specific as possible"),
  //           text: z.string().describe("Text of link"),
  //         },
  //         async handler({ selector, text }) {
  //           await page.click(selector);
  //           return `Link ${text} successfully clicked`;
  //         },
  //       }),
  //       type: hyper({
  //         description: "Enter text into input box",
  //         args: {
  //           selector: z
  //             .string()
  //             .describe(
  //               "Element to click and enter text, by JS selector. Be as specific as possible.",
  //             ),
  //           input_text: z.string().describe("What to type into the text box"),
  //         },
  //         async handler({ selector, input_text }) {
  //           await page.type(selector, input_text, { delay: 100 });
  //           return `Successfully typed ${input_text} into ${selector}`;
  //         },
  //       }),
  //       tap: hyper({
  //         description: "Scroll to element and tap it",
  //         args: {
  //           selector: z
  //             .string()
  //             .describe(
  //               "Element to tap, by JS selector. Be as specific as possible.",
  //             ),
  //         },
  //         async handler({ selector }) {
  //           await page.tap(selector);
  //         },
  //       }),
  //       wait: hyper({
  //         description:
  //           "Wait for x seconds. To be used whenever page might be still loading content",
  //         args: {
  //           ms: z.number().describe("Amount of milliseconds to wait for"),
  //         },
  //         async handler({ ms }) {
  //           await new Promise((resolve) => {
  //             setTimeout(resolve, ms);
  //           });
  //         },
  //       }),
  //       get_html_content: hyper({
  //         description: "Return full HTML content, including DOCTYPE",
  //         args: {},
  //         async handler() {
  //           let html = await page.content();
  //           html = html.replace(/<\//g, "</");
  //           html = sanitizeHTML(html, {
  //             allowedTags: sanitizeHTML.defaults.allowedTags.concat([
  //               "img",
  //               "button",
  //             ]),
  //             allowedAttributes: {
  //               ...sanitizeHTML.defaults.allowedAttributes,
  //               "*": ["class", "href", "src", "alt"],
  //             },
  //           });
  //           html = minify(html, {
  //             collapseWhitespace: true,
  //             removeComments: true,
  //             collapseBooleanAttributes: true,
  //             useShortDoctype: true,
  //             removeEmptyAttributes: true,
  //             removeEmptyElements: true,
  //             removeRedundantAttributes: true,
  //             removeOptionalTags: true,
  //             minifyJS: true,
  //           });

  //           console.log(html);

  //           return html;
  //         },
  //       }),
  //       screenshot: hyper({
  //         description: "Take a photo of the current viewport",
  //         args: {},
  //         async handler() {
  //           const screenshotPath = path.join(
  //             "data",
  //             "file",
  //             `Browser_${createId()}.png`,
  //           );

  //           await page.screenshot({
  //             path: screenshotPath,
  //           });

  //           return `Screenshot path: ${screenshotPath}`;
  //         },
  //       }),
  //       select: hyper({
  //         description: "Get content on webpage by selector",
  //         args: { selector: z.string() },
  //         async handler({ selector }) {
  //           return await page.$eval(selector, (el) => el.innerHTML);
  //         },
  //       }),
  //       eval: hyper({
  //         description: "Evaluate JavaScript on page",
  //         args: { expr: z.string().describe("Expression to evaluate") },
  //         async handler({ expr }) {
  //           return await page.evaluate(expr);
  //         },
  //       }),
  //       close_page: hyper({
  //         description: "Close the current page",
  //         args: {},
  //         async handler() {
  //           return await page.close();
  //         },
  //       }),
  //     });

  //     let modelResponse: OpenAI.Chat.Completions.ChatCompletionMessage;
  //     let shouldContinue: boolean;
  //     do {
  //       [modelResponse, shouldContinue] = await runModel(
  //         history,
  //         current,
  //         {},
  //         tools,
  //         "gpt-4-turbo",
  //       );

  //       const responseContent = combineMessageContent(modelResponse);
  //       if (responseContent && responseContent.length > 0) {
  //         await sendMarkdownMessage(msg.chat.id, responseContent, {
  //           message_thread_id: msg.message_thread_id,
  //           reply_parameters: {
  //             chat_id: msg.chat.id,
  //             message_id: msg.message_id,
  //             allow_sending_without_reply: true,
  //           },
  //         });
  //       }
  //     } while (shouldContinue);

  //     return modelResponse.content;
  //   },
  // }),
  http_request: hyper({
    description: "Run a HTTP request",
    args: {
      body: z.string().describe("Request body in JSON format"),
      method: z.enum([
        "GET",
        "PUT",
        "POST",
        "DELETE",
        "PATCH",
        "HEAD",
        "OPTIONS",
        "TRACE",
      ]),
      url: z
        .string()
        .describe("Request input URL, including query params and paths."),
    },
    async handler({ body, method, url }) {
      try {
        return await got(url, { body, method }).json();
      } catch (e) {
        console.error(e);
      }
    },
  }),
  read_qr_code: hyper({
    description: "Scan QR code",
    args: {
      image_url: z.string().describe("The image URL containing QR code"),
    },
    async handler({ image_url }) {
      const fileId = createId();

      let url = image_url;

      if (fs.existsSync(url) === false) {
        const localPath = path.join(process.cwd(), "data", "file", image_url);
        if (fs.existsSync(localPath)) {
          url = localPath;
        } else {
          const outPath = path.join(
            process.cwd(),
            "data",
            "file",
            `${fileId}.unknown`,
          );
          await pipeline(got.stream(url), fs.createWriteStream(outPath));
          url = outPath;
        }
      }

      const img = await Jimp.read(url);
      const decoded = decodeQR(img.bitmap);
      return decoded;
    },
  }),
  math: hyper({
    description: "Evaluate math expression using math.js",
    args: {
      expr: z.string().describe("Arbitrary math expression to evaluate"),
    },
    handler({ expr }) {
      return evaluate(expr);
    },
  }),
  get_weather_forecast: hyper({
    description: "Retrieve weather forecast data",
    args: {
      lat: z.string().describe("Latitude, decimal (-90; 90)."),
      lon: z.string().describe("Longitude, decimal (-180; 180)."),
      include: z.enum(["current", "minutely", "hourly", "daily", "alerts"]),
    },
    async handler({ lat, lon, include }) {
      const metrics = ["current", "minutely", "hourly", "daily", "alerts"];
      return await got(
        `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&units=metric&exclude=${metrics.filter((metric) => metric !== include)}&appid=${Env.OPENWEATHER_API_KEY}`,
      ).json();
    },
  }),
  get_singapore_metrological_data: hyper({
    description: "Get weather data in Singapore",
    args: {
      kind: z.enum([
        "rainfall",
        "relative-humidity",
        "air-temperature",
        "wind-speed",
        "wind-direction",
      ]),
      date_time: z
        .string()
        .describe(
          "Latest available data as of now, YYYY-MM-DD[T]HH:mm:ss format",
        ),
    },
    async handler({ kind, date_time }) {
      return (
        await got(
          `https://api.data.gov.sg/v1/environment/${kind}?date_time=${date_time}`,
        ).json<{ metadata: { stations: unknown[] } }>()
      ).metadata.stations;
    },
  }),
  geocode: hyper({
    description: "Get coordinates from location name",
    args: {
      q: z
        .string()
        .describe(
          "City name, state code (only for the US) and country code divided by comma. Please use ISO 3166 country codes.",
        ),
    },
    async handler({ q }) {
      return await got(
        `http://api.openweathermap.org/geo/1.0/direct?q=${q}&appid=${Env.OPENWEATHER_API_KEY}`,
      ).json();
    },
  }),
  reverse_geocode: hyper({
    description: "Get location name from coordinates",
    args: {
      lat: z.string().describe("Latitude"),
      lon: z.string().describe("Longitude"),
    },
    async handler({ lat, lon }) {
      return await got(
        `http://api.openweathermap.org/geo/1.0/reverse?lat=${lat}&lon=${lon}&appid=${Env.OPENWEATHER_API_KEY}`,
      ).json();
    },
  }),
  get_temasek_poly_class_schedule: hyper({
    description: "Get C23B04 class schedule",
    args: {
      prompt: z
        .string()
        .describe(
          "Question to ask about the schedule in detail, which data to retrieve?",
        ),
    },
    async handler({ prompt }) {
      const completion = await openai.chat.completions.create({
        messages: [
          {
            content: [
              {
                type: "text",
                text: "The following is a class schedule, which repeats every week.",
              },
              {
                type: "text",
                text: ind(`
                Format for one day:
                <day-of-week>
                <start-time - end-time> <class-name>. <classcode>, <type>, <venue>, <tutorial-group>, <from-week, to-week>, <lecturer[. phone]>

                Monday
                11:00 - 13:00 Agile Methodology and Design Thinking. AMDT,  Practical,  Classroom. 03-07-50,  AMDT PC04,  1-7, 11-17,  Dion Ang. 67805305,
                14:00 - 16:00 Mobile App Development. MBAP,  Practical,  Classroom. 01-06-61,  MBAP PC04,  1-7, 11-17,  Nur Amira Natasha Binte Abdul Malek,
                16:00 - 18:00 Application Security. APSEC,  Practical,  Classroom. 01-06-61,  APSEC PC04,  1-7, 11-17,  Kelvin  Soo Meng Goh,
                18:00 - 19:00 Global Studies. GS,  E-learning,  ,  GS EC04,  1-7, 11-17,  Siang Jin Lee. 67805981,

                Tuesday
                09:00 - 11:00 Innovation & Entrepreneurship. INNOVA,  Tutorial,  Audio Visual Room. 26-04-10,  Innova TC04,  1-7, 11-17,  Samantha Quek,
                11:00 - 13:00 Global Studies. GS,  Tutorial,  Audio Visual Room. 26-04-10,  GS TC04,  1-7, 11-17,  Siang Jin Lee. 67805981,
                14:00 - 16:00 Effective Communication. ECOMM,  Tutorial,  Classroom. 03-06-56,  EComm TC04,  1-7, 11-17,  Joshua Chan. 67806410,

                Wednesday
                11:00 - 13:00 Mobile App Development. MBAP,  Practical,  Classroom 05-08. 04-05-90,  MBAP PC04,  1-7, 11-17,  Nur Amira Natasha Binte Abdul Malek,
                14:00 - 18:00 Cloud Application Development. CADV,  Practical,  Classroom. 03-08-29,  CADV PC04,  1-7, 11-17,  Su Yi Lam. 67806938,

                Thursday
                09:00 - 11:00 Application Security. APSEC,  Practical,  Classroom. 03-07-51,  APSEC PC04,  1-7, 11-17,  Kelvin  Soo Meng Goh,
                11:00 - 13:00 Agile Methodology and Design Thinking. AMDT,  Practical,  Classroom. 03-07-51,  AMDT PC04,  1-7, 11-17,  Dion Ang. 67805305,
                14:00 - 15:00 Leadership in Action. LEADACT,  Tutorial,  Classroom. 03-07-50/2,  LEADACT TC04,  1-7, 11-17,  Nur Amira Natasha Binte Abdul Malek,
                15:00 - 16:00 Care Person Hour. CPHour,  Tutorial,  ,  CPH_J TC04,  1-7, 11-17,  Nur Amira Natasha Binte Abdul Malek,
                18:00 - 19:00 Effective Communication. ECOMM,  E-learning,  ,  EComm EC04,  1-7, 11-17,  Joshua Chan. 67806410,`),
              },
              {
                type: "text",
                text: `It's ${intlFormat(new Date(), { dateStyle: "full", timeStyle: "full" })}. ${prompt}`,
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-4-turbo",
      });

      return completion.choices[0].message.content;
    },
  }),
  rename_chat: hyper({
    description: "Rename the chat",
    args: {
      new_name: z
        .string()
        .describe(
          "What to name the chat. Suggested: A summary of the conversation contents.",
        ),
    },
    async handler({ new_name }, { messageId }) {
      const message = await db.query.messages.findFirst({
        where: eq(messages.id, messageId),
      });
      assert(message, "Failed to retrieve message from DB");
      const msg: Message = JSON.parse(message.contextData);

      const tg = new Api(Env.TELEGRAM_API_KEY);

      if (msg.message_thread_id) {
        await tg.editForumTopic(msg.chat.id, msg.message_thread_id, {
          name: new_name,
        });
        return `The conversation has been renamed to: ${new_name}`;
      } else {
        return "No thread associated with the user's sent message was found.";
      }
    },
  }),
  close_thread: hyper({
    description:
      "Close the topic or thread. Use this when the user says 'You may go now' or something along those lines.",
    args: {},
    async handler(args, { messageId }) {
      const message = await db.query.messages.findFirst({
        where: eq(messages.id, messageId),
      });
      assert(message, "Failed to retrieve message from DB");
      const msg: Message = JSON.parse(message.contextData);

      const tg = new Api(Env.TELEGRAM_API_KEY);

      if (msg.message_thread_id) {
        await tg.closeForumTopic(msg.chat.id, msg.message_thread_id);
        return "I have closed the thread.";
      } else {
        return "No thread associated with the user's sent message was found.";
      }
    },
  }),
});
