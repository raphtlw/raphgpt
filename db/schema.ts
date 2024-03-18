import { relations } from "drizzle-orm";
import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  memgptUserId: text("memgpt_user_id").notNull(),
  memgptApiKey: text("memgpt_api_key").notNull(),
});

export const chats = sqliteTable("chats", {
  id: text("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  agentId: text("memgpt_agent_id").notNull(),
});

export const interimForwards = sqliteTable("interim_forwards", {
  id: text("id").primaryKey(),
  forwardedMessageId: text("forwarded_message_id").notNull(),
  originalMessageId: text("original_message_id").notNull(),
  originalMessageChatId: text("original_message_chat_id").notNull(),
});

export const interimForwardsRelations = relations(
  interimForwards,
  ({ one }) => ({
    agentResponse: one(agentResponses),
  })
);

export const agentResponses = sqliteTable("agent_responses", {
  id: text("id").primaryKey(),
  interimForwardedMessage: text("interim_forwarded_message")
    .notNull()
    .references(() => interimForwards.id),
  content: text("content").notNull(),
});

export const openaiMessages = sqliteTable("openai_messages", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
  created: int("created").notNull(),
});

export const scheduledMessages = sqliteTable("scheduled_messages", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  content: text("content").notNull(),
  scheduledFor: int("scheduled_for").notNull(),
});
