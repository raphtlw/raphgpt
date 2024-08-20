import assert from "assert";
import { z } from "zod";

export const getEnv = <T = string>(
  name: string,
  schema?: z.ZodSchema<T>,
): T => {
  assert(process.env[name], `Environment variable ${name} not defined!`);
  if (schema) {
    return schema.parse(process.env[name]);
  }
  return process.env[name] as T;
};
