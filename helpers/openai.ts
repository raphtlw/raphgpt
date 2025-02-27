import logger from "@/bot/logger";
import { createOpenAI } from "@ai-sdk/openai";
import {
  CoreMessage,
  generateText,
  GenerateTextOnStepFinishCallback,
  GenerateTextResult,
  IDGenerator,
  JSONValue,
  LanguageModel,
  LanguageModelResponseMetadata,
  LanguageModelUsage,
  LanguageModelV1CallOptions,
  Message,
  Output,
  ProviderMetadata,
  TelemetrySettings,
  ToolCallRepairFunction,
  ToolChoice,
  ToolSet,
} from "ai";
import assert from "assert";
import OpenAI from "openai";
import { inspect } from "util";

type CallSettings = {
  /**
Maximum number of tokens to generate.
   */
  maxTokens?: number;
  /**
Temperature setting. This is a number between 0 (almost no randomness) and
1 (very random).

It is recommended to set either `temperature` or `topP`, but not both.

@default 0
   */
  temperature?: number;
  /**
Nucleus sampling. This is a number between 0 and 1.

E.g. 0.1 would mean that only tokens with the top 10% probability mass
are considered.

It is recommended to set either `temperature` or `topP`, but not both.
   */
  topP?: number;
  /**
Only sample from the top K options for each subsequent token.

Used to remove "long tail" low probability responses.
Recommended for advanced use cases only. You usually only need to use temperature.
   */
  topK?: number;
  /**
Presence penalty setting. It affects the likelihood of the model to
repeat information that is already in the prompt.

The presence penalty is a number between -1 (increase repetition)
and 1 (maximum penalty, decrease repetition). 0 means no penalty.
   */
  presencePenalty?: number;
  /**
Frequency penalty setting. It affects the likelihood of the model
to repeatedly use the same words or phrases.

The frequency penalty is a number between -1 (increase repetition)
and 1 (maximum penalty, decrease repetition). 0 means no penalty.
   */
  frequencyPenalty?: number;
  /**
Stop sequences.
If set, the model will stop generating text when one of the stop sequences is generated.
Providers may have limits on the number of stop sequences.
   */
  stopSequences?: string[];
  /**
The seed (integer) to use for random sampling. If set and supported
by the model, calls will generate deterministic results.
   */
  seed?: number;
  /**
Maximum number of retries. Set to 0 to disable retries.

@default 2
   */
  maxRetries?: number;
  /**
Abort signal.
   */
  abortSignal?: AbortSignal;
  /**
Additional HTTP headers to be sent with the request.
Only applicable for HTTP-based providers.
   */
  headers?: Record<string, string | undefined>;
};

/**
Prompt part of the AI function options.
It contains a system message, a simple text prompt, or a list of messages.
 */
type Prompt = {
  /**
System message to include in the prompt. Can be used with `prompt` or `messages`.
   */
  system?: string;
  /**
A simple text prompt. You can either use `prompt` or `messages` but not both.
 */
  prompt?: string;
  /**
A list of messages. You can either use `prompt` or `messages` but not both.
   */
  messages?: Array<CoreMessage> | Array<Omit<Message, "id">>;
};

interface Output<OUTPUT, PARTIAL> {
  readonly type: "object" | "text";
  injectIntoSystemPrompt(options: {
    system: string | undefined;
    model: LanguageModel;
  }): string | undefined;
  responseFormat: (options: {
    model: LanguageModel;
  }) => LanguageModelV1CallOptions["responseFormat"];
  parsePartial(options: { text: string }):
    | {
        partial: PARTIAL;
      }
    | undefined;
  parseOutput(
    options: {
      text: string;
    },
    context: {
      response: LanguageModelResponseMetadata;
      usage: LanguageModelUsage;
    },
  ): OUTPUT;
}

export type GenerateTextParams<
  TOOLS extends ToolSet,
  OUTPUT = never,
  OUTPUT_PARTIAL = never,
> = CallSettings &
  Prompt & {
    /**
The language model to use.
 */
    model: LanguageModel;
    /**
The tools that the model can call. The model needs to support calling tools.
*/
    tools?: TOOLS;
    /**
The tool choice strategy. Default: 'auto'.
 */
    toolChoice?: ToolChoice<TOOLS>;
    /**
Maximum number of sequential LLM calls (steps), e.g. when you use tool calls. Must be at least 1.

A maximum number is required to prevent infinite loops in the case of misconfigured tools.

By default, it's set to 1, which means that only a single LLM call is made.
 */
    maxSteps?: number;
    /**
Generate a unique ID for each message.
 */
    experimental_generateMessageId?: IDGenerator;
    /**
When enabled, the model will perform additional steps if the finish reason is "length" (experimental).

By default, it's set to false.
 */
    experimental_continueSteps?: boolean;
    /**
Optional telemetry configuration (experimental).
 */
    experimental_telemetry?: TelemetrySettings;
    /**
Additional provider-specific options. They are passed through
to the provider from the AI SDK and enable provider-specific
functionality that can be fully encapsulated in the provider.
*/
    providerOptions?: Record<string, Record<string, JSONValue>>;
    /**
@deprecated Use `providerOptions` instead.
 */
    experimental_providerMetadata?: ProviderMetadata;
    /**
Limits the tools that are available for the model to call without
changing the tool call and result types in the result.
 */
    experimental_activeTools?: Array<keyof TOOLS>;
    /**
Optional specification for parsing structured outputs from the LLM response.
 */
    experimental_output?: Output<OUTPUT, OUTPUT_PARTIAL>;
    /**
A function that attempts to repair a tool call that failed to parse.
 */
    experimental_repairToolCall?: ToolCallRepairFunction<TOOLS>;
    /**
Callback that is called when each step (LLM call) is finished, including intermediate steps.
*/
    onStepFinish?: GenerateTextOnStepFinishCallback<TOOLS>;
    /**
     * Internal. For test use only. May change without notice.
     */
    _internal?: {
      generateId?: IDGenerator;
      currentDate?: () => Date;
    };
  };

export const generateAudio = async <
  TOOLS extends ToolSet,
  OUTPUT = never,
  OUTPUT_PARTIAL = never,
>(
  args: Omit<GenerateTextParams<TOOLS, OUTPUT, OUTPUT_PARTIAL>, "model">,
): Promise<
  GenerateTextResult<TOOLS, OUTPUT> & {
    audio: OpenAI.Chat.Completions.ChatCompletionAudio | null;
  }
> => {
  let rawOutput: string | undefined;

  const customFetch: typeof globalThis.fetch = async (url, options) => {
    logger.debug(url, "Requesting URL");

    if (options) {
      const { body, ...rest } = options;
      logger.debug(rest, "Options");

      if (typeof body === "string") {
        const openaiBody = JSON.parse(body);
        logger.debug(`Body: ${inspect(openaiBody, true, 10, true)}`);

        options.body = JSON.stringify({
          ...openaiBody,
          modalities: ["text", "audio"],
          audio: { voice: "alloy", format: "mp3" },
        });

        logger.debug(options.body);
      }
    }

    try {
      const response = await fetch(url, options);
      rawOutput = await response.clone().text();

      logger.debug(rawOutput, "Raw OpenAI model output");

      return response;
    } catch (error) {
      console.error("Fetch error:", error);
      throw error;
    }
  };

  // Inject custom fetch into OpenAI model
  const openaiAudio = createOpenAI({
    compatibility: "compatible",
    fetch: customFetch,
    name: "openai",
  });

  const generateResult = await generateText({
    ...args,
    model: openaiAudio("gpt-4o-audio-preview"),
  });

  assert(rawOutput, "OpenAI output required at this stage!");

  const rawJson: OpenAI.Chat.Completions.ChatCompletion = JSON.parse(rawOutput);
  const audio = rawJson.choices[0].message.audio ?? null;

  return { ...generateResult, audio };
};
