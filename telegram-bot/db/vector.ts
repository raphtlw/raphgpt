import { vectorStore } from "connections/vector";
import { z } from "zod";

export const chatMemorySchema = z.object({
  chatId: z.number(),
  messageIds: z.array(z.number()),
});
export type ChatMemory = z.infer<typeof chatMemorySchema>;

export async function searchChatMemory(
  chatId: number,
  query: string,
  max: number,
) {
  const results = await vectorStore.query({
    data: query,
    topK: max,
    filter: `chatId = ${chatId}`,
    includeMetadata: true,
  });

  return results.map((result) => chatMemorySchema.parse(result.metadata));
}
