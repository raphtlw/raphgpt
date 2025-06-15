import { fmt } from "@grammyjs/parse-mode";
import { tool } from "ai";
import { ChatAction } from "bot/running-tasks";
import { downloadFile, telegram } from "bot/telegram";
import type { ToolData } from "bot/tool-data";
import { InputFile } from "grammy";
import { getEnv } from "utils/env";
import { z } from "zod";

/**
 * A set of default functions belonging to raphGPT, with data.
 *
 * These tools are unique to raphGPT only and undergo RAG
 * before being included in LLM calls.
 */
export function raphgptTools(data: ToolData) {
  // Tools specific to raphGPT, augment with domain-specific functionality
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
     * Reads a CSV file of tracks, searches YouTube for each track, downloads the best-match audio as MP3,
     * packages all downloads into a zip archive, and sends it back to the user.
     */
    download_songs_from_csv: tool({
      description:
        "Download the most recently sent CSV track list, optionally limit to rows start–end (1-based, inclusive), search YouTube for each row, download the top result as MP3, zip all MP3s, and send the zip to the user.",
      parameters: z.object({
        start: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("1-based first row index to process (inclusive)"),
        end: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("1-based last row index to process (inclusive)"),
      }),
      async execute({ start, end }) {
        const { localPath: csvPath } = await downloadFile(data.ctx);
        data.ctx.session.tempFiles.push(csvPath);

        const fs = await import("fs");
        const path = await import("path");
        const Papa = (await import("papaparse")).default;
        const ytSearch = (await import("yt-search")).default;
        const YTDlpWrap = (await import("yt-dlp-core")).default;
        const archiver = (await import("archiver")).default;
        const { createId } = await import("@paralleldrive/cuid2");
        const { TEMP_DIR } = await import("bot/constants");

        // prepare and ensure yt-dlp binary: download if missing
        const binPath = path.join(TEMP_DIR, "yt-dlp");
        let ytDlpWrap = new YTDlpWrap();
        try {
          await ytDlpWrap.getVersion();
        } catch {
          // download latest yt-dlp to TEMP_DIR
          await YTDlpWrap.downloadFromGithub(binPath);
          ytDlpWrap = new YTDlpWrap(binPath);
        }

        const csvText = await fs.promises.readFile(csvPath, "utf8");
        const parsed = Papa.parse<Record<string, string>>(csvText, {
          header: true,
          skipEmptyLines: true,
        });
        if (parsed.errors.length) {
          return `ERROR: CSV parse failed: ${parsed.errors
            .map((e) => e.message)
            .join(", ")}`;
        }
        const allRows = parsed.data;
        const total = allRows.length;
        let from = start != null ? start - 1 : 0;
        let to = end != null ? end - 1 : total - 1;
        if (from < 0) from = 0;
        if (to >= total) to = total - 1;
        if (from > to) {
          return `ERROR: invalid range [${start ?? 1}, ${end ?? total}]`;
        }
        const rows = allRows.slice(from, to + 1);
        const downloaded: string[] = [];
        const failed: string[] = [];

        for (const row of rows) {
          const title = (row["Track Name"] || row["track name"] || "").trim();
          const artist = (
            row["Artist Name(s)"] ||
            row["artist name(s)"] ||
            ""
          ).trim();
          if (!title) {
            failed.push("<unknown title>");
            continue;
          }
          const query = `${title} ${artist}`.trim();
          console.log("Searching for", query);

          let video;
          try {
            const results = await ytSearch(query);
            console.log("Result from ytSearch", results);
            video = results.videos?.[0];
          } catch (err: any) {
            failed.push(query);
            continue;
          }
          if (!video || !video.url) {
            failed.push(query);
            continue;
          }

          const safeName = `${title} - ${artist}`.replace(/[\\/:*?"<>|]/g, "_");
          const mp3Path = path.join(TEMP_DIR, `${safeName}.mp3`);
          try {
            await ytDlpWrap.execPromise([
              video.url,
              "-x",
              "--audio-format",
              "mp3",
              "-o",
              mp3Path,
            ]);
            data.ctx.session.tempFiles.push(mp3Path);
            downloaded.push(mp3Path);
          } catch (err: any) {
            failed.push(query);
            console.error("Error downloading via yt-dlp-core:", err);
          }
        }

        if (!downloaded.length) {
          return `ERROR: No tracks could be downloaded.`;
        }

        data.ctx.session.chatAction = new ChatAction(
          data.ctx.chatId!,
          "typing",
        );

        const zipName = `songs_${createId()}.zip`;
        const zipPath = path.join(TEMP_DIR, zipName);
        await new Promise<void>((resolve, reject) => {
          const output = fs.createWriteStream(zipPath);
          const archive = archiver("zip", { zlib: { level: 9 } });
          output.on("close", resolve);
          archive.on("error", reject);
          archive.pipe(output);
          for (const mp3 of downloaded) {
            archive.file(mp3, { name: path.basename(mp3) });
          }
          archive.finalize();
        });
        data.ctx.session.tempFiles.push(zipPath);

        await telegram.sendDocument(data.ctx.chatId!, new InputFile(zipPath), {
          caption:
            `Downloaded ${downloaded.length} tracks.` +
            (failed.length
              ? ` Skipped ${failed.length}: ${failed.join(", ")}`
              : ""),
          reply_parameters: {
            message_id: data.ctx.msgId!,
            allow_sending_without_reply: true,
          },
        });
        return zipPath;
      },
    }),
  };
}
