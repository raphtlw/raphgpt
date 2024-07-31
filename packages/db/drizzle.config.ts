import assert from "assert";
import { defineConfig } from "drizzle-kit";

assert(
  process.env.TURSO_DATABASE_URL,
  "Environment variable TURSO_DATABASE_URL not defined!",
);

export default defineConfig({
  schema: "./schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  driver: "turso",
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
});
