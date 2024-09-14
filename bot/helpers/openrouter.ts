import { createOpenAI } from "@ai-sdk/openai";
import { getEnv } from "./env.js";

export const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  compatibility: "compatible",
  apiKey: getEnv("OPENROUTER_API_KEY"),
});
