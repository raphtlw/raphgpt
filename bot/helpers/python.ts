import got from "got";
import { getEnv } from "./env.js";

export const callPython = async <P, R extends unknown = any>(
  procedure: string,
  payload: P,
): Promise<R> => {
  return await got
    .post(`${getEnv("PYTHON_URL")}/${procedure}`, {
      json: payload,
    })
    .json();
};
