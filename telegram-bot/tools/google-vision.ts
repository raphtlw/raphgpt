import vision from "@google-cloud/vision";
import { tool } from "ai";
import type { ToolData } from "bot/tool-data";
import { inspect, s3 } from "bun";
import { getEnv } from "utils/env";
import { z } from "zod";

/**
 * identify_image: a tool that analyzes an image stored in S3
 * using Google Cloud Vision API. It returns labels, text, objects,
 * landmarks, logos, and web entities detected in the image.
 */
export function googleVisionTools({ ctx }: ToolData) {
  const client = new vision.ImageAnnotatorClient({
    apiKey: getEnv("GOOGLE_API_KEY"),
  });
  return {
    identify_image: tool({
      description:
        "Analyze an image in S3 using Google Cloud Vision API (labels, text, objects, logos, web entities)",
      parameters: z.object({
        key: z.string().describe("S3 key of the image to analyze"),
      }),
      async execute({ key }) {
        try {
          const s3file = s3.file(key);
          const arrayBuffer = await s3file.arrayBuffer();
          const imageBytes = Buffer.from(arrayBuffer);

          const [result] = await client.annotateImage({
            image: { content: imageBytes },
            features: [
              { type: "LABEL_DETECTION", maxResults: 10 },
              { type: "TEXT_DETECTION", maxResults: 10 },
              { type: "OBJECT_LOCALIZATION", maxResults: 10 },
              { type: "LANDMARK_DETECTION", maxResults: 5 },
              { type: "LOGO_DETECTION", maxResults: 5 },
              { type: "WEB_DETECTION", maxResults: 10 },
            ],
          });
          console.log("Image annotation response:", inspect(result));
          return result;
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      },
    }),

    landmark_detection: tool({
      description:
        "Detect landmarks in an image stored in S3 using Google Cloud Vision API",
      parameters: z.object({
        key: z.string().describe("S3 key of the image to analyze"),
      }),
      async execute({ key }) {
        try {
          const s3file = s3.file(key);
          const arrayBuffer = await s3file.arrayBuffer();
          const imageBytes = Buffer.from(arrayBuffer);

          const [result] = await client.annotateImage({
            image: { content: imageBytes },
            features: [{ type: "LANDMARK_DETECTION", maxResults: 5 }],
          });
          console.log("Landmark annotation response:", inspect(result));
          return result.landmarkAnnotations;
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      },
    }),
  };
}
