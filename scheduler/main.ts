import Fastify from "fastify";
import { Api } from "grammy";
import { Env } from "../bot/env";
import Bree from "bree";

const fastify = Fastify({
  logger: true,
});
