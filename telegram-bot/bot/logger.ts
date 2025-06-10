import { pino } from "pino";
import type { PrettyOptions } from "pino-pretty";

export default pino(
  { level: "trace" },
  pino.transport<{ destination: 1 | string } | PrettyOptions>({
    level: "trace",
    targets: [
      {
        level: "trace",
        target: "pino-pretty",
        options: {
          colorize: true,
        },
      },
    ],
  }),
);
