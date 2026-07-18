import tsParser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      "obsidianmd/ui/sentence-case": ["warn", { brands: ["Taskline"], acronyms: ["JSON", "ID"] }],
    },
  },
  {
    ignores: ["esbuild.config.mjs", "main.js", "node_modules/**", "tests/**"],
  },
]);
