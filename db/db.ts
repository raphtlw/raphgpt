import * as schema from "@/db/schema.js";
import { getEnv } from "@/helpers/env.js";
import { drizzle } from "drizzle-orm/libsql";

export const db = drizzle({
  connection: {
    url: getEnv("TURSO_CONNECTION_URL"),
    authToken: getEnv("TURSO_AUTH_TOKEN"),
  },
  schema,
});

export { schema as tables };
