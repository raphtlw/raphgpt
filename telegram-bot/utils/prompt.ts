import Handlebars from "handlebars";

export const buildPrompt = async (name: string, data: object) => {
  const prompt = await Bun.file(`prompts/${name}.hbs`).text();
  const template = Handlebars.compile(prompt);
  return template(data);
};
