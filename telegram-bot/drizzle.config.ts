import { defineConfig } from "drizzle-kit";
import { getEnv } from "utils/env";

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./migrations",
  dialect: "turso",
  dbCredentials: {
    url: getEnv("DATABASE_URL"),
    authToken: getEnv("DATABASE_AUTH_TOKEN"),
  },
});
