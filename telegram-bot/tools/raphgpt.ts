import { TZDate } from "@date-fns/tz";
import { fmt } from "@grammyjs/parse-mode";
import { tool } from "ai";
import { getConfigValue } from "bot/config";
import { telegram } from "bot/telegram";
import type { ToolData } from "bot/tool-data";
import { s3 } from "bun";
import { getEnv } from "utils/env";
import { z } from "zod";

/**
 * A set of default functions belonging to raphGPT, with data.
 *
 * These tools are unique to raphGPT only and undergo RAG
 * before being included in LLM calls.
 */
export function raphgptTools({ ctx }: ToolData) {
  return {
    convert_timezone: tool({
      description:
        "Convert a date/time string from one timezone to another. Defaults to current time and configured timezone if not provided.",
      parameters: z.object({
        to_timezone: z
          .string()
          .describe(
            "Destination timezone in IANA format, e.g. 'Europe/Bratislava'",
          ),
        from_timezone: z
          .string()
          .optional()
          .describe(
            "Source timezone in IANA format, e.g. 'Asia/Singapore' (defaults to user's configured timezone)",
          ),
        datetime: z
          .string()
          .optional()
          .describe(
            "Date/time in ISO 8601 format to convert (defaults to now)",
          ),
      }),
      async execute({ to_timezone, from_timezone, datetime }) {
        const user = ctx.from;
        if (!user) throw new Error("ctx.from not found");
        const userTz = await getConfigValue(user.id, "timezone");
        const tzFrom = from_timezone ?? userTz ?? undefined;

        let src: TZDate;
        if (datetime) {
          src = tzFrom ? new TZDate(datetime, tzFrom) : new TZDate(datetime);
        } else {
          src = tzFrom ? TZDate.tz(tzFrom) : new TZDate();
        }

        const dst = new TZDate(src.getTime(), to_timezone);
        return dst.toString();
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
        console.log({ text_query, lat, lon });

        const resp = await fetch(
          "https://places.googleapis.com/v1/places:searchText",
          {
            method: "POST",
            headers: {
              "X-Goog-Api-Key": getEnv("GOOGLE_API_KEY"),
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

    google_lens: tool({
      description:
        "Perform a Google Lens image search via SerpApi. Provide an image URL and optional query parameters to refine the search results.",
      parameters: z.object({
        url: z.string().describe("URL of the image to search"),
        q: z
          .string()
          .optional()
          .describe(
            "Optional query text to refine the image search (only when type is all, visual_matches, or products)",
          ),
        type: z
          .enum(["all", "products", "exact_matches", "visual_matches"])
          .optional()
          .describe("Type of search to perform (default: all)"),
        hl: z
          .string()
          .optional()
          .describe("Language code for localization (e.g., 'en', 'es')"),
        country: z
          .string()
          .optional()
          .describe("Country code for localization (e.g., 'us', 'jp')"),
        safe: z
          .enum(["active", "off"])
          .optional()
          .describe("Safe search filter (active or off)"),
      }),
      async execute({ url, q, type, hl, country, safe }) {
        console.log("[google_lens] Searching", {
          url,
          q,
          type,
          hl,
          country,
          safe,
        });

        if (url.startsWith("images/")) {
          url = s3.presign(url, {
            expiresIn: 3600,
          });
        }

        const apiKey = getEnv("SERPAPI_API_KEY");
        const params: Record<string, string> = {
          engine: "google_lens",
          url,
          api_key: apiKey,
        };
        if (q) params.q = q;
        if (type) params.type = type;
        if (hl) params.hl = hl;
        if (country) params.country = country;
        if (safe) params.safe = safe;

        const searchUrl =
          "https://serpapi.com/search.json?" + new URLSearchParams(params);
        const resp = await fetch(searchUrl);
        if (!resp.ok) {
          return `Error: ${resp.status} ${await resp.text()}`;
        }
        const data = await resp.json();
        console.log(
          "[google_lens] Received status",
          data.search_metadata?.status,
          "id",
          data.search_metadata?.id,
        );
        return data;
      },
    }),

    codex_cli: tool({
      description:
        "Enqueue a codex run, on task-runner." +
        "Codex is a coding agent created by OpenAI." +
        "Be as detailed as possible in the prompt." +
        "Sends a .zip file of the folder after it's done.",
      parameters: z.object({
        prompt: z
          .string()
          .describe(
            "Prompt for project. Be as specific as you can, including all nuances and specifications about the project." +
              "If the user did not specify clearly what they wanted, ask them before using this tool.",
          ),
        input_zip_key: z
          .string()
          .optional()
          .describe("Zip file to unpack to use as working directory"),
      }),
      async execute({ prompt, input_zip_key }) {
        const res = await fetch("http://task-queue/tasks/codex", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt,
            input_zip_key,
            chat_id: ctx.chatId,
            reply_to_message_id: ctx.msgId,
          }),
        });

        if (!res.ok) {
          return `ERROR: ${res.status} - ${await res.text()}`;
        }

        const { id } = await res.json();

        await telegram.sendMessage(
          ctx.chatId!,
          `🧠 Task queued (ID: ${id}). I’ll send the ZIP here when it’s ready.`,
          {
            reply_parameters: {
              message_id: ctx.msgId!,
              allow_sending_without_reply: true,
            },
          },
        );

        return `Task queued with task ID: ${id}. User will be notified later when it's done.`;
      },
    }),

    publish_raphgpt_page: tool({
      description:
        "Publishes a new MDX-formatted webpage with the given title to raphtlw.com via the raphgpt API, creates a 'raphgptPage', returns its URL, and sends a Telegram notification to the user.",
      parameters: z.object({
        title: z.string().describe("The title of the webpage to publish"),
        content: z
          .string()
          .describe(
            "The MDX-formatted content of the webpage, including markdown and JSX components",
          ),
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
        await telegram.sendMessage(ctx.chatId!, publishNotification.text, {
          entities: publishNotification.entities,
          reply_parameters: {
            message_id: ctx.msgId!,
            allow_sending_without_reply: true,
          },
        });

        return url;
      },
    }),
  };
}
