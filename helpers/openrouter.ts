import { createOpenAI } from "@ai-sdk/openai";

export const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  compatibility: "compatible",
  apiKey: process.env.OPENROUTER_API_KEY,
});
