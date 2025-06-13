import { createId } from "@paralleldrive/cuid2";
import type {
  AssistantContent,
  CoreMessage,
  FilePart,
  ImagePart,
  TextPart,
  ToolCallPart,
  ToolContent,
  ToolResultPart,
  UserContent,
} from "ai";
import { s3 } from "bun";
import { db, tables } from "db";
import { and, eq, inArray } from "drizzle-orm";
import superjson from "superjson";

export async function insertUserMessage({
  chatId,
  userId,
  content,
  s3Bucket,
  s3Region,
}: {
  chatId: number;
  userId: number;
  content: UserContent;
  s3Bucket: string;
  s3Region: string;
}) {
  // Insert messages row
  const messageRow = await db
    .insert(tables.messages)
    .values({ chatId, userId, role: "user" })
    .returning({ id: tables.messages.id })
    .get();
  const messageId = messageRow.id;

  // Normalise to array for simpler handling
  const contentArr: Array<TextPart | ImagePart | FilePart> =
    typeof content === "string" ? [{ type: "text", text: content }] : content;

  // Prepare batch insert
  const partsToInsert: (typeof tables.messageParts.$inferInsert)[] = [];
  for (let order = 0; order < contentArr.length; order++) {
    const part = contentArr[order];
    if (part?.type === "text") {
      partsToInsert.push({
        messageId,
        order,
        type: "text",
        text: part.text,
      });
    } else if (part?.type === "image") {
      const key = `messages/${chatId}/${userId}/${messageId}/${order}-${createId()}`;
      const mimeType = part.mimeType || "application/octet-stream";
      if (
        part.image instanceof Buffer ||
        part.image instanceof Uint8Array ||
        part.image instanceof ArrayBuffer
      ) {
        await s3
          .file(key)
          .write(part.image, { bucket: s3Bucket, type: mimeType });

        partsToInsert.push({
          messageId,
          order,
          type: "image",
          region: s3Region,
          bucket: s3Bucket,
          key,
          mimeType,
          originalName: part.providerOptions?.openai?.filename
            ? String(part.providerOptions?.openai?.filename)
            : undefined,
        });
      } else if (part.image instanceof URL || typeof part.image === "string") {
        const file = await fetch(part.image);
        await s3.file(key).write(file, {
          bucket: s3Bucket,
          type: mimeType,
        });

        partsToInsert.push({
          messageId,
          order,
          type: "image",
          region: s3Region,
          bucket: s3Bucket,
          key,
          mimeType,
        });
      }
    } else if (part?.type === "file") {
      // Same as image, but .data, .mimeType, .filename are required
      const key = `messages/${chatId}/${userId}/${messageId}/${order}-${createId()}-${part.filename || "file"}`;
      if (
        part.data instanceof Buffer ||
        part.data instanceof Uint8Array ||
        part.data instanceof ArrayBuffer
      ) {
        await s3.file(key).write(part.data, {
          bucket: s3Bucket,
          type: part.mimeType,
        });

        partsToInsert.push({
          messageId,
          order,
          type: "file",
          region: s3Region,
          bucket: s3Bucket,
          key,
          mimeType: part.mimeType,
          originalName: part.filename,
        });
      } else if (part.data instanceof URL || typeof part.data === "string") {
        const file = await fetch(part.data);
        await s3.file(key).write(file, {
          bucket: s3Bucket,
          type: part.mimeType,
        });

        partsToInsert.push({
          messageId,
          order,
          type: "file",
          region: s3Region,
          bucket: s3Bucket,
          key,
          mimeType: part.mimeType,
          originalName: part.filename,
        });
      }
    }
  }
  if (partsToInsert.length > 0) {
    await db.insert(tables.messageParts).values(partsToInsert);
  }
  return messageId;
}

export async function insertMessage({
  chatId,
  userId,
  role,
  content,
  s3Bucket,
  s3Region,
}: {
  chatId: number;
  userId: number;
  role: "user" | "assistant" | "tool";
  content: UserContent | AssistantContent | ToolContent;
  s3Bucket: string;
  s3Region: string;
}): Promise<number> {
  if (role === "user") {
    return await insertUserMessage({
      chatId,
      userId,
      content: content as UserContent,
      s3Bucket,
      s3Region,
    });
  } else if (role === "tool") {
    const row = await db
      .insert(tables.messages)
      .values({
        chatId,
        userId,
        role,
        toolParts: superjson.stringify(content as ToolContent),
      })
      .returning({ id: tables.messages.id })
      .get();
    return row.id;
  } else if (role === "assistant") {
    const row = await db
      .insert(tables.messages)
      .values({
        chatId,
        userId,
        role,
        assistantParts: superjson.stringify(content as AssistantContent),
      })
      .returning({ id: tables.messages.id })
      .get();
    return row.id;
  } else {
    throw new Error("Invalid role");
  }
}

/**
 * Fetch messages for a given chatId and userId, ordered by creation time.
 * Optionally limits the number of messages returned.
 */
export async function pullMessagesByChatAndUser({
  chatId,
  userId,
  limit,
}: {
  chatId: number;
  userId: number;
  limit?: number;
}): Promise<CoreMessage[]> {
  // Fetch all message IDs for this chat and user, ordered by creation time
  const messageIdRows = await db
    .select({ id: tables.messages.id })
    .from(tables.messages)
    .where(
      and(
        eq(tables.messages.chatId, chatId),
        eq(tables.messages.userId, userId),
      ),
    )
    .orderBy(tables.messages.createdAt)
    .all();

  const messageIds = messageIdRows.map((r) => r.id);
  // Retrieve full messages and ensure that any assistant tool-calls are
  // immediately followed by their corresponding tool-result messages,
  // as required by the OpenAI API when using tools.
  const rawMessages = await pullMessageHistory(messageIds);
  const toolMap = new Map<string, CoreMessage[]>();
  for (const msg of rawMessages) {
    if (msg.role === "tool") {
      const parts = msg.content as ToolResultPart[];
      for (const p of parts) {
        const list = toolMap.get(p.toolCallId) || [];
        list.push(msg);
        toolMap.set(p.toolCallId, list);
      }
    }
  }

  // Flatten messages: skip standalone tool messages, attach tool results after assistant messages
  const grouped: CoreMessage[] = [];
  for (const msg of rawMessages) {
    if (msg.role === "tool") {
      continue;
    }
    grouped.push(msg);
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const parts = msg.content as (ToolCallPart | unknown)[];
      for (const p of parts) {
        if ((p as ToolCallPart).type === "tool-call") {
          const id = (p as ToolCallPart).toolCallId;
          const tools = toolMap.get(id);
          if (tools) {
            for (const t of tools) {
              grouped.push(t);
            }
          }
        }
      }
    }
  }

  // Group messages into [user, assistant + tool results] sets
  const sets: CoreMessage[][] = [];
  let currentSet: CoreMessage[] = [];
  for (const msg of grouped) {
    if (msg.role === "user") {
      if (currentSet.length > 0) {
        sets.push(currentSet);
      }
      currentSet = [msg];
    } else {
      if (currentSet.length === 0) {
        currentSet = [msg];
      } else {
        currentSet.push(msg);
      }
    }
  }
  if (currentSet.length > 0) {
    sets.push(currentSet);
  }

  // Limit number of sets to the most recent `limit` sets if provided
  const limitedSets = limit !== undefined ? sets.slice(-limit) : sets;

  // Flatten sets back into CoreMessage[] and return
  return limitedSets.flat();
}

/**
 * Raw DB fetch/mapping of messages by their IDs into CoreMessage[].
 * Does not perform tool-call grouping.
 */
async function getRawMessageHistory(
  messageIds: number[],
): Promise<CoreMessage[]> {
  const messages: CoreMessage[] = [];

  const rows = await db
    .select({
      messageId: tables.messages.id,
      chatId: tables.messages.chatId,
      userId: tables.messages.userId,
      role: tables.messages.role,
      createdAt: tables.messages.createdAt,
      assistantParts: tables.messages.assistantParts,
      toolParts: tables.messages.toolParts,
      partId: tables.messageParts.id,
      partOrder: tables.messageParts.order,
      partType: tables.messageParts.type,
      text: tables.messageParts.text,
      region: tables.messageParts.region,
      bucket: tables.messageParts.bucket,
      key: tables.messageParts.key,
      mimeType: tables.messageParts.mimeType,
      originalName: tables.messageParts.originalName,
    })
    .from(tables.messages)
    .leftJoin(
      tables.messageParts,
      eq(tables.messages.id, tables.messageParts.messageId),
    )
    .where(inArray(tables.messages.id, messageIds))
    .orderBy(tables.messages.createdAt)
    .all();

  const groups = new Map<number, typeof rows>();
  for (const r of rows) {
    const arr = groups.get(r.messageId) || [];
    arr.push(r);
    groups.set(r.messageId, arr);
  }

  for (const [, groupRows] of groups) {
    const first = groupRows[0]!;
    switch (first.role) {
      case "user": {
        const userContent: UserContent = [];
        for (const part of groupRows) {
          if (!part.partId) continue;
          if (part.partType === "text") {
            userContent.push({ type: "text", text: part.text! });
          } else if (part.partType === "image") {
            const buf = await s3
              .file(part.key!, { region: part.region!, bucket: part.bucket! })
              .arrayBuffer();
            userContent.push({
              type: "image",
              image: buf,
              mimeType: part.mimeType!,
            });
          } else if (part.partType === "file") {
            const buf = await s3
              .file(part.key!, { region: part.region!, bucket: part.bucket! })
              .arrayBuffer();
            userContent.push({
              type: "file",
              data: buf,
              filename: part.originalName ?? undefined,
              mimeType: part.mimeType!,
            });
          }
        }
        messages.push({ role: "user", content: userContent });
        break;
      }
      case "tool": {
        const toolContent = superjson.parse<ToolContent>(first.toolParts!);
        messages.push({ role: "tool", content: toolContent });
        break;
      }
      case "assistant": {
        const assistantContent = superjson.parse<AssistantContent>(
          first.assistantParts!,
        );
        messages.push({ role: "assistant", content: assistantContent });
        break;
      }
    }
  }

  return messages;
}

/**
 * Fetch messages by IDs from the DB.
 */
export async function pullMessageHistory(
  messageIds: number[],
): Promise<CoreMessage[]> {
  return getRawMessageHistory(messageIds);
}
