import { LOCAL_FILES_DIR } from "@/bot/constants";
import logger from "@/bot/logger.js";
import { telegram } from "@/bot/telegram";
import { chroma } from "@/db/chroma";
import { getEnv } from "@/helpers/env";
import type { ToolData } from "@/helpers/function";
import { openai } from "@ai-sdk/openai";
import { resolve } from "@bonfida/spl-name-service";
import { createId } from "@paralleldrive/cuid2";
import {
  clusterApiUrl,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import {
  generateObject,
  generateText,
  type ImagePart,
  type Tool,
  tool,
} from "ai";
import { AnkiApkgBuilderFactory } from "anki-apkg-builder";
import assert from "assert";
import { Collection, DefaultEmbeddingFunction } from "chromadb";
import { format } from "date-fns";
import { InputFile } from "grammy";
import path from "path";
import pdf2pic from "pdf2pic";
import type { BufferResponse } from "pdf2pic/dist/types/convertResponse";
import { inspect } from "util";
import { z } from "zod";

export const toolbox = async (data: ToolData, query: string | string[]) => {
  const embeddingFunction = new DefaultEmbeddingFunction();

  const tools = {
    wallet_explorer: tool({
      description:
        "Explore the Solana blockchain, using wallet addresses or transaction signatures",
      parameters: z.object({
        walletAddressOrSignature: z.string(),
        instruction: z
          .string()
          .describe(
            "Natural language instruction describing what you want from the address or signature",
          ),
      }),
      async execute({ walletAddressOrSignature, instruction }) {
        const connection = new Connection(clusterApiUrl("mainnet-beta"));

        const { text: result, steps } = await generateText({
          model: openai("o3-mini", {
            structuredOutputs: false,
            reasoningEffort: "medium",
          }),
          system: `You are a Solana blockchain investigator. Current time in UTC: ${format(new Date(), "EEEE, yyyy-MM-dd 'at' HH:mm:ss zzz (XXX)")}. Always use get_sol_signatures before assuming there are no transactions associated with a specific wallet.`,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: instruction,
                },
                {
                  type: "text",
                  text: `Use the following parameter: ${walletAddressOrSignature}`,
                },
              ],
            },
          ],
          tools: {
            resolve_sol_domain: tool({
              parameters: z.object({
                domain: z.string().describe("Bonfida domain ending in .sol"),
              }),
              async execute({ domain }) {
                const owner = await resolve(connection, domain);
                return owner.toBase58();
              },
            }),

            get_account_info: tool({
              parameters: z.object({
                walletAddress: z.string(),
              }),
              async execute({ walletAddress }) {
                return await connection.getAccountInfoAndContext(
                  new PublicKey(walletAddress),
                );
              },
            }),

            get_sol_signatures: tool({
              description: "Get all signatures for wallet address",
              parameters: z.object({
                walletAddress: z.string(),
              }),
              async execute({ walletAddress }) {
                const signatures = await connection.getSignaturesForAddress(
                  new PublicKey(walletAddress),
                );

                logger.debug(signatures, "Confirmed signatures");

                const formatted: string[] = [];

                for (const sig of signatures) {
                  const txDetails: string[] = [];

                  txDetails.push(
                    `timestamp: ${format(new Date(), "EEEE, yyyy-MM-dd 'at' HH:mm:ss zzz (XXX)")}`,
                  );
                  txDetails.push(`sig: ${sig.signature}`);
                  txDetails.push(`memo: ${sig.memo}`);
                  txDetails.push(`error: ${inspect(sig.err)}`);

                  formatted.push(txDetails.join(","));
                }

                return formatted.join("\n");
              },
            }),

            get_sol_tx: tool({
              description: "Get transaction by signature",
              parameters: z.object({
                sig: z.string(),
              }),
              async execute({ sig }) {
                const transaction = await connection.getParsedTransaction(sig, {
                  commitment: "confirmed",
                  maxSupportedTransactionVersion: 0,
                });
                assert(transaction, "Transaction not found");

                const formatted: string[] = [];
                const txDetails: string[] = [];

                txDetails.push(
                  `timestamp: ${format(new Date(), "EEEE, yyyy-MM-dd 'at' HH:mm:ss zzz (XXX)")}`,
                );
                txDetails.push(`data: ${inspect(transaction.meta)}`);

                formatted.push(txDetails.join(","));

                return formatted.join("\n");
              },
            }),

            lamports_to_sol: tool({
              description: "Calculate lamports to sol",
              parameters: z.object({
                lamports: z.number(),
              }),
              async execute({ lamports }) {
                return lamports / LAMPORTS_PER_SOL;
              },
            }),
          },
          maxSteps: 5,
        });

        logger.debug(steps, "Wallet explorer resulting steps");
        logger.debug(result);

        return `${result} do not leave out any information when showing this data to the user.`;
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
        const res: any = await fetch(
          `https://customsearch.googleapis.com/customsearch/v1?` + params,
        ).then((res) => res.json());
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
            await fetch(results[i]!.link).then((res) =>
              Bun.write(localPath, res),
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
      documents: Object.entries(tools).map(([name, tool]) => {
        const fullText = [];
        fullText.push(name);
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

  logger.debug(toUse, "Matching tools");

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
