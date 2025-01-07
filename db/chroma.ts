import { getEnv } from "@/helpers/env.js";
import { ChromaClient } from "chromadb";

export const chroma = new ChromaClient({
  path: `http://localhost:${getEnv("CHROMA_PORT")}`,
});
