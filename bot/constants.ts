import path from "path";
import { getEnv } from "../helpers/env.js";

export const DATA_DIR = path.join(process.cwd(), "data");
export const LOCAL_FILES_DIR = path.join(DATA_DIR, "files");
export const BROWSER_FILES_DIR = path.join(DATA_DIR, "browser");

export const PROMPTS_DIR = path.join(process.cwd(), "prompts");

export const PRODUCTION = getEnv("NODE_ENV") === "production";
