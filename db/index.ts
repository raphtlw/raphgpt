import { createClient } from "@libsql/client";
import * as schema from "db/schema";
import { drizzle } from "drizzle-orm/libsql";
import { Env } from "secrets/env";

export const initDB = () => {
  const client = createClient({
    url: Env.DATABASE_URL,
  });

  return drizzle(client, { schema });
};

export const db = initDB();
