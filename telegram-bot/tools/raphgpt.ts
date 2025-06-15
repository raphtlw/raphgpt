import { fmt } from "@grammyjs/parse-mode";
import { tool } from "ai";
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
  };
}
