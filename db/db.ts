import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Env } from "../bot/env";
import * as schema from "./schema";

export const initDB = () => {
  const client = createClient({
    url: Env.DATABASE_URL,
  });

  return drizzle(client, { schema });
};

export const db = initDB();
