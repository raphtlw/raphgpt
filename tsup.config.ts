import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["main.ts"],
  clean: true,
  format: "esm",
  target: "esnext",
  sourcemap: true,
});
