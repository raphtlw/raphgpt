import "dotenv/config";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { sqlite, db } from "./db.js";

migrate(db, { migrationsFolder: "./migrations" });

sqlite.close();
