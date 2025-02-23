import { LOCAL_FILES_DIR } from "@/bot/constants";
import logger from "@/bot/logger.js";
import { telegram } from "@/bot/telegram";
import { chroma } from "@/db/chroma";
import { getEnv } from "@/helpers/env";
import { ToolData } from "@/helpers/function";
import { openai } from "@ai-sdk/openai";
import { createId } from "@paralleldrive/cuid2";
import { generateObject, generateText, ImagePart, Tool, tool } from "ai";
import { AnkiApkgBuilderFactory } from "anki-apkg-builder";
import { Collection, DefaultEmbeddingFunction } from "chromadb";
import fs from "fs";
import got from "got";
import { InputFile } from "grammy";
import path from "path";
import pdf2pic from "pdf2pic";
import { BufferResponse } from "pdf2pic/dist/types/convertResponse";
import { pipeline as streamPipeline } from "stream/promises";
import { z } from "zod";

export const toolbox = async (data: ToolData, query: string | string[]) => {
  const embeddingFunction = new DefaultEmbeddingFunction();

  const tools = {
    blockchain_data: tool({
      description: "Analyze the solana blockchain",
      parameters: z.object({}),
      async execute() {
        logger.debug("tool triggered");
        await telegram.sendMessage(data.chatId, "boom");

        return "ack";
      },
    }),

    create_anki_flashcards: tool({
      description:
        "Create a set of Anki flashcards using content freely available on the internet",
      parameters: z.object({
        contentTopic: z
          .string()
          .describe("Describe the flashcard's content in detail"),
        llmPrompt: z
          .string()
          .describe(
            "Prompt to be fed into another LLM giving it meta on cards, like how many cards to generate.",
          ),
      }),
      async execute({ contentTopic, llmPrompt }) {
        const { text: query } = await generateText({
          model: openai("gpt-4o-mini"),
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "I want to create a set of anki flashcards, but need to use content from the web.",
                },
                {
                  type: "text",
                  text: `Given the following topic: ${contentTopic}`,
                },
                {
                  type: "text",
                  text: "Give me an optimal search query to use in Google for the topic. Do not use any filters. Return only the query and nothing else. Your output will be piped into Google.",
                },
              ],
            },
          ],
        });

        const params = new URLSearchParams({
          cx: getEnv("GOOGLE_SEARCH_ENGINE_ID"),
          key: getEnv("GOOGLE_SEARCH_API_KEY"),
          q: query,
          fileType: "pdf",
        });
        const res = await got(
          `https://customsearch.googleapis.com/customsearch/v1?` + params,
        ).json<any>();
        logger.debug(res, "Google Search Response");

        const results: {
          title: string;
          link: string;
          snippet: string;
          content?: string;
        }[] = res.items.map(({ title, link, snippet }: any) => ({
          title,
          link,
          snippet,
        }));

        const pdfPages: BufferResponse[] = [];

        // get first 2 result contents
        for (let i = 0; i < 2; i++) {
          try {
            // Download file
            const localPath = path.join(LOCAL_FILES_DIR, createId());
            await streamPipeline(
              got.stream(results[i].link),
              fs.createWriteStream(localPath),
            );
            const pdfData = await pdf2pic.fromPath(localPath).bulk(-1, {
              responseType: "buffer",
            });

            pdfPages.push(...pdfData);
          } catch (e) {
            console.error(e);
          }
        }

        const { object: flashcard } = await generateObject({
          model: openai("gpt-4o"),
          schema: z.object({
            name: z.string(),
            filename: z.string(),
            noteType: z.object({
              id: z.number(),
              name: z.string(),
              css: z.string(),
              tmpls: z.array(
                z.object({
                  name: z.string(),
                  ord: z.number(),
                  qfmt: z.string(),
                  afmt: z.string(),
                  bqfmt: z.string(),
                  bafmt: z.string(),
                  did: z.null(),
                }),
              ),
              flds: z.array(
                z.object({
                  name: z.string(),
                  media: z.array(z.string()),
                  sticky: z.boolean(),
                  rtl: z.boolean(),
                  ord: z.number(),
                  font: z.string(),
                  size: z.number(),
                }),
              ),
            }),
            notes: z.array(
              z.object({
                fields: z.array(z.string()),
              }),
            ),
          }),
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Build a set of Anki (.apkg) flashcards on ${contentTopic}.`,
                },
                ...pdfPages.slice(0, 15).map<ImagePart>((page) => ({
                  type: "image",
                  image: page.buffer!,
                })),
                { type: "text", text: llmPrompt },
                {
                  type: "text",
                  text: "Output the content according to the JSON schema specified.",
                },
              ],
            },
          ],
        });
        logger.debug(flashcard, "Generated flashcard set");

        const builderFactory = new AnkiApkgBuilderFactory();
        const builder = await builderFactory.create();

        const deck = await builder.addDeck({
          name: flashcard.name,
          description: "This deck was generated by AI.",
        });

        const noteType = await builder.addNoteType({
          did: deck.id,
          ...flashcard.noteType,
        });

        for (const note of flashcard.notes) {
          const noteId = await builder.addNote({
            noteTypeId: noteType.id,
            ...note,
          });
          await builder.addCard({
            nid: noteId.id,
            did: deck.id,
            ord: 0,
          });
        }

        const outputPath = path.join(LOCAL_FILES_DIR, flashcard.filename);
        await builder.generateApkg(outputPath);

        const documentMessage = await telegram.sendDocument(
          data.chatId,
          new InputFile(outputPath),
        );

        return `Sent file to user: ${documentMessage.document}`;
      },
    }),
  };

  let toolCollection: Collection;

  try {
    toolCollection = await chroma.getCollection({
      name: "toolbox",
      embeddingFunction,
    });
  } catch {
    toolCollection = await chroma.createCollection({
      name: "toolbox",
      embeddingFunction,
    });
    await toolCollection.add({
      ids: Object.keys(tools),
      metadatas: Object.entries(tools).map(([name, tool]) => ({
        name,
        description: tool.description!,
      })),
      documents: Object.values(tools).map((tool) => {
        const fullText = [];
        fullText.push(tool.description);
        fullText.push(JSON.stringify(tool.parameters));
        return fullText.join(" ");
      }),
    });
  }

  const toUse = await toolCollection.query({
    queryTexts: Array.isArray(query) ? query : [query],
    include: ["metadatas"] as any,
  });

  // Ensure metadata exists and is structured properly
  if (!toUse.metadatas || !toUse.metadatas[0]) {
    logger.warn("No matching tools found.");
    return {};
  }

  const returnedTools: Record<string, Tool> = {};

  for (const matchedTool of toUse.metadatas[0]) {
    const toolName = matchedTool?.name as keyof typeof tools;
    if (toolName && toolName in tools) {
      returnedTools[toolName] = tools[toolName];
    }
  }

  return returnedTools;
};
