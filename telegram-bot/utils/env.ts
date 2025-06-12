import { z } from "zod";

export function getEnv<T = string>(
  name: string,
  schema: z.ZodSchema<T> = z.string() as unknown as z.ZodSchema<
    T,
    z.ZodStringDef
  >,
) {
  const output = schema.safeParse(import.meta.env[name]);
  if (!output.success) {
    throw new Error(
      `Environment variable ${name} not found!` + "\n" + output.error.message,
    );
  }
  return output.data;
}
