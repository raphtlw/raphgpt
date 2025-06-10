import * as schema from "db/schema";
import { drizzle } from "drizzle-orm/libsql";

export const db = drizzle({
  connection: {
    url: process.env.DATABASE_URL!,
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
  schema,
});

export { schema as tables };
