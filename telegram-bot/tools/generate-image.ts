import { tool } from "ai";
import { createAgent } from "bot/agents";
import { telegram } from "bot/telegram";
import { replicate } from "connections/replicate";
import { z } from "zod";

/**
 * generateImage: an agent that resolves a Replicate model/version,
 * runs a prediction via Replicate, and sends the image to Telegram.
 */
export const generateImage = createAgent({
  name: "generate_image_agent",
  description: "Generate images via the official 'google/imagen-4' model on Replicate and send results to Telegram.",
  parameters: z.object({
    prompt: z.string().describe("Text prompt for image generation"),
    model: z
      .string()
      .optional()
      .describe("Optional model identifier, e.g. 'google/imagen-4' or with ':version'."),
    aspect_ratio: z
      .string()
      .optional()
      .describe("Optional aspect ratio, e.g. '16:9', '4:3'."),
  }),
  system: `You are the image-generation sub-agent using the Replicate API.
Use these operations to generate an image:
- models.list(): list public models
- models.search(query): search models by name
- models.versions.list(owner, model): list versions of a model
- predictions.create: create a prediction (use Prefer: wait for sync)
- predictions.get: poll a prediction until status is 'succeeded'
- send_telegram_image: send the final image URL via Telegram

Follow these steps:
1. If 'model' is missing, default to the official 'google/imagen-4' model.
2. Call models.versions.list to get versions; select the latest if no version provided.
3. Call predictions.create with the chosen version and prompt (include aspect_ratio if given).
4. If predictions.create returns status 'starting', loop with predictions.get until 'succeeded'.
5. Take the output URL from the prediction and call send_telegram_image.
Return only valid tool calls in JSON, no extra text.
`,
  createTools: (toolData) => ({
    models_list: tool({
      description: "List public models available on Replicate.",
      parameters: z.object({}),
      async execute() {
        try {
          const res = await replicate.models.list();
          return res.results.map((m: any) => m.id);
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      },
    }),

    models_search: tool({
      description: "Search public models by a query string.",
      parameters: z.object({ query: z.string().describe("Search term for models") }),
      async execute({ query }) {
        try {
          const res = await replicate.models.search(query);
          return res.results.map((m: any) => m.id);
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      },
    }),

    list_model_versions: tool({
      description: "List version IDs for a given model identifier 'owner/model'.",
      parameters: z.object({ model: z.string().describe("Model identifier 'owner/model'") }),
      async execute(params: any) {
        try {
          const modelId = params.model;
          if (!modelId) {
            return "Error: missing model identifier";
          }
          const [owner, name] = (modelId as string).split('/');
          if (!owner || !name) {
            return "Error: invalid model identifier";
          }
          const raw = (await replicate.models.versions.list(owner, name)) as any;
          const entries = Array.isArray(raw) ? raw : raw.results;
          return entries.map((v: any) => v.id);
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      },
    }),

    create_prediction: tool({
      description: "Create a Replicate prediction; returns the prediction object.",
      parameters: z.object({
        version: z.string().describe("Full model version ID or 'owner/model:version'"),
        input: z.any().describe("Input object for the prediction, matching version schema"),
      }),
      async execute({ version, input }) {
        try {
          const pred = await replicate.predictions.create({ version, input, wait: true });
          return pred;
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      },
    }),

    get_prediction: tool({
      description: "Get the status/output of an existing prediction by ID.",
      parameters: z.object({ id: z.string().describe("Prediction ID to poll") }),
      async execute({ id }) {
        try {
          return await replicate.predictions.get(id);
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      },
    }),

    send_telegram_image: tool({
      description: "Send the generated image URL to the user via Telegram.",
      parameters: z.object({ url: z.string().describe("HTTPS URL of the image to send") }),
      async execute({ url }) {
        await telegram.sendPhoto(toolData.ctx.chatId!, url, {
          reply_parameters: {
            message_id: toolData.ctx.msgId!,
            allow_sending_without_reply: true,
          },
        });
        return 'ok';
      },
    }),
  }),
});
