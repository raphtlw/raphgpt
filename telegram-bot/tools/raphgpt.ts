import { openai } from "@ai-sdk/openai";
import * as Bonfida from "@bonfida/spl-name-service";
import { b, fmt, i } from "@grammyjs/parse-mode";
import {
  clusterApiUrl,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { generateText, tool } from "ai";
import { browser } from "bot/browser";
import { activeRequests } from "bot/handler";
import logger from "bot/logger";
import { telegram } from "bot/telegram";
import { inspect } from "bun";
import { kv } from "connections/redis";
import { runModel } from "connections/replicate";
import { format } from "date-fns";
import { db, tables } from "db";
import { eq, or } from "drizzle-orm";
import { encoding_for_model } from "tiktoken";
import { getEnv } from "utils/env";
import { convertHtmlToMarkdown } from "utils/markdown";
import { z } from "zod";

export type ToolData = {
  userId: number;
  chatId: number;
  msgId: number;
  dbUser: number;
};

/**
 * A set of default functions belonging to raphGPT, with data.
 *
 * These are the most essential for interacting with Telegram
 * and therefore, have to be as streamlined and useful
 * as possible.
 */
export function raphgptTools(data: ToolData) {
  return {
    search_google: tool({
      description:
        "Get relevant search results from Google in JSON format. Use this to answer questions that require up to date info, or to get links from web results. Unable to do location searching. Result contents are truncated. Use get_link_contents if you want the full text.",
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
        const resp = await fetch(
          `https://customsearch.googleapis.com/customsearch/v1?` + params,
        );
        if (!resp.ok) {
          throw new Error(`not ok ${await resp.text()}`);
        }
        const res = (await resp.json()) as any;
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
            const page = await browser.newPage();
            await page.goto(results[i]!.link, {
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
            const lim = tok.slice(0, 256);
            const txt = new TextDecoder().decode(enc.decode(lim));
            enc.free();

            if (txt.length > 0) {
              results[i]!.content = txt;
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
        const page = await browser.newPage();
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
        const lim = tok.slice(0, 4096);
        const txt = new TextDecoder().decode(enc.decode(lim));
        enc.free();

        if (txt.length > 0) {
          return txt;
        } else {
          return "Webpage content is empty!";
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

        const resp = await fetch(
          "https://places.googleapis.com/v1/places:searchText",
          {
            method: "POST",
            headers: {
              "X-Goog-Api-Key": getEnv("GOOGLE_MAPS_API_KEY"),
              "X-Goog-FieldMask":
                "places.displayName,places.formattedAddress,places.priceLevel,places.googleMapsUri,places.currentOpeningHours.openNow,places.currentOpeningHours.weekdayDescriptions",
            },
            body: JSON.stringify({
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
            }),
          },
        );

        return resp.json();
      },
    }),

    generate_image: tool({
      description: "Generate image using Ideogram AI v3 quality model",
      parameters: z.object({
        prompt: z.string().describe("Text prompt for image generation"),
        aspect_ratio: z
          .string()
          .describe(
            "Aspect ratio. Ignored if a resolution or inpainting image is given.",
          )
          .optional(),
        resolution: z
          .string()
          .describe(
            "Resolution. Overrides aspect ratio. Ignored if an inpainting image is given.",
          )
          .optional(),
        magic_prompt_option: z
          .string()
          .describe(
            "Magic Prompt will interpret your prompt and optimize it to maximize variety and quality of the images generated. You can also use it to write prompts in different languages.",
          )
          .optional(),
        image: z
          .string()
          .describe(
            "An image file to use for inpainting. You must also use a mask.",
          )
          .optional(),
        mask: z
          .string()
          .describe(
            "A black and white image. Black pixels are inpainted, white pixels are preserved. The mask will be resized to match the image size.",
          )
          .optional(),
        style_type: z
          .string()
          .describe(
            "The styles help define the specific aesthetic of the image you want to generate.",
          )
          .optional(),
        style_reference_images: z
          .array(z.string())
          .describe("A list of images to use as style references.")
          .optional(),
        seed: z
          .number()
          .int()
          .describe("Random seed. Set for reproducible generation.")
          .optional(),
      }),
      async execute({
        prompt,
        aspect_ratio,
        resolution,
        magic_prompt_option,
        image,
        mask,
        style_type,
        style_reference_images,
        seed,
      }) {
        logger.info(
          {
            prompt,
            aspect_ratio,
            resolution,
            magic_prompt_option,
            image,
            mask,
            style_type,
            style_reference_images,
            seed,
          },
          "Generating image using Ideogram v3 quality",
        );
        const output = await runModel(
          "ideogram-ai/ideogram-v3-quality",
          z.object({
            prompt: z.string().describe("Text prompt for image generation"),
            aspect_ratio: z
              .string()
              .describe(
                "Aspect ratio. Ignored if a resolution or inpainting image is given.",
              )
              .optional(),
            resolution: z
              .string()
              .describe(
                "Resolution. Overrides aspect ratio. Ignored if an inpainting image is given.",
              )
              .optional(),
            magic_prompt_option: z
              .string()
              .describe(
                "Magic Prompt will interpret your prompt and optimize it to maximize variety and quality of the images generated. You can also use it to write prompts in different languages.",
              )
              .optional(),
            image: z
              .string()
              .describe(
                "An image file to use for inpainting. You must also use a mask.",
              )
              .optional(),
            mask: z
              .string()
              .describe(
                "A black and white image. Black pixels are inpainted, white pixels are preserved. The mask will be resized to match the image size.",
              )
              .optional(),
            style_type: z
              .string()
              .describe(
                "The styles help define the specific aesthetic of the image you want to generate.",
              )
              .optional(),
            style_reference_images: z
              .array(z.string())
              .describe("A list of images to use as style references.")
              .optional(),
            seed: z
              .number()
              .int()
              .describe("Random seed. Set for reproducible generation.")
              .optional(),
          }),
          z.string(),
          {
            prompt,
            aspect_ratio,
            resolution,
            magic_prompt_option,
            image,
            mask,
            style_type,
            style_reference_images,
            seed,
          },
        );

        const caption = fmt`${b}Prompt${b}: ${i}${prompt}${i}`;

        await telegram.sendPhoto(data.chatId, output, {
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

    publish_mdx: tool({
      description: "Publish a webpage with MDX content",
      parameters: z.object({
        title: z.string().describe("Title of webpage"),
        content: z.string(),
      }),
      async execute({ title, content }) {
        const res = await fetch(
          "https://www.raphtlw.com/api/raphgpt/document",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${getEnv("RAPHTLW_API_KEY")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ title, content }),
          },
        );

        if (!res.ok) {
          return `ERROR: raphtlw.com returned error ${await res.text()}`;
        }

        const result = await res.json().then((r) =>
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
            .parse(r),
        );

        const url = `https://raphtlw.com/raphgpt/${result.doc._id}`;

        const publishNotification = fmt`I've published a new webpage.
You can view it at this URL:
${url}`;
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

    wallet_explorer: tool({
      description:
        "Explore the Solana blockchain, using wallet addresses or transaction signatures",
      parameters: z.object({
        walletAddressOrSignature: z
          .string()
          .describe("Signature or address in base58 or .sol domain"),
        instruction: z
          .string()
          .describe(
            "Natural language instruction describing what you want from the address or signature",
          ),
      }),
      async execute({ walletAddressOrSignature, instruction }) {
        const connection = new Connection(clusterApiUrl("mainnet-beta"));

        const { text: result, steps } = await generateText({
          model: openai("o4-mini", {
            structuredOutputs: false,
            reasoningEffort: "high",
          }),
          system: `You are a Solana blockchain investigator. Current time in UTC: ${format(new Date(), "EEEE, yyyy-MM-dd 'at' HH:mm:ss zzz (XXX)")}. Always use get_sol_signatures before assuming there are no transactions associated with a specific wallet.`,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: instruction,
                },
                {
                  type: "text",
                  text: `Use the following parameter: ${walletAddressOrSignature}`,
                },
              ],
            },
          ],
          tools: {
            resolve_sol_domain: tool({
              parameters: z.object({
                domain: z.string().describe("Bonfida domain ending in .sol"),
              }),
              async execute({ domain }) {
                const owner = await Bonfida.resolve(connection, domain);
                return owner.toBase58();
              },
            }),

            get_account_info: tool({
              parameters: z.object({
                walletAddress: z.string(),
              }),
              async execute({ walletAddress }) {
                return await connection.getAccountInfoAndContext(
                  new PublicKey(walletAddress),
                );
              },
            }),

            get_sol_signatures: tool({
              description: "Get all signatures for wallet address",
              parameters: z.object({
                walletAddress: z.string(),
                limit: z.number().optional(),
              }),
              async execute({ walletAddress, limit }) {
                const signatures = await connection.getSignaturesForAddress(
                  new PublicKey(walletAddress),
                  {
                    limit,
                  },
                );

                logger.debug(signatures, "Confirmed signatures");

                const formatted: string[] = [];

                for (const sig of signatures) {
                  const txDetails: string[] = [];

                  txDetails.push(
                    `timestamp: ${format(new Date(), "EEEE, yyyy-MM-dd 'at' HH:mm:ss zzz (XXX)")}`,
                  );
                  txDetails.push(`sig: ${sig.signature}`);
                  txDetails.push(`memo: ${sig.memo}`);
                  txDetails.push(`error: ${inspect(sig.err)}`);

                  formatted.push(txDetails.join(","));
                }

                return formatted.join("\n");
              },
            }),

            get_sol_tx: tool({
              description: "Get transaction by signature",
              parameters: z.object({
                sig: z.string(),
              }),
              async execute({ sig }) {
                const transaction = await connection.getParsedTransaction(sig, {
                  commitment: "confirmed",
                  maxSupportedTransactionVersion: 0,
                });
                if (!transaction) throw new Error("Transaction not found");

                const formatted: string[] = [];
                const txDetails: string[] = [];

                txDetails.push(
                  `timestamp: ${format(new Date(), "EEEE, yyyy-MM-dd 'at' HH:mm:ss zzz (XXX)")}`,
                );
                txDetails.push(`data: ${inspect(transaction.meta)}`);

                formatted.push(txDetails.join(","));

                return formatted.join("\n");
              },
            }),

            lamports_to_sol: tool({
              description: "Calculate lamports to sol",
              parameters: z.object({
                lamports: z.number(),
              }),
              async execute({ lamports }) {
                return lamports / LAMPORTS_PER_SOL;
              },
            }),
          },
          maxSteps: 5,
        });

        logger.debug(steps, "Wallet explorer resulting steps");
        logger.debug(result);

        return `Result: ${result}`;
      },
    }),

    send_message: tool({
      description:
        "Send a text message to a specified user (by chat ID or by username/first name/last name). Owner only.",
      parameters: z.object({
        recipient: z
          .union([z.number(), z.string()])
          .describe("Destination chat ID or username/first name/last name"),
        text: z.string().describe("Message text to send"),
      }),
      async execute({ recipient, text }) {
        const ownerId = getEnv("TELEGRAM_BOT_OWNER", z.coerce.number());
        if (data.userId !== ownerId) {
          return "ERROR: Only the bot owner may use send_message";
        }
        let chatIdToSend: number;
        if (typeof recipient === "number") {
          chatIdToSend = recipient;
        } else {
          const user = await db.query.users.findFirst({
            where: or(
              eq(tables.users.username, recipient),
              eq(tables.users.firstName, recipient),
              eq(tables.users.lastName, recipient),
            ),
          });
          if (!user) {
            return `ERROR: Recipient not found: ${recipient}`;
          }
          chatIdToSend = user.chatId;
        }
        await telegram.sendMessage(chatIdToSend, text, {
          reply_parameters: {
            message_id: data.msgId,
            allow_sending_without_reply: true,
          },
        });
        return `Message sent to ${chatIdToSend}`;
      },
    }),

    /**
     * Get all users from the database (owner only).
     * Returns array of objects containing chatId, username, firstName, lastName.
     */
    get_all_users: tool({
      description: "Get all users from the database. Owner only.",
      parameters: z.object({}),
      async execute() {
        const ownerId = getEnv("TELEGRAM_BOT_OWNER", z.coerce.number());
        if (data.userId !== ownerId) {
          return "ERROR: Only the bot owner may use get_all_users";
        }
        const users = await db.query.users.findMany();
        return users.map((u) => ({
          chatId: u.chatId,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
        }));
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
}
