import { Index } from "@upstash/vector";
import { getEnv } from "utils/env";

export const vectorStore = new Index({
  url: getEnv("UPSTASH_VECTOR_REST_URL"),
  token: getEnv("UPSTASH_VECTOR_REST_TOKEN"),
});
