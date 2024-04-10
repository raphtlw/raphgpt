import { hyper, hyperStore } from "ai/hyper";
import got from "got";
import { Api } from "grammy";
import OpenAI from "openai";
import { Env } from "secrets/env";
import { inspect } from "util";
import { z } from "zod";

const openai = new OpenAI({ apiKey: Env.OPENAI_API_KEY });

export const functions = hyperStore({
  vision: hyper({
    description: "Run OpenAI GPT-4 Vision on the image",
    args: {
      input: z.string().describe("The image_url to give to the GPT-4V model"),
      prompt: z.string().describe("Prompt text to instruct the GPT-4V model"),
    },
    async handler({ input, prompt }) {
      const completion = await openai.chat.completions.create({
        max_tokens: 2048,
        messages: [
          {
            content: [
              { text: prompt, type: "text" },
              {
                image_url: {
                  url: input,
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

      return completion.choices[0].message;
    },
  }),
  generate_image: hyper({
    description: "Generate image using OpenAI DALL-E model",
    args: {
      prompt: z.string().describe("Prompt text for DALL-E model"),
      quality: z.enum(["standard", "hd"]),
      size: z.enum(["1024x1024", "1792x1024", "1024x1792"]),
      style: z
        .enum(["vivid", "natural"])
        .describe(
          "The style of the generated images. Vivid causes the model to lean towards generating hyper-real and dramatic images. Natural causes the model to produce more natural, less hyper-real looking images.",
        )
        .optional(),
    },
    async handler({ prompt, quality, size, style = "vivid" }) {
      const response = await openai.images.generate({
        model: "dall-e-3",
        prompt: prompt,
        quality: quality,
        size: size,
        style: style,
      });
      console.log("DALL-E Generation:", inspect(response, true, 10, true));

      const tg = new Api(Env.TELEGRAM_API_KEY);
      await tg.sendMediaGroup(
        Env.TELEGRAM_GPT4_CHAT_ID,
        response.data.map((img) => ({
          media: img.url!,
          type: "photo",
          caption: `💭 ${img.revised_prompt} ✨`,
        })),
      );

      return response;
    },
  }),
  get_crypto_data: hyper({
    description:
      "Get crypto data from CoinGecko's Public API (https://api.coingecko.com/api/v3)",
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
      "Get relevant search results from Google in JSON format. Use this to answer questions that require searching the web.",
    args: {
      query: z.string().describe("Search query"),
    },
    async handler({ query }) {
      const res = await got(
        `https://customsearch.googleapis.com/customsearch/v1?cx=${Env.GOOGLE_CUSTOM_SEARCH_ENGINE_ID}&key=${Env.GOOGLE_CUSTOM_SEARCH_API_KEY}&q=${query}`,
      ).json<{ items: { link: string; snippet: string; title: string }[] }>();
      console.log("Google Search Response:", inspect(res, true, 10, true));

      return res.items.map((item) => ({
        link: item.link,
        snippet: item.snippet,
        title: item.title,
      }));
    },
  }),
  http_request: hyper({
    description: "Run a HTTP request on an input URL.",
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
      return await got(url, { body, method }).json();
    },
  }),
});
