import { TZDate } from "@date-fns/tz";
import { fmt } from "@grammyjs/parse-mode";
import { tool } from "ai";
import { getConfigValue } from "bot/config";
import { telegram } from "bot/telegram";
import type { ToolData } from "bot/tool-data";
import { getEnv } from "utils/env";
import { z } from "zod";

/**
 * A set of default functions belonging to raphGPT, with data.
 *
 * These tools are unique to raphGPT only and undergo RAG
 * before being included in LLM calls.
 */
export function raphgptTools(data: ToolData) {
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
        const user = data.ctx.from;
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
        await telegram.sendMessage(data.ctx.chatId!, publishNotification.text, {
          entities: publishNotification.entities,
          reply_parameters: {
            message_id: data.ctx.msgId!,
            allow_sending_without_reply: true,
          },
        });

        return url;
      },
    }),

    /**
     * Enqueue a background job to download songs from Spotify via the task-runner,
     * then wait for completion and send back the resulting ZIP via Telegram.
     */
    download_songs_from_spotify: tool({
      description:
        "Enqueue download_songs_from_spotify job on task-runner. Pass Spotify URLs or search queries.",
      parameters: z.object({
        queries: z
          .array(z.string())
          .describe("List of Spotify track URLs or search queries"),
      }),
      async execute({ queries }) {
        const ctx = data.ctx;
        const resp = await fetch(
          `http://task-runner/tasks/download-songs-from-spotify`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: ctx.chatId,
              reply_to_message_id: ctx.msgId,
              queries,
            }),
          },
        );
        if (!resp.ok) {
          throw new Error(`Failed to enqueue Spotify task: ${resp.statusText}`);
        }
        const { task_id: taskId } = (await resp.json()) as { task_id: string };
        await telegram.sendMessage(
          ctx.chatId!,
          `🎵 Spotify download queued (ID: ${taskId}). I’ll send the ZIP when it’s ready.`,
          {
            reply_parameters: {
              message_id: ctx.msgId!,
              allow_sending_without_reply: true,
            },
          },
        );
        return `Queued Spotify download job ${taskId}`;
      },
    }),
  };
}
