import { createAISDKTools } from "@agentic/ai-sdk";
import { createMcpTools } from "@agentic/mcp";

export async function connectMCPTools() {
  const everythingTools = createMcpTools({
    name: "everything",
    serverProcess: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
    },
  });

  const memoryTools = createMcpTools({
    name: "memory",
    serverProcess: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
  });

  return createAISDKTools(
    ...(await Promise.all([everythingTools, memoryTools])),
  );
}
