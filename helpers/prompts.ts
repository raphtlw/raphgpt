import fs from "fs";
import Handlebars from "handlebars";
import path from "path";
import { PROMPTS_DIR } from "@/bot/constants.js";

export const buildPrompt = async (name: string, data: object) => {
  const file = await fs.promises.readFile(
    path.join(PROMPTS_DIR, `${name}.hbs`),
    "utf-8",
  );
  const template = Handlebars.compile(file);
  return template(data);
};
