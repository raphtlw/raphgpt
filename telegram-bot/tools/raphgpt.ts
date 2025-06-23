import { openai } from "@ai-sdk/openai";
import { TZDate } from "@date-fns/tz";
import { fmt } from "@grammyjs/parse-mode";
import { generateText, tool } from "ai";
import { getConfigValue } from "bot/config";
import { telegram } from "bot/telegram";
import type { ToolData } from "bot/tool-data";
import { s3 } from "bun";
import { fileTypeFromBuffer } from "file-type";
import path from "path";
import pdf2pic from "pdf2pic";
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

    get_directions: tool({
      description:
        "Get turn-by-turn directions between an origin and a destination. " +
        "Supports driving, walking, bicycling, transit, optional waypoints " +
        "and avoidance settings.",
      parameters: z.object({
        origin: z
          .string()
          .describe(
            'Start location: address, place name, lat/lng (`"lat,lng"`), or Place ID',
          ),
        destination: z
          .string()
          .describe(
            'End location: address, place name, lat/lng (`"lat,lng"`), or Place ID',
          ),
        travel_mode: z
          .enum(["DRIVING", "WALKING", "BICYCLING", "TRANSIT"])
          .describe("Mode of travel"),
        waypoints: z
          .array(z.string())
          .optional()
          .describe(
            "Optional ordered list of intermediate stops. Format same as origin/destination",
          ),
        avoid_ferries: z
          .boolean()
          .optional()
          .describe("Whether to avoid ferries"),
        avoid_highways: z
          .boolean()
          .optional()
          .describe("Whether to avoid highways"),
        avoid_tolls: z
          .boolean()
          .optional()
          .describe("Whether to avoid toll roads"),
        unit_system: z
          .enum(["metric", "imperial"])
          .optional()
          .describe("Unit system for distances (default: metric)"),
        departure_time: z
          .union([z.string(), z.number()])
          .optional()
          .describe(
            "Departure time as `now` or Unix timestamp (only for driving/transit)",
          ),
      }),
      async execute({
        origin,
        destination,
        travel_mode,
        waypoints,
        avoid_ferries,
        avoid_highways,
        avoid_tolls,
        unit_system,
        departure_time,
      }) {
        const key = getEnv("GOOGLE_API_KEY", z.string());
        const params = new URLSearchParams({
          origin,
          destination,
          mode: travel_mode.toLowerCase(),
          key,
        });

        if (waypoints && waypoints.length > 0) {
          // waypoints joined by '|' per API spec
          params.append("waypoints", waypoints.join("|"));
        }
        if (avoid_ferries) params.append("avoid", "ferries");
        if (avoid_highways) {
          const prev = params.get("avoid");
          params.set("avoid", prev ? `${prev}|highways` : "highways");
        }
        if (avoid_tolls) {
          const prev = params.get("avoid");
          params.set("avoid", prev ? `${prev}|tolls` : "tolls");
        }
        if (unit_system) {
          params.append("units", unit_system);
        }
        if (departure_time) {
          params.append("departure_time", String(departure_time));
        }

        const url = `https://maps.googleapis.com/maps/api/directions/json?${params}`;
        const res = await fetch(url);
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`Google Directions API error ${res.status}: ${txt}`);
        }
        const data = await res.json();
        // Return the raw JSON. LLM can pick out steps, duration, distance etc.
        return data;
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

    codex_agent: tool({
      description:
        "Enqueue a codex run, on task-runner." +
        "Codex is a coding agent created by OpenAI." +
        "Be as detailed as possible in the prompt." +
        "It sends a .zip file of the folder after it's done to the user.",
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

    file_operator: tool({
      description:
        "Fetch any file from S3 by key, turn it into images or text, " +
        "send it plus an instruction to a multi-modal LLM, and return its reply.",
      parameters: z.object({
        key: z.string().describe("S3 object key/path of the file"),
        instruction: z
          .string()
          .optional()
          .describe(
            "What to do with the file, e.g. 'give me a summary of everything in this file'",
          ),
      }),
      async execute({ key, instruction }) {
        // Download bytes from S3
        const bucket = getEnv("S3_BUCKET", z.string());
        const region = getEnv("S3_REGION", z.string());
        const arrayBuffer = await s3
          .file(key, { bucket, region })
          .arrayBuffer();
        const fileBuf = Buffer.from(arrayBuffer);

        // Detect extension
        const type = await fileTypeFromBuffer(fileBuf);
        const ext = type?.ext?.toLowerCase() || "";

        // Write into temp dir so pdf2pic / Gotenberg can read it
        const localPath = path.join(ctx.session.tempDir, path.basename(key));
        await Bun.write(localPath, fileBuf);

        // Build up a list of DataContent parts
        const parts: Array<
          { type: "text"; text: string } | { type: "image"; image: Buffer }
        > = [];

        if (ext === "pdf") {
          // render every page to PNG
          parts.push({ type: "text", text: "PDF file pages:" });
          const converter = pdf2pic.fromPath(localPath, {
            density: 100,
            format: "png",
            width: 600,
            height: 600,
          });
          const pages = await converter.bulk(-1, { responseType: "buffer" });
          for (const p of pages) {
            parts.push({ type: "image", image: Buffer.from(p.buffer!) });
          }
        } else if (ext === "docx") {
          parts.push({ type: "text", text: "DOCX file pages:" });
          const form = new FormData();
          form.append("files", Bun.file(localPath));
          const gotenbergRes = await fetch(
            "http://gotenberg:3000/forms/libreoffice/convert",
            { method: "POST", body: form },
          );
          const pdfBuf = Buffer.from(await gotenbergRes.arrayBuffer());
          const pdfPath = localPath.replace(/\.docx$/, ".pdf");
          await Bun.write(pdfPath, pdfBuf);
          const converter = pdf2pic.fromPath(pdfPath, {
            density: 100,
            format: "png",
            width: 600,
            height: 600,
          });
          const pages = await converter.bulk(-1, { responseType: "buffer" });
          for (const p of pages) {
            parts.push({ type: "image", image: Buffer.from(p.buffer!) });
          }
        } else if (["jpg", "jpeg", "png", "webp"].includes(ext)) {
          // raw image
          parts.push({ type: "image", image: fileBuf });
        } else {
          // fallback to text
          const txt = fileBuf.toString("utf8");
          parts.push({ type: "text", text: txt });
        }

        // Append the user’s instruction
        parts.push({
          type: "text",
          text:
            instruction ??
            "Summarize everything in this file in a few sentences.",
        });

        // Call multi-modal LLM
        const { text } = await generateText({
          model: openai("o4-mini", { structuredOutputs: false }),
          system:
            "You are a multi-modal assistant. Process the provided file contents per user instruction.",
          messages: [
            {
              role: "user",
              content: parts,
            },
          ],
        });

        return text;
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
