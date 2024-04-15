import { code, fmt, underline } from "@grammyjs/parse-mode";
import { functions } from "ai/functions";
import fs from "fs";
import { Api } from "grammy";
import OpenAI from "openai";
import { Env } from "secrets/env";
import { inspect } from "util";

const openai = new OpenAI({ apiKey: Env.OPENAI_API_KEY });

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

export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export const message = (inner: Message) => ({
  getCombinedContent() {
    if (typeof inner.content === "string") {
      return inner.content;
    } else if (Array.isArray(inner.content)) {
      const content: string[] = [];
      for (const part of inner.content) {
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
  },
});

export class Conversation {
  constructor(private messages: Message[] = []) {}

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

  add(message: Message) {
    this.messages.push(message);
  }

  addSystem(...prompt: string[]) {
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i].role === "system") {
        this.messages.splice(i + 1, 0, {
          role: "system",
          content: prompt.join("\n"),
        });
      }
    }
  }

  addUserInstructions(...prompt: string[]) {
    this.messages.push({
      role: "user",
      content: prompt.join("\n"),
    });
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

export const runModel = async (
  history: Conversation,
  current: Conversation,
) => {
  const prompt = current.peek();
  const promptContent = message(prompt).getCombinedContent();

  const completion = await openai.chat.completions.create({
    max_tokens: 4096,
    messages: [...history.get(), ...current.get()],
    model: "gpt-3.5-turbo-0125",
    tool_choice: "auto",
    tools: functions.asTools(),
  });

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
        const response = await functions.callTool(toolCall);

        console.log(
          "Result from function call",
          toolCall,
          `\nResult ${inspect(response, true, 10, true)}`,
        );

        if (response) {
          if (typeof response === "string") {
            content = response;
          } else {
            // if response is JSON-encoded, simplify it (to cut down token usage)
            // summarize function response data
            const completion = await openai.chat.completions.create({
              messages: [
                {
                  role: "system",
                  content:
                    "You are a JSON simplifier for GPT function calls, retain the most information as much as possible.",
                },
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: `Original question: ${promptContent}`,
                    },
                    {
                      type: "text",
                      text: "Simplify the JSON object below to better answer the original question",
                    },
                    {
                      type: "text",
                      text: JSON.stringify(response),
                    },
                  ],
                },
              ],
              model: "gpt-3.5-turbo-0125",
              response_format: { type: "json_object" },
            });
            content = completion.choices[0].message.content!;
          }
        }
      } catch (e) {
        console.error(e);
        content = JSON.stringify(e);
      }

      current.add({
        tool_call_id: toolCall.id,
        role: "tool",
        content,
      });
    }
  }

  return [chosen.message, current.peek()] as const;
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
    model: "gpt-4-vision-preview",
  });
  console.log("Completion:", inspect(completion.choices, true, 10, true));

  return completion.choices[0].message.content;
};
