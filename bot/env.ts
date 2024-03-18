import { z } from "zod";

export const envSchema = z.object({
  DATABASE_URL: z.string(),
  TELEGRAM_API_KEY: z.string(),
  OPENROUTER_API_KEY: z.string(),
  REPLICATE_API_TOKEN: z.string(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string(),
  GOOGLE_AI_API_KEY: z.string(),
  GOOGLE_CUSTOM_SEARCH_API_KEY: z.string(),
  GOOGLE_CUSTOM_SEARCH_ENGINE_ID: z.string(),
  HUGGINGFACE_HUB_TOKEN: z.string(),
  MEMGPT_SERVER_KEY: z.string(),
  MEMGPT_URL: z.string(),
  TELEGRAM_BOT_UPDATES_CHAT_ID: z.string(),
  TELEGRAM_BOT_TESTING_CHAT_ID: z.string(),
  OPENAI_API_KEY: z.string(),
  TELEGRAM_GPT4_CHAT_ID: z.string(),
  COINGECKO_API_KEY: z.string(),
  OLLAMA_URL: z.string(),
});

export const Env = envSchema.parse(process.env);
