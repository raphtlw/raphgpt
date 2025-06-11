import Replicate from "replicate";
import { getEnv } from "utils/env";
import { z } from "zod";

const client = new Replicate();

export const runModel = async <
  InputSchema extends z.ZodSchema = z.ZodSchema,
  OutputSchema extends z.ZodSchema = z.ZodSchema,
>(
  identifier: `${string}/${string}` | `${string}/${string}:${string}`,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  input: z.input<InputSchema>,
): Promise<z.infer<OutputSchema>> => {
  const i = inputSchema.parse(input);
  const output = await client.run(identifier, { input: i });
  return outputSchema.parse(output);
};

export const replicate = new Replicate({
  auth: getEnv("REPLICATE_API_TOKEN", z.string()),
});
