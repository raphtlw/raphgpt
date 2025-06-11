import { openai } from "@ai-sdk/openai";
import * as Bonfida from "@bonfida/spl-name-service";
import { fmt } from "@grammyjs/parse-mode";
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
import { replicate } from "connections/replicate";
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
      description:
        "Generate an image using a model available on Replicate.ai." +
        "Be very detailed in your prompt, as much as possible.",
      parameters: z.object({
        prompt: z.string().describe("Text prompt for image generation"),
        model: z
          .string()
          .optional()
          .describe(
            "Optional model to use, e.g. ideogram-ai/ideogram-v3-quality. If omitted, the agent should search public models.",
          ),
        aspect_ratio: z
          .string()
          .optional()
          .describe("Optional aspect ratio for the image, e.g. '4:3', '16:9'."),
      }),
      async execute({ prompt, model, aspect_ratio }) {
        const { text: result, steps } = await generateText({
          model: openai("o4-mini", {
            structuredOutputs: false,
            reasoningEffort: "high",
          }),
          system: `You are an image generation assistant.
If no model identifier is provided, use the list_replicate_models tool to find a suitable public model.
If the provided model identifier does not include a version, use the list_replicate_model_versions tool to obtain available versions.
If the model is an official model, use the list_replicate_model_examples tool
to view illustrative examples or get_replicate_model_readme tool to read documentation.
To inspect any version's input schema, use get_replicate_openapi_schema.
Then use run_replicate_model for versioned models or run_replicate_official_model for official models to execute the model.
After obtaining the image URL, call send_telegram_image to send the image back to the user via Telegram.
Return the URL of the generated image.`,
          messages: [
            {
              role: "user",
              content: `Prompt: ${prompt}${model ? `\nModel: ${model}` : ``}${aspect_ratio ? `\nAspect ratio: ${aspect_ratio}` : ``}`,
            },
          ],
          tools: {
            list_replicate_models: tool({
              description:
                "List public models available on Replicate. Returns an array of model identifiers in the form 'owner/model'.",
              parameters: z.object({}),
              async execute() {
                try {
                  const page = await replicate.models.list();
                  return page.results.map((m: any) => m.id);
                } catch (err: any) {
                  return `Error: ${err.message}`;
                }
              },
            }),
            get_replicate_openapi_schema: tool({
              description:
                "Get the OpenAPI schema for a Replicate model version. Input must be the model identifier 'owner/model:version'.",
              parameters: z.object({
                model: z
                  .string()
                  .describe("Model identifier in format owner/model:version"),
              }),
              async execute({ model }) {
                const [ownerModel, version] = model.split(":");
                if (!ownerModel || !version) {
                  return "Error: Model identifier must be in the format owner/model:version";
                }
                const [owner, modelName] = ownerModel.split("/");
                if (!owner || !modelName) {
                  return "Error: Model identifier must be in the format owner/model:version";
                }
                try {
                  const versionData = await replicate.models.versions.get(
                    owner,
                    modelName,
                    version,
                  );
                  return versionData.openapi_schema;
                } catch (err: any) {
                  return `Error: ${err.message}`;
                }
              },
            }),
            list_replicate_model_versions: tool({
              description:
                "List all versions for a Replicate model. Input must be the model identifier 'owner/model'.",
              parameters: z.object({
                model: z
                  .string()
                  .describe("Model identifier in format owner/model"),
              }),
              async execute({ model }) {
                const [owner, modelName] = model.split("/");
                if (!owner || !modelName) {
                  return "Error: Model identifier must be in the format owner/model";
                }
                try {
                  const versions = await replicate.models.versions.list(
                    owner,
                    modelName,
                  );
                  return versions.map((v: any) => v.id);
                } catch (err: any) {
                  return `Error: ${err.message}`;
                }
              },
            }),
            run_replicate_model: tool({
              description:
                "Run a Replicate model with the given input object. Returns the raw prediction output.",
              parameters: z.object({
                model: z
                  .string()
                  .describe("Model identifier in format owner/model:version"),
                input: z.any().describe("Input object matching model schema"),
              }),
              async execute({ model, input }) {
                try {
                  const output = await replicate.run(
                    model as
                      | `${string}/${string}`
                      | `${string}/${string}:${string}`,
                    { input },
                  );
                  return output;
                } catch (err: any) {
                  return `Error: ${err.message}`;
                }
              },
            }),
            list_replicate_model_examples: tool({
              description:
                "List example predictions made using an official Replicate model. Input must be the model identifier 'owner/model'. Returns a pagination object containing result predictions.",
              parameters: z.object({
                model: z
                  .string()
                  .describe("Model identifier in format owner/model"),
              }),
              async execute({ model }) {
                const [owner, modelName] = model.split("/");
                if (!owner || !modelName) {
                  return "Error: Model identifier must be in the format owner/model";
                }
                try {
                  const res = await replicate.request(
                    `/v1/models/${owner}/${modelName}/examples`,
                    { method: "GET" },
                  );
                  if (!res.ok) {
                    const body = await res.text();
                    return `Error: Failed to list examples: ${res.status} ${body}`;
                  }
                  return await res.json();
                } catch (err: any) {
                  return `Error: ${err.message}`;
                }
              },
            }),
            get_replicate_model_readme: tool({
              description:
                "Get the README for a Replicate model. Input must be the model identifier 'owner/model'. Returns the README in Markdown.",
              parameters: z.object({
                model: z
                  .string()
                  .describe("Model identifier in format owner/model"),
              }),
              async execute({ model }) {
                const [owner, modelName] = model.split("/");
                if (!owner || !modelName) {
                  return "Error: Model identifier must be in the format owner/model";
                }
                try {
                  const res = await replicate.request(
                    `/v1/models/${owner}/${modelName}/readme`,
                    { method: "GET" },
                  );
                  if (!res.ok) {
                    const body = await res.text();
                    return `Error: Failed to fetch README: ${res.status} ${body}`;
                  }
                  return await res.text();
                } catch (err: any) {
                  return `Error: ${err.message}`;
                }
              },
            }),
            run_replicate_official_model: tool({
              description:
                "Run an official Replicate model (no version) with the given input object. Returns the raw prediction output.",
              parameters: z.object({
                model: z
                  .string()
                  .describe("Model identifier in format owner/model"),
                input: z.any().describe("Input object matching model schema"),
              }),
              async execute({ model, input }) {
                const [owner, modelName] = model.split("/");
                if (!owner || !modelName) {
                  return "Error: Model identifier must be in the format owner/model";
                }
                try {
                  const prediction = await replicate.predictions.create({
                    model: `${owner}/${modelName}`,
                    input,
                    wait: true,
                  });
                  return prediction;
                } catch (err: any) {
                  return `Error: ${err.message}`;
                }
              },
            }),
            send_telegram_image: tool({
              description:
                "Send an image to the user via Telegram. Inputs: url (image URL) and optional caption.",
              parameters: z.object({
                url: z.string().describe("URL of the image to send"),
                caption: z
                  .string()
                  .optional()
                  .describe("Optional caption for the image"),
              }),
              async execute({ url, caption }) {
                await telegram.sendPhoto(data.chatId, url, {
                  caption,
                  reply_parameters: {
                    message_id: data.msgId,
                    allow_sending_without_reply: true,
                  },
                });
                return "Image sent.";
              },
            }),
          },
          maxSteps: 5,
        });

        logger.debug(`Generate image agent steps: ${inspect(steps)}`);

        return result;
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
