import path from "path";
import { getEnv } from "utils/env";
import { z } from "zod";

export const DATA_DIR =
  getEnv("DATA_DIR", z.string().optional()) ?? path.resolve("raphgpt-data");
export const TEMP_DIR = path.join(DATA_DIR, "temp");

export const PROMPTS_DIR = path.join(process.cwd(), "prompts");

export const PRODUCTION = getEnv("PRODUCTION", z.coerce.boolean());

export const OPENROUTER_FREE = "deepseek/deepseek-r1:free";

export const TYPING_INDICATOR_DURATION = 5 * 1000;

export const LLM_TOOLS_LIMIT = 10;
