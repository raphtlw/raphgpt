import assert from "assert";
import OpenAI from "openai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type HyperFunctionData<Context> = {
  _description: string;
  _schema: z.AnyZodObject;
  _handler: (args: unknown, context: Context) => Promise<unknown> | unknown;
};

export const hyperFunctionToTool = <Context>(
  name: string,
  data: HyperFunctionData<Context>,
) => {
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
export const hyperStore = <Context>(
  functions: Record<string, HyperFunctionData<Context>>,
) => ({
  functions: new Map(Object.entries(functions)),

  set(name: string, hf: HyperFunctionData<Context>) {
    this.functions.set(name, hf);
  },

  async callTool(
    data: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
    context: Context,
  ) {
    const hyperFunction = this.functions.get(data.function.name);
    assert(hyperFunction);

    const args = hyperFunction._schema.parse(
      JSON.parse(data.function.arguments),
    );
    const response = hyperFunction._handler(args, context);

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
  Context,
  Return,
>({
  description,
  args,
  handler,
}: {
  description: string;
  args: Args;
  handler: (
    args: { [K in keyof Args]: z.infer<Args[K]> },
    context: Context,
  ) => Promise<Return> | Return;
}): HyperFunctionData<Context> => {
  return {
    _schema: z.object(args),
    _handler: handler as (args: unknown, context: unknown) => unknown,
    _description: description,
  };
};
