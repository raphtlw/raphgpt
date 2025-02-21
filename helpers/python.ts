import { getEnv } from "@/helpers/env.js";
import got from "got";

export const callPython = async <P, R = any>(
  procedure: string,
  payload: P,
): Promise<R> => {
  return await got
    .post(`http://localhost:${getEnv("PYTHON_PORT")}/${procedure}`, {
      json: payload,
    })
    .json();
};
