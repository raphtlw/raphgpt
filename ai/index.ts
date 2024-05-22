import { code, fmt, underline } from "@grammyjs/parse-mode";
import { HyperStore } from "ai/hyper";
import fs from "fs";
import { Api } from "grammy";
import OpenAI from "openai";
import { Env } from "secrets/env";
import { encoding_for_model } from "tiktoken";
import { inspect } from "util";

export const openai = new OpenAI({ apiKey: Env.OPENAI_API_KEY });

export class DraftMessage {
  constructor(
    private contents: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [],
  ) {}

  add(content: OpenAI.Chat.Completions.ChatCompletionContentPart) {
    this.contents.push(content);
  }

  pop() {
    return this.contents.pop();
  }

  get(): OpenAI.Chat.Completions.ChatCompletionUserMessageParam {
    return {
      role: "user",
      content: this.contents,
    };
  }

  clear() {
    this.contents.length = 0;
  }
}

export type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export const combineMessageContent = (message: MessageParam) => {
  if (typeof message.content === "string") {
    return message.content;
  } else if (Array.isArray(message.content)) {
    const content: string[] = [];
    for (const part of message.content) {
      if (part.type === "text") {
        content.push(part.text);
      }
      if (part.type === "image_url") {
        content.push(`image_url: ${part.image_url.url}`);
      }
    }
    return content.join(String.fromCharCode(32));
  } else {
    return null;
  }
};

export class Conversation {
  constructor(private messages: MessageParam[] = []) {}

  validate() {
    for (let i = 1; i < this.messages.length; i++) {
      const current = this.messages[i];
      const previous = this.messages[i - 1];
      if ("tool_calls" in previous && previous.tool_calls) {
        if (current.role !== "tool") {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Append a prompt to the end of the context
   */
  add(message: MessageParam) {
    this.messages.push(message);
  }

  /**
   * Insert a prompt to the beginning of a section of
   * messages with the same role.
   */
  insert(message: MessageParam) {
    const messageRoleIdx = this.messages.findIndex(
      (msg) => msg.role === message.role,
    );
    if (messageRoleIdx >= 0) {
      this.messages.splice(messageRoleIdx, 0, message);
    } else {
      this.messages.unshift(message);
    }
  }

  /**
   * Append a prompt to the end of a section of
   * messages with the same role
   */
  append(message: MessageParam) {
    const messageRoleIdx = this.messages.findLastIndex(
      (msg) => msg.role === message.role,
    );
    if (messageRoleIdx >= 0) {
      this.messages.splice(messageRoleIdx + 1, 0, message);
    } else {
      this.messages.unshift(message);
    }
  }

  peek() {
    return this.messages[this.messages.length - 1];
  }

  pop() {
    return this.messages.pop();
  }

  get() {
    return this.messages;
  }

  takeLast(n = 1) {
    return new Conversation(n === 0 ? [] : this.messages.slice(-n));
  }
}

export const runModel = async <Context>(
  history: Conversation,
  current: Conversation,
  context: Context,
  functions: HyperStore<Context>,
  model: OpenAI.Chat.Completions.ChatCompletionCreateParams["model"] = "gpt-4o",
) => {
  let completion: OpenAI.Chat.Completions.ChatCompletion | null = null;
  let tries = 0;

  do {
    completion = await openai.chat.completions
      .create({
        max_tokens: 4096,
        messages: [...history.get(), ...current.get()],
        model,
        tool_choice: "auto",
        tools: functions.asTools(),
      })
      .catch(() =>
        openai.chat.completions.create({
          max_tokens: 4096,
          messages: [...current.get()],
          model,
          tool_choice: "auto",
          tools: functions.asTools(),
        }),
      );
    tries++;
  } while (!completion && tries < 3);

  const tg = new Api(Env.TELEGRAM_API_KEY);
  const botUpdatesCompletionNotification = fmt([
    underline("OpenAI Completion"),
    "\n",
    "Usage: ",
    code(
      completion.usage
        ? JSON.stringify(completion.usage, undefined, 2)
        : "NONE SPECIFIED",
    ),
    "\n",
    "System Fingerprint: ",
    code(completion.system_fingerprint ?? "NONE SPECIFIED"),
    "\n",
    "Model: ",
    code(completion.model),
  ]);
  await tg.sendMessage(
    Env.TELEGRAM_BOT_UPDATES_CHAT_ID,
    botUpdatesCompletionNotification.text,
    {
      entities: botUpdatesCompletionNotification.entities,
    },
  );

  const chosen = completion.choices[0];

  console.log("Model response", inspect(chosen.message, true, 10, true));

  current.add(chosen.message);

  if (chosen.message.tool_calls) {
    for (const toolCall of chosen.message.tool_calls) {
      let content = "";

      try {
        // get response from function call
        const response = await functions.callTool(toolCall, context);

        console.log(
          "Result from function call",
          toolCall,
          `\nResult ${inspect(response, true, 10, true)}`,
        );

        if (typeof response === "string") {
          content = response;
        } else if (Array.isArray(response)) {
          if (response.length > 0) {
            content = response.map((o) => JSON.stringify(o)).join("\n");
          } else {
            content = "No response found.";
          }
        } else {
          content = JSON.stringify(response) ?? "No response found.";
        }
      } catch (e) {
        console.error("Error from function call", toolCall, e);
        const error = JSON.parse(JSON.stringify(e));
        content = error.message || error.msg || "Unknown error";
      }

      // limit content length to fit context size for model
      const encoder = encoding_for_model("gpt-4o");
      const encoded = encoder.encode(content);
      const truncatedToFitModelContextLength = encoded.slice(
        0,
        Env.FUNCTION_CALL_TOKEN_THRESHOLD,
      );
      const truncated = new TextDecoder().decode(
        encoder.decode(truncatedToFitModelContextLength),
      );
      // free up memory
      encoder.free();

      console.log("Truncated:", truncated);

      current.add({
        tool_call_id: toolCall.id,
        role: "tool",
        content: truncated,
      });
    }
  }

  return [chosen.message, chosen.message.tool_calls !== undefined] as const;
};

export const transcribeAudio = async (filePath: string) => {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "whisper-1",
    language: "en",
  });

  console.log("Transcription of voice message by OpenAI:", transcription.text);

  return transcription.text;
};

export const describeVideo = async (
  transcription: string,
  frames: string[],
) => {
  const completion = await openai.chat.completions.create({
    max_tokens: 2048,
    messages: [
      {
        content: [
          {
            text: "The image shows video frames in sequence. Describe what's likely going on in each frame.",
            type: "text",
          },
          {
            text: `You can hear following in the audio track: ${transcription}`,
            type: "text",
          },
          {
            text: "Also mention what you can hear in the audio.",
            type: "text",
          },
          ...frames.map(
            (frameData) =>
              ({
                image_url: {
                  url: `data:image/jpeg;base64,${frameData}`,
                },
                type: "image_url",
              }) as OpenAI.Chat.Completions.ChatCompletionContentPartImage,
          ),
        ],
        role: "user",
      },
    ],
    model: "gpt-4-turbo",
  });
  console.log("Completion:", inspect(completion.choices, true, 10, true));

  return completion.choices[0].message.content;
};
