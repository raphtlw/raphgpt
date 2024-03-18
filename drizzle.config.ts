import type { Config } from "drizzle-kit";
import { Env } from "./bot/env";

export default {
  schema: "./db/schema.ts",
  out: "./drizzle",
  driver: "libsql",
  dbCredentials: {
    url: Env.DATABASE_URL,
  },
} satisfies Config;
