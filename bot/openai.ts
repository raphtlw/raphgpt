import OpenAI from "openai";
import { Env } from "./env";
import { z } from "zod";
import { inspect } from "util";
import { db } from "../db/db";
import { openaiMessages } from "../db/schema";
import { createId } from "@paralleldrive/cuid2";
import { timestamp } from "./time";
import { code, fmt, underline } from "@grammyjs/parse-mode";
import { Bot, Context } from "grammy";
import assert from "assert";
import got from "got";
import { asc } from "drizzle-orm";
import { FileFlavor } from "@grammyjs/files";

export const openai = new OpenAI({ apiKey: Env.OPENAI_API_KEY });

export const handleToolCall = async (
  toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
  ctx: Context,
  capturedImages: string[]
) => {
  assert(ctx.chat);
  assert(ctx.msg);

  let response: any;

  if (toolCall.function.name === "vision") {
    const args = z
      .object({ prompt: z.string(), input: z.string() })
      .parse(JSON.parse(toolCall.function.arguments));

    const completion = await openai.chat.completions.create({
      model: "gpt-4-vision-preview",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: args.prompt },
            {
              type: "image_url",
              image_url: {
                url: args.input,
              },
            },
          ],
        },
      ],
      max_tokens: 2048,
    });
    console.log("Completion:", inspect(completion.choices, true, 10, true));

    response = completion.choices[0].message;
  } else if (toolCall.function.name === "generate_image") {
    const args = z
      .object({
        prompt: z.string(),
        quality: z.string(),
        size: z.string(),
        style: z.string(),
      })
      .parse(JSON.parse(toolCall.function.arguments));

    response = await openai.images.generate({
      model: "dall-e-3",
      prompt: args.prompt,
      quality: args.quality as any,
      size: args.size as any,
      style: args.style as any,
    });
    console.log("DALL-E Generation:", inspect(response, true, 10, true));

    // for (const image of response.data) {
    //   if (image.url) {
    //     if (image.revised_prompt) {
    //       const captionMessage = fmt([
    //         "✨",
    //         " ",
    //         "Revised prompt:",
    //         " ",
    //         image.revised_prompt,
    //         " ",
    //         "✨",
    //       ]);
    //       await bot.api.sendPhoto(ctx.chat.id, image.url, {
    //         caption: captionMessage.text,
    //         caption_entities: captionMessage.entities,
    //       });
    //     } else {
    //       await bot.api.sendPhoto(ctx.chat.id, image.url);
    //     }
    //   }
    // }
  } else if (toolCall.function.name === "get_crypto_data") {
    const args = z
      .object({ query_path: z.string(), query_params: z.string() })
      .parse(JSON.parse(toolCall.function.arguments));

    response = await got(
      `https://api.coingecko.com/api/v3/${args.query_path}?x_cg_demo_api_key=${Env.COINGECKO_API_KEY}&${args.query_params}`
    ).json();
    console.log("CoinGecko Response:", inspect(response, true, 10, true));
  } else if (toolCall.function.name === "clear_conversation_history") {
    const result = await db.delete(openaiMessages);
    console.log("All OpenAI message history deleted");
    response = result.toJSON();
  } else if (toolCall.function.name === "process_video_frames") {
    const args = z
      .object({ prompt: z.string(), audio_transcript: z.string() })
      .parse(JSON.parse(toolCall.function.arguments));

    const completion = await openai.chat.completions.create({
      model: "gpt-4-vision-preview",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: args.prompt },
            {
              type: "text",
              text: "The images below shows video frames in sequence. Describe what's likely going on in each frame.",
            },
            {
              type: "text",
              text: `You can hear following in the audio track: ${args.audio_transcript}`,
            },
            ...(capturedImages.map((b64) => ({
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${b64}`,
              },
            })) as any),
          ],
        },
      ],
      max_tokens: 2048,
    });
    console.log("Completion:", inspect(completion.choices, true, 10, true));

    response = completion.choices[0].message;
  } else if (toolCall.function.name === "search_google") {
    const args = z
      .object({ query: z.string() })
      .parse(JSON.parse(toolCall.function.arguments));

    const res = await got(
      `https://customsearch.googleapis.com/customsearch/v1?cx=${Env.GOOGLE_CUSTOM_SEARCH_ENGINE_ID}&key=${Env.GOOGLE_CUSTOM_SEARCH_API_KEY}&q=${args.query}`
    ).json<{ items: any[] }>();
    console.log("Google Search Response:", inspect(res, true, 10, true));

    response = res.items.map((item) => ({
      title: item.title,
      link: item.link,
      snippet: item.snippet,
    }));
  } else if (toolCall.function.name === "http_request") {
    const args = z
      .object({
        url: z.string(),
        method: z.string(),
        body: z.string().optional(),
      })
      .parse(JSON.parse(toolCall.function.arguments));

    response = await got(args.url, {
      method: args.method as any,
      body: args.body,
    }).json();
    console.log(args.url, "HTTP Response:", inspect(response, true, 10, true));
  } else if (toolCall.function.name === "ask_llama2") {
    const args = z
      .object({ prompt: z.string() })
      .parse(JSON.parse(toolCall.function.arguments));

    const res = await got
      .post(`${Env.OLLAMA_URL}/api/generate`, {
        json: {
          model: "llama2-uncensored",
          prompt: args.prompt,
          stream: false,
        },
      })
      .json<{ response: string }>();

    response = res.response;

    ctx.api.sendMessage(ctx.chat.id, response, {
      reply_parameters: {
        message_id: ctx.msg.message_id,
      },
    });
  }

  return {
    tool_call_id: toolCall.id,
    role: "tool",
    name: toolCall.function.name,
    content: JSON.stringify(response),
  };
};
