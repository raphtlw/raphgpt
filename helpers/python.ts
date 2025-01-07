import got from "got";
import { getEnv } from "./env.js";

export const callPython = async <P, R extends unknown = any>(
  procedure: string,
  payload: P,
): Promise<R> => {
  return await got
    .post(`http://localhost:${getEnv("PYTHON_PORT")}/${procedure}`, {
      json: payload,
    })
    .json();
};
