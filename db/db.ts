import { createClient } from "@libsql/client";
import assert from "assert";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

assert(
  process.env.TURSO_DATABASE_URL,
  "Environment variable TURSO_DATABASE_URL not defined!",
);

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export const db = drizzle(client, { schema });

export { schema as tables };
