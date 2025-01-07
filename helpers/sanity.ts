import { createClient } from "@sanity/client";
import { format } from "date-fns";
import { getEnv } from "./env.js";

export const sanity = createClient({
  projectId: getEnv("SANITY_PROJECT_ID"),
  dataset: "production",
  useCdn: true,
  apiVersion: format(new Date(), "yyyy-MM-dd"),
  token: getEnv("SANITY_TOKEN"),
});
