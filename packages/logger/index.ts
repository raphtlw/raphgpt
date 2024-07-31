import { pino } from "pino";
import type { LokiOptions } from "pino-loki";
import type { PrettyOptions } from "pino-pretty";

export const createLogger = (service: string) => {
  return pino(
    { level: "trace" },
    pino.transport<{ destination: 1 | string } | PrettyOptions | LokiOptions>({
      level: "trace",
      targets: [
        {
          level: "trace",
          target: "pino-pretty",
          options: {
            colorize: true,
          },
        },
        {
          level: "trace",
          target: "pino-loki",
          options: {
            batching: true,
            interval: 5,

            host: process.env.GRAFANA_HOST!,
            basicAuth: {
              username: process.env.GRAFANA_USERNAME!,
              password: process.env.GRAFANA_TOKEN!,
            },

            labels: { application: "raphGPT", service },
          },
        },
      ],
    }),
  );
};
