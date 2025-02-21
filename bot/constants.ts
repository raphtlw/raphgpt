import { getEnv } from "@/helpers/env.js";
import path from "path";

export const DATA_DIR = path.resolve(getEnv("DATA_DIR"));
export const LOCAL_FILES_DIR = path.join(DATA_DIR, "files");
export const BROWSER_FILES_DIR = path.join(DATA_DIR, "browser");

export const PROMPTS_DIR = path.join(process.cwd(), "prompts");

export const PRODUCTION = getEnv("NODE_ENV") === "production";

export const OPENROUTER_FREE = "deepseek/deepseek-r1:free";

export const TYPING_INDICATOR_DURATION = 5 * 1000;
