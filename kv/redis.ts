import logger from "@/bot/logger";
import { getEnv } from "@/helpers/env";
import { createClient } from "redis";

const client = createClient({
  url: `redis://default:${getEnv("REDIS_PASSWORD")}@${getEnv("REDIS_HOST")}:${getEnv("REDIS_PORT")}`,
});

client.on("error", (error) => logger.error(error, "Redis Client Error"));

await client.connect();

export { client as kv };
