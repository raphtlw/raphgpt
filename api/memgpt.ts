import { createApiClient } from "api/generated/memgpt";
import { Env } from "secrets/env";

export const memgpt = createApiClient(Env.MEMGPT_URL, {
  axiosConfig: {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${Env.MEMGPT_SERVER_KEY}`,
    },
  },
});
