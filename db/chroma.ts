import { getEnv } from "@/helpers/env.js";
import { ChromaClient } from "chromadb";

export const chroma = new ChromaClient({
  path: `${getEnv("CHROMA_HOST")}:${getEnv("CHROMA_PORT")}`,
});
