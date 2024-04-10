import assert from "assert";
import OpenAI from "openai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type HyperFunctionData = {
  _description: string;
  _schema: z.AnyZodObject;
  _handler: (args: unknown) => Promise<unknown> | unknown;
};

export const hyperFunctionToTool = (name: string, data: HyperFunctionData) => {
  let parameters: OpenAI.FunctionParameters;

  const schema = zodToJsonSchema(data._schema);
  if ("type" in schema && "properties" in schema && "required" in schema) {
    parameters = {
      type: schema.type,
      properties: schema.properties,
      required: schema.required,
    };
  } else {
    parameters = {};
  }

  const tool: OpenAI.Chat.Completions.ChatCompletionTool = {
    function: {
      name,
      description: data._description,
      parameters,
    },
    type: "function",
  };

  return tool;
};

/**
 * Storage for HyperFunction(s) with associated methods
 */
export const hyperStore = (functions: Record<string, HyperFunctionData>) => ({
  functions: new Map(Object.entries(functions)),

  set(name: string, hf: HyperFunctionData) {
    this.functions.set(name, hf);
  },

  async callTool(data: OpenAI.Chat.Completions.ChatCompletionMessageToolCall) {
    const hyperFunction = this.functions.get(data.function.name);
    assert(hyperFunction);

    const args = hyperFunction._schema.parse(
      JSON.parse(data.function.arguments),
    );
    const response = hyperFunction._handler(args);

    if (response instanceof Promise) return await response;
    return response;
  },

  asTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return Array.from(this.functions).map(([k, v]) =>
      hyperFunctionToTool(k, v),
    );
  },
});

/**
 * Define new HyperFunction
 */
export const hyper = <
  Args extends Record<string, z.ZodFirstPartySchemaTypes>,
  Return,
>({
  description,
  args,
  handler,
}: {
  description: string;
  args: Args;
  handler: (args: { [K in keyof Args]: z.infer<Args[K]> }) =>
    | Promise<Return>
    | Return;
}): HyperFunctionData => {
  return {
    _schema: z.object(args),
    _handler: handler as (args: unknown) => unknown,
    _description: description,
  };
};
