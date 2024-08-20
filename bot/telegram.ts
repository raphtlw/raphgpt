import { Api } from "grammy";
import { getEnv } from "../helpers/env.js";

export const telegram = new Api(getEnv("TELEGRAM_BOT_TOKEN"));
