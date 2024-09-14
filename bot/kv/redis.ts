import { createClient } from "redis";
import logger from "../bot/logger.js";
import { getEnv } from "../helpers/env.js";

const client = createClient({
  url: `redis://default:${getEnv("REDIS_PASSWORD")}@${getEnv("REDIS_HOST")}`,
});

client.on("error", (error) => logger.error(error, "Redis Client Error"));

await client.connect();

export { client as kv };
