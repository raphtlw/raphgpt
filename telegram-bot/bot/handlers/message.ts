import { fmt, i } from "@grammyjs/parse-mode";
import { type UserContent } from "ai";
import type { BotContext } from "bot";
import { NOTIFY_EDITS, NOTIFY_INTERRUPTIONS } from "bot/constants";
import { acceptPrivateOrWithPrefix } from "bot/filters";
import { gatherAndRunLLM, processTelegramMessage } from "bot/message";
import { redis } from "connections/redis";
import { Composer } from "grammy";
import SuperJSON from "superjson";

export const messageHandler = new Composer<BotContext>();

messageHandler
  .on("message:media")
  .filter(acceptPrivateOrWithPrefix)
  .filter(
    (ctx) => !!ctx.msg.media_group_id,
    async (ctx, next) => {
      const mgid = ctx.msg.media_group_id;

      // start a new group or reset if group‐id changed
      if (ctx.session.mediaGroupId !== mgid) {
        clearTimeout(ctx.session.mediaGroupTimer!);
        ctx.session.mediaGroupId = mgid;
        ctx.session.mediaGroupCtxs = [];
      }

      // buffer this incoming ctx
      ctx.session.mediaGroupCtxs!.push(ctx);

      // debounce 500ms since last media in this group
      clearTimeout(ctx.session.mediaGroupTimer!);
      ctx.session.mediaGroupTimer = setTimeout(async () => {
        const buffered = ctx.session.mediaGroupCtxs!;
        let mergedSend: UserContent = [];
        let mergedRemind: string[] = [];

        // for each media message, extract its UserContent + any system hints
        for (const c of buffered) {
          const [toSend, reminding] = await processTelegramMessage(c);
          mergedSend.push(...toSend);
          mergedRemind.push(...reminding);
        }

        ctx.session.task = new AbortController();

        // enqueue them all as one pending request
        await redis.RPUSH(
          `pending_requests:${ctx.chatId}:${ctx.from!.id}`,
          SuperJSON.stringify(mergedSend),
        );

        // now finally run your LLM pipeline on the grouped media
        await gatherAndRunLLM(ctx, mergedSend, mergedRemind);

        // clear buffers
        ctx.session.mediaGroupId = undefined;
        ctx.session.mediaGroupCtxs = undefined;
        ctx.session.mediaGroupTimer = undefined;

        await next();
      }, 500);
    },
  );

messageHandler
  .on(["message", "edit"])
  .filter(acceptPrivateOrWithPrefix)
  .filter(
    (ctx) => !ctx.msg.media_group_id,
    async (ctx, next) => {
      if (!ctx.from) throw new Error("ctx.from not found");
      if (!ctx.chatId) throw new Error("ctx.chatId not found");
      if (!ctx.msg) throw new Error("ctx.msg not found");

      const userId = ctx.from.id;
      const chatId = ctx.chatId;

      // Cancel the previous request if it exists
      if (ctx.session.task) {
        ctx.session.task.abort();

        if (NOTIFY_INTERRUPTIONS) {
          const interruptionNotification = fmt`${i}⏹️ Previous response interrupted. Processing new request...${i}`;
          await ctx.reply(interruptionNotification.text, {
            entities: interruptionNotification.entities,
          });
        }
      }

      if (ctx.editedMessage && NOTIFY_EDITS) {
        const editedMessageNotification = fmt`${i}👀 Noticed you edited a message. Revisiting it...${i}`;
        await ctx.reply(editedMessageNotification.text, {
          entities: editedMessageNotification.entities,
        });
      }

      ctx.session.task = new AbortController();

      const [toSend, remindingSystemPrompt] = await processTelegramMessage(ctx);

      await redis.RPUSH(
        `pending_requests:${ctx.chatId}:${userId}`,
        SuperJSON.stringify(toSend),
      );

      await gatherAndRunLLM(ctx, toSend, remindingSystemPrompt);

      await next();
    },
  );
