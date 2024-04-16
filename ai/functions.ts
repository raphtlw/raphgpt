import { fmt, italic } from "@grammyjs/parse-mode";
import { createId } from "@paralleldrive/cuid2";
import decodeQR from "@paulmillr/qr/decode";
import { ind } from "@raphtlw/indoc";
import { Conversation, combineMessageContent, transcribeAudio } from "ai";
import { hyper, hyperStore } from "ai/hyper";
import * as GoogleSearch from "api/google-search";
import assert from "assert";
import { Command } from "bot/command";
import { calculateDetailAmounts } from "common/image-processing";
import { db } from "db";
import { messages } from "db/schema";
import { eq } from "drizzle-orm";
import fs from "fs";
import got from "got";
import { Api } from "grammy";
import { Message } from "grammy/types";
import Jimp from "jimp";
import { joinImages } from "join-images";
import { evaluate } from "mathjs";
import mime from "mime";
import OpenAI from "openai";
import path from "path";
import puppeteer from "puppeteer";
import { Env } from "secrets/env";
import sharp, { Sharp } from "sharp";
import { pipeline } from "stream/promises";
import { encoding_for_model } from "tiktoken";
import { inspect } from "util";
import { z } from "zod";

const openai = new OpenAI({ apiKey: Env.OPENAI_API_KEY });

export type ContextType = { messageId: string };

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
      if (fs.existsSync(localPath)) {
        url = localPath;
      } else if (!fs.existsSync(audio)) {
        const outPath = path.join(
          process.cwd(),
          "data",
          "file",
          `${fileId}.unknown`,
        );
        await pipeline(got.stream(url), fs.createWriteStream(outPath));
        url = outPath;
      }

      return await transcribeAudio(url);
    },
  }),
  vision: hyper({
    description: "Run OpenAI GPT-4 Vision on the image",
    args: {
      image: z.string().describe("Link/path to image for GPT-4V model"),
      usage: z.string().describe("Description of intended purpose"),
    },
    async handler({ image, usage }) {
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
        model: "gpt-4-vision-preview",
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
        model: "gpt-4-vision-preview",
      });

      return [
        completion.choices[0].message.content,
        `Analyze the video's last frame to better respond to the transcript: ${lastFramePath}`,
      ].join("\n");
    },
  }),
  generate_image: hyper({
    description: "Generate image using DALL-E model",
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
        prompt: `I NEED to test how the tool works with extremely simple prompts. DO NOT add any detail, just use it AS-IS: ${prompt}`,
        quality: quality,
        size: size,
        style: style,
      });
      console.log("DALL-E Generation:", inspect(response, true, 10, true));

      const tg = new Api(Env.TELEGRAM_API_KEY);
      await tg.sendMediaGroup(
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
          message_thread_id: msg.message_thread_id,
        },
      );

      return response;
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
      "Get relevant search results from Google in JSON format. Use this to answer questions that require browsing the web/up to date info.",
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
    async handler({ query, gl, link_site, search_type }) {
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
          const browser = await puppeteer.launch({
            headless: true,
            defaultViewport: null,
            userDataDir: path.join(process.cwd(), "data", "browser"),
          });
          const page = (await browser.pages())[0];
          await page.goto(results[i].link, {
            waitUntil: "domcontentloaded",
          });
          const firstResultContents = await page.$eval(
            "*",
            (el) =>
              el.innerText + el.getAttribute("href") + el.getAttribute("src"),
          );
          // only one instance of pptr can be running at one time
          await browser.close();

          // limit content length to fit context size for model
          const encoder = encoding_for_model("gpt-3.5-turbo-0125");
          const encoded = encoder.encode(firstResultContents);
          const truncatedToFitModelContextLength = encoded.slice(
            100,
            4096 + 100,
          );
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
  browser: hyper({
    description: "Web browser, returns the content of a single URL",
    args: {
      instructions: z
        .string()
        .describe(
          "Instructions for GPT to understand what to do on the webpage",
        ),
    },
    async handler({ instructions }, { messageId }) {
      const message = await db.query.messages.findFirst({
        where: eq(messages.id, messageId),
      });
      assert(message, "Failed to retrieve message from DB");
      const msg: Message = JSON.parse(message.contextData);

      const browser = await puppeteer.launch({
        headless: true,
        defaultViewport: null,
        userDataDir: path.join(process.cwd(), "data", "browser"),
      });
      const page = (await browser.pages())[0];
      const tg = new Api(Env.TELEGRAM_API_KEY);

      const functions = hyperStore({
        goto_url: hyper({
          description:
            "Navigate to specific URL. You need to get the content yourself.",
          args: {
            url: z.string().describe("URL to go to (including protocol)"),
          },
          async handler({ url }) {
            await page.goto(url, {
              waitUntil: "domcontentloaded",
            });
            return `Navigation success`;
          },
        }),
        click_link: hyper({
          description:
            "Click on a link by JS selector. Add the text of the link to confirm that you are clicking the right link.",
          args: {
            selector: z.string(),
            text: z.string(),
          },
          async handler({ selector, text }) {
            await page.click(selector);
            return `Link ${text} successfully clicked`;
          },
        }),
        get_content: hyper({
          description: "Return a page content, including DOCTYPE",
          args: {},
          async handler() {
            return await page.content();
          },
        }),
      });

      const conversation = new Conversation();

      conversation.addSystem(
        ind(`
        ## OBJECTIVE ##
        You have been tasked with crawling the internet based on a task given by the user.
        You are connected to a web browser which you can control via function calls to navigate
        pages and list elements on the page.
        You can also type into search boxes and other input fields and send forms.
        You can also click links on the page.
        You will behave as a human browsing the web.

        ## NOTES ##
        You will try to navigate directly to the most relevant web address.
        If you were given a URL, go to it directly.
        If you encounter a Page Not Found error, try another URL.
        If multiple URLs don't work, you are probably using an outdated version of the URL scheme of that website.
        In that case, try navigating to their front page and using their search bar or try navigating to the right place with links.`),
      );

      conversation.add({ role: "user", content: `Task: ${instructions}` });

      const runModel = async () => {
        const completion = await openai.chat.completions.create({
          messages: conversation.get(),
          model: "gpt-3.5-turbo-0125",
          tools: functions.asTools(),
          tool_choice: "auto",
        });
        const result = completion.choices[0].message;

        conversation.add(result);

        if (result.tool_calls) {
          for (const toolCall of result.tool_calls) {
            try {
              const functionCallResult = await functions.callTool(toolCall, {});
              conversation.add({
                tool_call_id: toolCall.id,
                role: "tool",
                content: JSON.stringify(functionCallResult),
              });
            } catch (e) {
              conversation.add({
                tool_call_id: toolCall.id,
                role: "tool",
                content: JSON.stringify(e),
              });
            }
          }
        }

        return [result.content, conversation.peek()] as const;
      };

      let modelFeedback: string | null;
      let latestMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam;
      while (
        ([modelFeedback, latestMessage] = await runModel())[1].role === "tool"
      ) {
        if (modelFeedback) {
          await tg.sendMessage(msg.chat.id, modelFeedback, {
            reply_parameters: {
              message_id: msg.message_id,
              allow_sending_without_reply: true,
            },
            message_thread_id: msg.message_thread_id,
          });
        }
      }

      console.log(inspect(conversation, true, 10, true));

      await tg.sendMessage(msg.chat.id, combineMessageContent(latestMessage)!, {
        reply_parameters: {
          message_id: msg.message_id,
          allow_sending_without_reply: true,
        },
        message_thread_id: msg.message_thread_id,
      });

      await browser.close();

      return latestMessage.content;
    },
  }),
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
  eval_math: hyper({
    description: "Evaluate math expression using math.js",
    args: {
      expr: z.string().describe("Expression to evaluate"),
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
  extract_receipt_data: hyper({
    description:
      "Extract receipt/invoice data from image, to be used to split the bill",
    args: {
      image: z.string().describe("The image_url with the receipt"),
    },
    async handler({ image }) {
      let url = image;
      if (url.startsWith("data/file")) {
        url = await fs.promises.readFile(url, { encoding: "base64" });
        url = `data:image/png;base64,${url}`;
      }

      const completion = await openai.chat.completions.create({
        max_tokens: 2048,
        messages: [
          {
            content: "You are a receipt/invoice reader.",
            role: "system",
          },
          {
            content: [
              {
                text: "Extract all data from the image",
                type: "text",
              },
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
        model: "gpt-4-vision-preview",
      });

      return [
        completion.choices[0].message.content!,
        "Use the math function to split the bill",
      ].join("\n");
    },
  }),
  get_temasek_poly_class_schedule: hyper({
    description: "Get C23B04 class schedule",
    args: {
      prompt: z.string().describe("Question to ask about the schedule"),
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
                text: `Current datetime is ${new Date().toLocaleString()}. ${prompt}`,
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-4-turbo-preview",
      });

      return completion.choices[0].message.content;
    },
  }),
});
