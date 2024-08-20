import got from "got";

export const callBeamEndpoint = async <
  T extends unknown = any,
  R extends unknown = any,
>(
  endpoint: string,
  payload: T,
): Promise<R> => {
  return await got
    .post(`https://app.beam.cloud/endpoint/${endpoint}`, {
      headers: {
        Connection: "keep-alive",
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.BEAM_TOKEN}`,
      },
      json: payload,
    })
    .json();
};

export const callPython = async <P, R extends unknown = any>(
  procedure: string,
  payload: P,
) => {
  return await callBeamEndpoint<{ procedure: string; payload: P }, R>(
    "raphgpt",
    {
      procedure,
      payload,
    },
  );
};
