import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

// Arrow function to convert HTML to Markdown
export const convertHtmlToMarkdown = async (html: string): Promise<string> => {
  // Step 1: Initial clean up using Regex/Heuristics
  const cleanedHTML: string = cleanHtml(html);

  // Step 2: Parse the HTML
  const dom: JSDOM = new JSDOM(cleanedHTML);
  const document: Document = dom.window.document;

  // Step 3: Apply Readability to get the main content
  const reader = new Readability(document);
  const article = reader.parse();

  if (!article || !article.textContent) {
    throw new Error("Failed to extract readable content");
  }

  // Step 4: Further clean-up the extracted content using heuristics/regex
  const refinedContent: string = refineContent(article.textContent);

  // Step 5: Convert the cleaned content to Markdown using Turndown
  const markdown: string = convertToMarkdown(refinedContent);

  // Step 6: Final clean-up on the Markdown output
  return finalCleanup(markdown);
};

// Arrow function for cleaning HTML with regex
const cleanHtml = (html: string): string => {
  // Clean up unnecessary tags like <script> and comments
  return html
    .replace(/<script[^>]*>([\s\S]*?)<\/script>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
};

// Arrow function to refine content
const refineContent = (content: string): string => {
  // For example, removing extra newlines
  return content.replace(/\n+/g, "\n").trim();
};

// Arrow function to convert HTML to Markdown
const convertToMarkdown = (html: string): string => {
  const turndownService = new TurndownService();
  return turndownService.turndown(html);
};

// Arrow function for final clean-up on Markdown
const finalCleanup = (markdown: string): string => {
  // Ensure proper spacing and clean-up extra lines
  return markdown.replace(/\n{2,}/g, "\n\n").trim();
};
