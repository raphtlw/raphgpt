#!/usr/bin/env tsx

import { initDB } from "db/db";
import { chats, users } from "db/schema";

const db = initDB();

await db.delete(chats);
await db.delete(users);
