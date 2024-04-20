import { code, fmt, underline } from "@grammyjs/parse-mode";
import { ind } from "@raphtlw/indoc";
import { HyperStore } from "ai/hyper";
import assert from "assert";
import fs from "fs";
import { Api } from "grammy";
import OpenAI from "openai";
import { Env } from "secrets/env";
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
  model: OpenAI.Chat.Completions.ChatCompletionCreateParams["model"] = "gpt-3.5-turbo-0125",
) => {
  const prompt = current.pop();
  assert(prompt, "No new messages added to current conversation context");

  if (prompt.role === "user") {
    let improvedDraftPrompt: string | null;
    do {
      const completion = await openai.chat.completions.create({
        messages: [
          {
            role: "system",
            content: ind(
              `You are RaphGPT, a professional and experienced prompt engineer.`,
            ),
          },
          ...history.get(),
          {
            role: "user",
            content: ind(`
            Act as a professional and experienced prompt engineer for RaphGPT. The prompt engineer should strive to expand on as many unknown details of the prompt as much as possible, to give RaphGPT a better idea of what the user might additionally need. The prompt should be as detailed and comprehensive as possible, to ensure brevity and clarity for RaphGPT to understand.

            Do not ask the user any question, just respond with the prompt and the prompt only.

            Example of a good prompt created by a prompt engineer:
            "The wishes to scan a receipt and produce a detailed copy of the receipt to be used for bill splitting purposes. When splitting the bill, you should use the functions provided to perform arithmetic operations to ensure the reliability of your calculations. You should also provide elaborate details on the calculations you made and reasoning behind them. In addition, please list the arithmetic operations beside the results of the arithmetic operation."`),
          },
          { role: "assistant", content: "Understood." },
          {
            role: "user",
            content:
              ind(`Expand on the following prompt: ${combineMessageContent(prompt)}
          `),
          },
        ],
        model: "gpt-3.5-turbo",
      });
      improvedDraftPrompt = completion.choices[0].message.content;
    } while (!improvedDraftPrompt);
    console.log("Improved prompt:", improvedDraftPrompt);
    current.add({
      role: "user",
      content: [
        { type: "text", text: improvedDraftPrompt },
        { type: "text", text: combineMessageContent(prompt)! },
      ],
    });
  } else {
    current.add(prompt);
  }

  const completion = await openai.chat.completions.create({
    max_tokens: 4096,
    messages: [...history.get(), ...current.get()],
    model,
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
        const response = await functions.callTool(toolCall, context);

        console.log(
          "Result from function call",
          toolCall,
          `\nResult ${inspect(response, true, 10, true)}`,
        );

        content = JSON.stringify(response);
      } catch (e) {
        console.error("Error from function call", toolCall, e);
        content = JSON.stringify(e);
      }

      current.add({
        tool_call_id: toolCall.id,
        role: "tool",
        content,
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
