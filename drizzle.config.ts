import type { Config } from "drizzle-kit";

import { z } from "zod";

const Env = z
  .object({
    DATABASE_URL: z.string(),
  })
  .parse(process.env);

export default {
  dbCredentials: {
    url: Env.DATABASE_URL,
  },
  driver: "libsql",
  out: "./drizzle",
  schema: "./db/schema.ts",
} satisfies Config;
