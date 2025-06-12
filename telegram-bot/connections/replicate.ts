import Replicate from "replicate";
import { getEnv } from "utils/env";
import { z } from "zod";

export const replicate = new Replicate({
  auth: getEnv("REPLICATE_API_TOKEN", z.string()),
});

export const runModel = async <
  InputSchema extends z.ZodSchema = z.ZodSchema,
  OutputSchema extends z.ZodSchema = z.ZodSchema,
>(
  identifier: `${string}/${string}` | `${string}/${string}:${string}`,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  input: z.input<InputSchema>,
  abortSignal?: AbortSignal,
): Promise<z.infer<OutputSchema>> => {
  const i = inputSchema.parse(input);
  const output = await replicate.run(identifier, {
    input: i,
    signal: abortSignal,
  });
  return outputSchema.parse(output);
};
