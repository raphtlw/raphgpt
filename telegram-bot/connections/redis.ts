import logger from "bot/logger";
import { createClient } from "redis";
import { getEnv } from "utils/env";

const client = createClient({
  url: `rediss://default:${getEnv("REDIS_PASSWORD")}@${getEnv(
    "REDIS_ENDPOINT",
  )}:6379`,
});

client?.on?.("error", (error: unknown) => logger.error(error, "Redis Client Error"));

await client.connect();

export { client as kv };
