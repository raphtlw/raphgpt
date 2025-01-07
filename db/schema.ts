import { relations } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").notNull(),
  telegramId: integer("telegram_id").unique(),
  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  credits: integer("credits").default(0).notNull(),
  solanaWallet: integer("solana_wallet_id"),
});

export const usersRelations = relations(users, ({ one }) => ({
  solanaWallet: one(solanaWallets),
}));

export const localFiles = sqliteTable("local_files", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  path: text("path").notNull(),
  content: text("content").notNull(),
});

export const personality = sqliteTable("personality", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  content: text("content").notNull(),
});

export const solanaWallets = sqliteTable("solana_wallets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  owner: integer("owner_id")
    .notNull()
    .references(() => users.solanaWallet),
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
