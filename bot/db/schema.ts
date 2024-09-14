import {
  integer,
  numeric,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  telegramId: integer("telegram_id").unique().notNull(),
  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  credits: numeric("credits").default("0").notNull(),
});

export const fullResponses = pgTable("full_responses", {
  id: serial("id").primaryKey(),
  title: text("title"),
  content: text("content").notNull(),
});

export const usage = pgTable(
  "usage",
  {
    userId: serial("user_id").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.model] }),
  }),
);

export const pendingPayments = pgTable("pending_payments", {
  id: serial("id").primaryKey(),
  telegramUserId: integer("telegram_user_id").notNull(),
  created: real("created").$default(Date.now).notNull(),
  payload: text("payload").notNull(),
});

export const localFiles = pgTable("local_files", {
  id: serial("id").primaryKey(),
  path: text("path").notNull(),
  content: text("content").notNull(),
});
