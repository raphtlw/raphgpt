import Replicate from "replicate";
import { z } from "zod";

const client = new Replicate();

export const runModel = async <
  I extends object,
  O extends z.ZodSchema = z.ZodSchema,
>(
  identifier: `${string}/${string}` | `${string}/${string}:${string}`,
  input: I,
  schema: O,
): Promise<z.infer<O>> => {
  const output = await client.run(identifier, { input });
  return schema.parse(output);
};
