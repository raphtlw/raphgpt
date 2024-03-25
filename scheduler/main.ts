import Bree from "bree";
import Fastify from "fastify";
import { Api } from "grammy";
import { Env } from "secrets/env";

const fastify = Fastify({
  logger: true,
});
