import { defineConfig } from "drizzle-kit";
import { getEnv } from "./helpers/env.js";

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: `postgresql://${getEnv("POSTGRES_USER")}:${getEnv("POSTGRES_PASSWORD")}@${getEnv("POSTGRES_HOST")}/${getEnv("POSTGRES_USER")}`,
  },
});
