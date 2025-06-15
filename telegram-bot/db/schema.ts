import { relations, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").notNull(),
  userId: integer("user_id").unique(),
  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  freeTierMessageCount: integer("free_tier_message_count").default(0).notNull(),
  credits: integer("credits").default(0).notNull(),
  solanaWallet: integer("solana_wallet_id").unique(),
});

export const usersRelations = relations(users, ({ one }) => ({
  solanaWallet: one(solanaWallets),
}));

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").notNull(),
  userId: integer("user_id").notNull(),
  role: text("role", {
    enum: ["user", "assistant", "tool"],
  }).notNull(),

  // Only present when role = 'assistant'
  assistantParts: text("assistant_parts"),

  // Only present when role = 'tool'
  toolParts: text("tool_parts"),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const messageParts = sqliteTable("message_parts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  messageId: integer("message_id")
    .notNull()
    .references(() => messages.id, { onDelete: "cascade" }),
  order: integer("order").notNull(),

  type: text("type", { enum: ["text", "image", "file"] }).notNull(),

  // For text parts
  text: text("text"),

  // For S3-backed parts (image, file)
  region: text("region"),
  bucket: text("bucket"),
  key: text("key"), // S3 object key (path/filename)

  // File display/download info
  mimeType: text("mime_type"),
  originalName: text("original_name"), // Optional, original uploaded file name
});

export const personality = sqliteTable("personality", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  content: text("content").notNull(),
});

export const systemInstructions = sqliteTable("system_instructions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  content: text("content").notNull(),
});

export const interactionExamples = sqliteTable("interaction_examples", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userInput: text("user_input").notNull(),
  botResponse: text("bot_response").notNull(),
});

export const solanaWallets = sqliteTable("solana_wallets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  owner: integer("owner_id").notNull(),
  secretKey: text("private_key").notNull(),
  publicKey: text("public_key").notNull(),
  balanceLamports: integer("balance_lamports").notNull(),
});

export const solanaWalletsRelations = relations(solanaWallets, ({ one }) => ({
  owner: one(users, {
    fields: [solanaWallets.id],
    references: [users.solanaWallet],
  }),
}));
