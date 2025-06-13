import Replicate from "replicate";
import { getEnv } from "utils/env";
import { z } from "zod";

export const replicate = new Replicate({
  auth: getEnv("REPLICATE_API_TOKEN", z.string()),
});
