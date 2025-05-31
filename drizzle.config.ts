import { getEnv } from "@/helpers/env.js";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./migrations",
  dialect: "turso",
  dbCredentials: {
    url: getEnv("TURSO_CONNECTION_URL"),
    authToken: getEnv("TURSO_AUTH_TOKEN"),
  },
});
