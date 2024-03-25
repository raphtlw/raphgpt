import { FileFlavor } from "@grammyjs/files";
import { code, fmt, underline } from "@grammyjs/parse-mode";
import { createId } from "@paralleldrive/cuid2";
import assert from "assert";
import { timestamp } from "bot/time";
import { db } from "db";
import { openaiMessages } from "db/schema";
import { asc } from "drizzle-orm";
import got from "got";
import { Bot, Context } from "grammy";
import OpenAI from "openai";
import { Env } from "secrets/env";
import { inspect } from "util";
import { z } from "zod";

export const openai = new OpenAI({ apiKey: Env.OPENAI_API_KEY });

export const handleToolCall = async (
  toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
  ctx: Context,
  capturedImages: string[]
) => {
  assert(ctx.chat);
  assert(ctx.msg);

  let response: unknown;

  if (toolCall.function.name === "vision") {
    const args = z
      .object({ input: z.string(), prompt: z.string() })
      .parse(JSON.parse(toolCall.function.arguments));

    const completion = await openai.chat.completions.create({
      max_tokens: 2048,
      messages: [
        {
          content: [
            { text: args.prompt, type: "text" },
            {
              image_url: {
                url: args.input,
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
      quality: args.quality as never,
      size: args.size as never,
      style: args.style as never,
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
      .object({ query_params: z.string(), query_path: z.string() })
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
      .object({ audio_transcript: z.string(), prompt: z.string() })
      .parse(JSON.parse(toolCall.function.arguments));

    const completion = await openai.chat.completions.create({
      max_tokens: 2048,
      messages: [
        {
          content: [
            { text: args.prompt, type: "text" },
            {
              text: "The images below shows video frames in sequence. Act as if you were a person, and describe what's likely going on in each frame.",
              type: "text",
            },
            {
              text: `You can hear following in the audio track: ${args.audio_transcript}`,
              type: "text",
            },
            ...(capturedImages.map((b64) => ({
              image_url: {
                url: `data:image/jpeg;base64,${b64}`,
              },
              type: "image_url",
            })) as any),
          ],
          role: "user",
        },
      ],
      model: "gpt-4-vision-preview",
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
      link: item.link,
      snippet: item.snippet,
      title: item.title,
    }));
  } else if (toolCall.function.name === "http_request") {
    const args = z
      .object({
        body: z.string().optional(),
        method: z.string(),
        url: z.string(),
      })
      .parse(JSON.parse(toolCall.function.arguments));

    response = await got(args.url, {
      body: args.body,
      method: args.method as never,
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
    content: JSON.stringify(response),
    name: toolCall.function.name,
    role: "tool",
    tool_call_id: toolCall.id,
  };
};
