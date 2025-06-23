import { tool } from "ai";
import { createAgent } from "bot/agents";
import type { ToolData } from "bot/tool-data";
import { s3 } from "bun";
import path from "path";
import { fromBuffer, fromPath } from "pdf2pic";
import sharp from "sharp";
import { z } from "zod";

export const fileAgent = createAgent({
  name: "file_agent",
  description:
    "Retrieve files by S3 key and perform operations such as extracting text or images from PDF, converting DOCX, processing images, or reading plain text files.",
  parameters: z.object({
    key: z.string().describe("S3 object key/path of the file"),
    operation: z
      .string()
      .describe("Natural language instruction for processing the file"),
    max_chars: z
      .number()
      .optional()
      .describe("Maximum characters for text extraction; default 500"),
    pages: z
      .array(z.number())
      .optional()
      .describe("Page numbers to process for PDF; defaults to all pages"),
  }),
  system: `
You are a File Processing Agent. Use the 'key' parameter to load the file from S3 into the temporary directory and perform the 'operation' instruction on the file. Supported file types:
- PDF: extract images or text; pages may be specified.
- DOCX: convert to PDF via Gotenberg then extract images.
- Images (jpg, jpeg, png, webp): return image data.
- Text files: read and return text.
Use pdf2pic for PDF conversion, sharp for image resizing, and FormData/fetch for DOCX conversion. Return only JSON from tool calls. After processing, produce file paths in the temporary directory for any generated files; the main agent should use the send_file or send_photo telegram tools with those file paths to send them to the user.
`,
  createTools: ({ ctx }: ToolData) => ({
    process_file: tool({
      description:
        "Download a file from S3 and process it. Returns plain text for text extractions or an array of file paths for generated files (PDF pages, images, etc.) so the main agent can send them using telegram tools.",
      parameters: z.object({
        key: z.string().describe("S3 object key of the file"),
        max_chars: z
          .number()
          .optional()
          .describe("Maximum characters for text extraction; default 500"),
        pages: z
          .array(z.number())
          .optional()
          .describe("Page numbers for PDF; defaults to all pages"),
      }),
      async execute({ key, max_chars, pages }) {
        const s3file = s3.file(key);
        const localPath = path.join(ctx.session.tempDir, path.basename(key));
        await Bun.write(localPath, s3file);

        const ext = path.extname(localPath).slice(1).toLowerCase();
        if (ext === "pdf") {
          const pdfPages = await fromPath(localPath).bulk(-1, {
            responseType: "buffer",
          });
          let selected = pdfPages;
          if (pages && pages.length > 0) {
            selected = pdfPages.filter((p) => pages.includes(p.page!));
          }
          const files: Array<{ page: number; file_path: string }> = [];
          for (const p of selected) {
            const filename = `${path.basename(key, ".pdf")}_page${p.page}.png`;
            const outPath = path.join(ctx.session.tempDir, filename);
            await Bun.write(outPath, p.buffer!);
            files.push({ page: p.page!, file_path: outPath });
          }
          return { page_files: files };
        } else if (ext === "docx") {
          const form = new FormData();
          form.append("files", Bun.file(localPath));
          const res = await fetch(
            "http://gotenberg:3000/forms/libreoffice/convert",
            {
              method: "POST",
              body: form,
            },
          );
          if (!res.ok) {
            throw new Error(
              `Gotenberg failed with status ${res.status}: ${await res.text()}`,
            );
          }
          const buffer = Buffer.from(await res.arrayBuffer());
          const pdfPages = await fromBuffer(buffer).bulk(-1, {
            responseType: "buffer",
          });
          const resized: Array<{ page: number; buffer: Buffer }> = [];
          for (const p of pdfPages) {
            const imgBuf = await sharp(p.buffer!)
              .resize({ fit: "contain", width: 512 })
              .toBuffer();
            resized.push({ page: p.page!, buffer: imgBuf });
          }
          const files: Array<{ page: number; file_path: string }> = [];
          for (const item of resized) {
            const filename = `${path.basename(key, ".docx")}_page${item.page}.png`;
            const outPath = path.join(ctx.session.tempDir, filename);
            await Bun.write(outPath, item.buffer);
            files.push({ page: item.page, file_path: outPath });
          }
          return { page_files: files };
        } else if (["jpg", "jpeg", "png", "webp"].includes(ext)) {
          return { file_path: localPath };
        } else {
          const text = await Bun.file(localPath).text();
          const limit = max_chars ?? 500;
          return { text: text.length > limit ? text.slice(0, limit) : text };
        }
      },
    }),
  }),
});
