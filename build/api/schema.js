import { sqliteTable, text } from "drizzle-orm/sqlite-core";
export const knowledge = sqliteTable("knowledge", {
    id: text("id").primaryKey(),
    input: text("input").notNull(),
    output: text("output").notNull().unique(),
    originalInput: text("original_input").notNull(),
    originalOutput: text("original_output").notNull(),
});
