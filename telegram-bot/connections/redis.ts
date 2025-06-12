import { createClient } from "redis";
import { getEnv } from "utils/env";

const client = createClient({
  url: getEnv("REDIS_URL"),
});

await client.connect();

export { client as redis };
