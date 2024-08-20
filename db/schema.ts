import { createId } from "@paralleldrive/cuid2";
import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$default(createId),
  telegramId: integer("telegram_id").unique().notNull(),
  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  credits: integer("credits").default(0).notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey().$default(createId),
  created: real("created").$default(Date.now),
  turnId: integer("turn_id").notNull(),
  chatId: integer("chat_id").notNull(),
  threadId: integer("thread_id").notNull(),
  json: text("json").notNull(),
});

export const fullResponses = sqliteTable("full_responses", {
  id: text("id").primaryKey().$default(createId),
  title: text("title"),
  content: text("content").notNull(),
});

export const usage = sqliteTable(
  "usage",
  {
    userId: text("user_id").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.model] }),
  }),
);

export const pendingPayments = sqliteTable("pending_payments", {
  id: text("id").primaryKey().$default(createId),
  telegramUserId: integer("telegram_user_id").notNull(),
  created: real("created").$default(Date.now).notNull(),
  payload: text("payload").notNull(),
});

export const localFiles = sqliteTable("local_files", {
  id: text("id").primaryKey().$default(createId),
  path: text("path").notNull(),
  content: text("content").notNull(),
});
