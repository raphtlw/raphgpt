import { openai } from "@ai-sdk/openai";
import { generateText, tool, type CoreMessage, type ToolSet } from "ai";
import { getConfigValue } from "bot/config";
import logger from "bot/logger";
import { telegram } from "bot/telegram";
import type { ToolData } from "bot/tool-data";
import { redis } from "connections/redis";
import { db } from "db";
import SuperJSON from "superjson";
import { buildPrompt } from "utils/prompt";
import YAML from "yaml";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const AVAILABLE_AGENTS: Map<string, AgentMetadata> = new Map();

export type AgentMetadata = {
  description: string;
  schema: string;
  callable: typeof agentExecute;
};

export function formatAgentMetadataForLLM(
  name: string,
  agentMetadata: AgentMetadata,
) {
  return `Agent name: ${name}
  description: ${agentMetadata.description}
  JSON schema: ${agentMetadata.schema}`;
}

export const agentExecute =
  (
    name: string,
    system: string,
    agents: string[],
    createTools: (data: ToolData) => ToolSet,
  ) =>
  async (data: ToolData, params: any) => {
    if (!data.ctx.from)
      throw new Error(`createAgent called on message without author!`);
    if (!data.ctx.chatId)
      throw new Error(`createAgent called on message without chat ID!`);

    const redisKey = `agents:${name}:context:${data.ctx.chatId}`;

    const context = await redis
      .get(redisKey)
      .then((val) => (val ? SuperJSON.parse<Array<CoreMessage>>(val) : []));

    context.push({
      role: "user",
      content: [
        {
          type: "text",
          text: "According to the input parameters, please act on the task given.",
        },
        {
          type: "text",
          text: `Input parameters:\n${YAML.stringify(params)}`,
        },
      ],
    });

    const { text, response, finishReason } = await generateText({
      model: openai("o4-mini", {
        structuredOutputs: false,
        reasoningEffort: "high",
      }),
      system: await buildPrompt("agent", {
        me: JSON.stringify(await telegram.getMe()),
        date: new Date().toLocaleString(),
        language: await getConfigValue(data.ctx.from.id, "language"),
        personality: (
          await db.query.personality.findMany({
            columns: {
              content: true,
            },
          })
        )
          .map((r) => r.content)
          .join("\n"),
        system,
        agents,
      }),
      messages: context,
      tools: {
        ...createTools(data),
        run_agent: tool({
          description: "Run any agent you have access to",
          parameters: z.object({
            name: z.string(),
            args: z.any(),
          }),
          async execute({ name, args }) {
            AVAILABLE_AGENTS.get(name)?.callable(
              name,
              system,
              agents,
              createTools,
            )(data, args);
          },
        }),
      },
      maxSteps: 5,
      abortSignal: data.ctx.session.task?.signal,
    });

    if (finishReason === "tool-calls") {
      // Cannot save because subsequent calls will result in error
      // Errors saying tool-call must be followed by tool call result

      logger.debug({ response, finishReason }, "Not saving (from createAgent)");
      return `Result ended abruptly without direct response from agent: ${text}`;
    }

    // Save context history in Redis
    logger.debug(response, `Response from ${name} agent`);
    context.push(...response.messages);
    await redis.set(redisKey, SuperJSON.stringify(context));

    return `Agent responded with: ${text}`;
  };

/**
 * An agent is an entity that has:
 * - it's own memory
 * - can call other agents
 * - answers back to its parent agent
 */
export function createAgent<PARAMETERS extends z.ZodTypeAny, RESULT>({
  name,
  description,
  parameters,
  system,
  createTools,
}: {
  name: string;
  description: string;
  parameters: PARAMETERS;
  system: string;
  createTools: (data: ToolData) => ToolSet;
}): (toolData: ToolData) => ToolSet {
  const agents: string[] = [];

  for (const [key, value] of AVAILABLE_AGENTS) {
    agents.push(formatAgentMetadataForLLM(key, value));
  }

  AVAILABLE_AGENTS.set(name, {
    description,
    schema: JSON.stringify(zodToJsonSchema(parameters)),
    callable: agentExecute,
  });

  return (toolData) => ({
    [name]: tool({
      description,
      parameters,
      execute: (args) => {
        return agentExecute(name, system, agents, createTools)(toolData, args);
      },
    }),
  });
}
