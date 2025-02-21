import { defineConfig } from "drizzle-kit";
import { getEnv } from "@/helpers/env.js";

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./migrations",
  dialect: "turso",
  dbCredentials: {
    url: getEnv("TURSO_CONNECTION_URL"),
    authToken: getEnv("TURSO_AUTH_TOKEN"),
  },
});
