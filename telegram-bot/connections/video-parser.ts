import type { BunFile } from "bun";
import type { LanguageCode } from "grammy/types";
import { z } from "zod";

export const analyzeVideoResponse = z.object({
  transcript: z.string(),
  frames: z.array(z.string()),
  summary: z.string(),
});

/**
 * Returns frames in data:image/jpeg;base64,... URIs
 */
export async function analyzeVideo(file: BunFile, lang: LanguageCode) {
  const form = new FormData();
  form.append("file", file);
  form.append("lang", "en");

  const res = await fetch("http://video-parser/analyze", {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Video parser failed ${res.status}: ${txt}`);
  }

  return analyzeVideoResponse.parse(await res.json());
}
