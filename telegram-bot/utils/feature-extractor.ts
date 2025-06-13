import { pipeline } from "@huggingface/transformers";

export const featureExtractor = await pipeline(
  "feature-extraction",
  "Xenova/all-MiniLM-L6-v2",
);
