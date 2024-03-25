import { relations } from "drizzle-orm";
import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const chats = sqliteTable("chats", {
  agentId: text("memgpt_agent_id").notNull(),
  id: text("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  memgptApiKey: text("memgpt_api_key").notNull(),
  memgptUserId: text("memgpt_user_id").notNull(),
  telegramId: text("telegram_id").notNull(),
});

export const interimForwards = sqliteTable("interim_forwards", {
  forwardedMessageId: text("forwarded_message_id").notNull(),
  id: text("id").primaryKey(),
  originalMessageChatId: text("original_message_chat_id").notNull(),
  originalMessageId: text("original_message_id").notNull(),
});

export const interimForwardsRelations = relations(
  interimForwards,
  ({ one }) => ({
    agentResponse: one(agentResponses),
  })
);

export const agentResponses = sqliteTable("agent_responses", {
  content: text("content").notNull(),
  id: text("id").primaryKey(),
  interimForwardedMessage: text("interim_forwarded_message")
    .notNull()
    .references(() => interimForwards.id),
});

export const openaiMessages = sqliteTable("openai_messages", {
  created: int("created").notNull(),
  data: text("data").notNull(),
  id: text("id").primaryKey(),
});

export const scheduledMessages = sqliteTable("scheduled_messages", {
  chatId: text("chat_id").notNull(),
  content: text("content").notNull(),
  id: text("id").primaryKey(),
  scheduledFor: int("scheduled_for").notNull(),
});
