import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getEnv } from "../helpers/env.js";
import * as schema from "./schema.js";

const client = new pg.Client({
  connectionString: `postgresql://${getEnv("POSTGRES_USER")}:${getEnv("POSTGRES_PASSWORD")}@${getEnv("POSTGRES_HOST")}/${getEnv("POSTGRES_USER")}`,
});
await client.connect();

export const db = drizzle(client, { schema });

export { schema as tables };
