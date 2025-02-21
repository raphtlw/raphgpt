import { pino } from "pino";
import type { LokiOptions } from "pino-loki";
import type { PrettyOptions } from "pino-pretty";
import { getEnv } from "@/helpers/env.js";
import { PRODUCTION } from "@/bot/constants.js";

export default pino(
  { level: "trace" },
  pino.transport<{ destination: 1 | string } | PrettyOptions | LokiOptions>({
    level: "trace",
    targets: [
      ...(PRODUCTION
        ? []
        : [
            {
              level: "trace",
              target: "pino-pretty",
              options: {
                colorize: true,
              },
            },
          ]),
      {
        level: "trace",
        target: "pino-loki",
        options: {
          batching: true,
          interval: 5,

          host: getEnv("GRAFANA_HOST"),
          basicAuth: {
            username: getEnv("GRAFANA_USERNAME"),
            password: getEnv("GRAFANA_TOKEN"),
          },

          labels: {
            application: "raphGPT",
            service: "telegram-bot",
            environment: getEnv("NODE_ENV"),
          },
        },
      },
    ],
  }),
);
