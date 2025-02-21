import logger from "@/bot/logger.js";
import { telegram } from "@/bot/telegram";
import { chroma } from "@/db/chroma";
import { ToolData } from "@/helpers/function";
import { tool } from "ai";
import { Collection, DefaultEmbeddingFunction } from "chromadb";
import { z } from "zod";

export const toolbox = async (data: ToolData, query: string | string[]) => {
  const embeddingFunction = new DefaultEmbeddingFunction();

  const tools = {
    blockchain_data: tool({
      description: "Analyze the solana blockchain",
      parameters: z.object({}),
      async execute() {
        logger.debug("tool triggered");
        await telegram.sendMessage(data.chatId, "boom");

        return "ack";
      },
    }),
  };

  let toolCollection: Collection;

  try {
    toolCollection = await chroma.getCollection({
      name: "toolbox",
      embeddingFunction,
    });
  } catch {
    toolCollection = await chroma.createCollection({
      name: "toolbox",
      embeddingFunction,
    });
    await toolCollection.add({
      ids: Object.keys(tools),
      metadatas: Object.entries(tools).map(([name, tool]) => ({
        name,
        description: tool.description!,
      })),
      documents: Object.values(tools).map((tool) => {
        const fullText = [];
        fullText.push(tool.description);
        fullText.push(JSON.stringify(tool.parameters));
        return fullText.join(" ");
      }),
    });
  }

  const toUse = await toolCollection.query({
    queryTexts: Array.isArray(query) ? query : [query],
    include: ["metadatas"] as any,
  });

  // Ensure metadata exists and is structured properly
  if (!toUse.metadatas || !toUse.metadatas[0]) {
    logger.warn("No matching tools found.");
    return {};
  }

  const returnedTools: Partial<typeof tools> = {};

  for (const matchedTool of toUse.metadatas[0]) {
    const toolName = matchedTool?.name as keyof typeof tools;
    if (toolName && toolName in tools) {
      returnedTools[toolName] = tools[toolName];
    }
  }

  return returnedTools;
};
