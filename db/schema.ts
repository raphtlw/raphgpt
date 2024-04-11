import { timestamp } from "bot/time";
import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

// export const chats = sqliteTable("chats", {
//   id: text("id").primaryKey(),
//   telegramId: text("telegram_id").notNull(),
// });

// export const chatsRelations = relations(chats, ({ many }) => ({
//   messages: many(messages),
// }));

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  telegramChatId: text("telegram_chat_id").notNull(),
  telegramAuthorId: text("telegram_author_id").notNull(),
  contextData: text("context_data").notNull(),
  text: text("text"),
  file: text("file"),
  created: int("created").notNull().$default(timestamp),
});

export const openaiMessages = sqliteTable("openai_messages", {
  id: text("id").primaryKey(),
  telegramChatId: text("telegram_chat_id").notNull(),
  telegramThreadId: text("telegram_thread_id"),
  json: text("json").notNull(),
  created: int("created").notNull().$default(timestamp),
});

export const guss = sqliteTable("guss", {
  id: text("id").primaryKey(),
  telegramUserId: text("telegram_user_id").notNull(),
  loss: int("loss").default(0),
  win: int("win").default(0),
  fromMessage: text("from_message").references(() => messages.id),
  sentMessage: text("sent_message"),
  reason: text("reason").notNull(),
  created: int("created").notNull().$default(timestamp),
});

// export const messagesRelations = relations(messages, ({ one }) => ({
//   chat: one(chats, {
//     fields: [messages.chatId],
//     references: [chats.id],
//   }),
// }));

// export const interimForwards = sqliteTable("interim_forwards", {
//   forwardedMessageId: text("forwarded_message_id").notNull(),
//   id: text("id").primaryKey(),
//   originalMessageChatId: text("original_message_chat_id").notNull(),
//   originalMessageId: text("original_message_id").notNull(),
// });

// export const interimForwardsRelations = relations(
//   interimForwards,
//   ({ one }) => ({
//     agentResponse: one(agentResponses),
//   })
// );

// export const agentResponses = sqliteTable("agent_responses", {
//   content: text("content").notNull(),
//   id: text("id").primaryKey(),
//   interimForwardedMessage: text("interim_forwarded_message")
//     .notNull()
//     .references(() => interimForwards.id),
// });

// export const openaiMessages = sqliteTable("openai_messages", {
//   created: int("created").notNull(),
//   data: text("data").notNull(),
//   id: text("id").primaryKey(),
// });

export const scheduledMessages = sqliteTable("scheduled_messages", {
  chatId: text("chat_id").notNull(),
  content: text("content").notNull(),
  id: text("id").primaryKey(),
  scheduledFor: int("scheduled_for").notNull(),
});
