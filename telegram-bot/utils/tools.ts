import type { ToolSet } from "ai";
import { inspect } from "bun";
import similarity from "utils/cosine-similarity";
import { featureExtractor } from "utils/feature-extractor";

export function mergeTools(...toolSets: ToolSet[]): ToolSet {
  const tools: ToolSet = {};

  for (const toolSet of toolSets) {
    for (const [key, tool] of Object.entries(toolSet)) {
      tools[key] = tool;
    }
  }

  return tools;
}

/**
 * Semantically search a set of tools against a natural language query.
 * Returns a subset of tools sorted by relevance (highest first), up to maxResults.
 *
 * @param query - Natural language query to score tools against.
 * @param toolSet - Full set of available tools to search.
 * @param maxResults - Maximum number of top-scoring tools to return.
 * @returns A ToolSet mapping selected tool names to their definitions.
 */
export async function searchTools(
  query: string,
  toolSet: ToolSet,
  maxResults: number = Infinity,
) {
  const outputSet: ToolSet = {};
  const toolNames = Object.keys(toolSet);
  const descriptions = toolNames.map(
    (name) => `${name}: ${toolSet[name]!.description}`,
  );

  // Compute embeddings for tool descriptions
  const descOutput = await featureExtractor(descriptions, {
    pooling: "mean",
    normalize: true,
  });
  const descriptionEmbeddings: number[][] = descOutput.tolist();

  // Compute embedding for the input query
  const queryOutput = await featureExtractor([query], {
    pooling: "mean",
    normalize: true,
  });
  const queryEmbeddingsArr: number[][] = queryOutput.tolist();
  const queryEmbedding: number[] = queryEmbeddingsArr[0]!;

  const scores = toolNames.map((name, idx) => ({
    name,
    score: similarity(descriptionEmbeddings[idx]!, queryEmbedding) ?? -1,
  }));
  scores.sort((a, b) => b.score - a.score);

  const limited = scores.slice(0, maxResults);

  for (const scored of limited) {
    const tool = toolSet[scored.name];
    if (!tool) throw new Error("Tool not found in set");

    outputSet[scored.name] = tool;
  }

  console.log(`Result scores for tools: ${inspect(scores)}`);

  return outputSet;
}
