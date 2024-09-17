import { ChromaClient } from "chromadb";
import { getEnv } from "../helpers/env.js";

export const chroma = new ChromaClient({ path: getEnv("CHROMA_BACKEND_URL") });
