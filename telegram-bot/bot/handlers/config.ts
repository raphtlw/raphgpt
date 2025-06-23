import { b, code, fmt, u } from "@grammyjs/parse-mode";
import type { BotContext } from "bot";
import { configSchema } from "bot/config";
import { redis } from "connections/redis";
import { Composer } from "grammy";
import { getEnv } from "utils/env";

export const configHandler = new Composer<BotContext>();

configHandler.command("set", async (ctx) => {
  if (!ctx.from) throw new Error("ctx.from not found");
  const cmd = ctx.msg.text.split(" ");

  const key = cmd[1];
  const value = cmd[2];

  if (!key) {
    const settingsMessage = fmt`${u}${b}[HELP]${b}${u}
Available settings:
${(Object.keys(configSchema.shape) as Array<keyof typeof configSchema.shape>)
  .map((key) => `- ${key} - ${configSchema.shape[key].description}`)
  .join("\n")}
`;

    await ctx.reply(settingsMessage.text, {
      entities: settingsMessage.entities,
    });

    const specifyKeyMessage = fmt`Please specify key to set.
Available options:
${Object.keys(configSchema.shape).join(", ")}
`;

    return await ctx.reply(specifyKeyMessage.text, {
      entities: specifyKeyMessage.entities,
    });
  }

  if (!value) {
    return await ctx.reply("Please specify value.");
  }

  configSchema.partial().parse({ [key]: value });

  await redis.HSET(`config:${ctx.from.id}`, key, value);

  return await ctx.reply(`Successfully set ${key} to ${value}`);
});

configHandler.command("config", async (ctx) => {
  if (!ctx.from) throw new Error("ctx.from not found");

  const result = await redis.HGETALL(`config:${ctx.from.id}`);

  const settingsMessage = fmt`Settings ${code}${JSON.stringify(
    result,
    undefined,
    4,
  )}${code}`;
  await ctx.reply(settingsMessage.text, {
    entities: settingsMessage.entities,
    reply_parameters: {
      message_id: ctx.msgId,
      allow_sending_without_reply: true,
    },
  });
});

configHandler.on("message:location", async (ctx, next) => {
  if (!ctx.from) throw new Error("ctx.from not found");

  const { latitude, longitude } = ctx.message.location;
  const timestamp = Math.floor(Date.now() / 1000);
  const googleKey = getEnv("GOOGLE_API_KEY");

  // Call the Google Timezone API
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/timezone/json` +
      `?location=${latitude},${longitude}` +
      `&timestamp=${timestamp}` +
      `&key=${googleKey}`,
  );

  if (!res.ok) {
    console.error(`Timezone API error ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as {
    status: string;
    timeZoneId?: string;
    errorMessage?: string;
  };
  if (json.status !== "OK" || !json.timeZoneId) {
    console.error(`Timezone API returned ${json.status}: ${json.errorMessage}`);
    await ctx.reply(
      "❌ Could not determine your time zone from that location.",
    );
    return await next();
  }

  const tzId = json.timeZoneId;

  // Validate against our config schema (optional)
  configSchema.pick({ timezone: true }).parse({ timezone: tzId });

  // Store in Redis under the same hash that /set uses
  await redis.HSET(`config:${ctx.from.id}`, "timezone", tzId);

  // Notify user
  await ctx.reply(`✅ Your time zone has been set to: ${tzId}`);

  // Continue execution, with message handler.
  await next();
});
