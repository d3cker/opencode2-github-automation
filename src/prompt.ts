import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GithubOptions } from "./config.js";

export async function botPrompt(options: Pick<GithubOptions, "ownerDirectory" | "systemPromptFile">) {
  const baseline = await readFile(new URL("../prompts/bot.md", import.meta.url), "utf8");
  if (!baseline.trim()) throw new Error("The bundled bot system prompt is empty");
  if (!options.systemPromptFile) return baseline;
  const custom = await readFile(resolve(options.ownerDirectory, options.systemPromptFile), "utf8");
  if (!custom.trim()) throw new Error("The configured bot system prompt is empty");
  return `${baseline}\n\n# Project-specific bot instructions\n\n${custom}`;
}
