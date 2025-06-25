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
        ctx.session.mediaGroupMsgs = [];
      }

      // buffer this incoming msg
      ctx.session.mediaGroupMsgs!.push(ctx.msg);

      // debounce 500ms since last media in this group
      clearTimeout(ctx.session.mediaGroupTimer!);
      ctx.session.mediaGroupTimer = setTimeout(async () => {
        const buffered = ctx.session.mediaGroupMsgs!;
        let mergedSend: UserContent = [];
        let mergedRemind: string[] = [];

        // for each media message, extract its UserContent + any system hints
        for (const msg of buffered) {
          const [toSend, reminding] = await processTelegramMessage(ctx, msg);
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
        ctx.session.mediaGroupMsgs = undefined;
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

      const toSend: UserContent = [];
      const remindingSystemPrompt: string[] = [];

      if (ctx.msg.reply_to_message) {
        const [replyTo, replyToSystemContent] = await processTelegramMessage(
          ctx,
          ctx.msg.reply_to_message,
        );
        console.log(
          "Replied-to message contents:",
          replyTo,
          replyToSystemContent,
        );
        toSend.push(...replyTo);
        remindingSystemPrompt.push(...replyToSystemContent);
      }
      const [messageContent, messageSystemContent] =
        await processTelegramMessage(ctx, ctx.msg);
      console.log("Message contents:", messageContent, messageSystemContent);
      toSend.push(...messageContent);
      remindingSystemPrompt.push(...messageSystemContent);

      await redis.RPUSH(
        `pending_requests:${ctx.chatId}:${userId}`,
        SuperJSON.stringify(toSend),
      );

      await gatherAndRunLLM(ctx, toSend, remindingSystemPrompt);

      await next();
    },
  );
