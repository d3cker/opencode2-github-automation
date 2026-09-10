#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { EasyOptions, checkout, detectCheck, resolveEasy } from "./easy.js";
import { installLocalEntrypoints } from "./local.js";

async function main() {
  const operation = process.argv[2];
  if (operation === "upgrade") {
    const { root, primary } = await checkout(process.cwd());
    if (!primary) throw new Error("Uruchom upgrade w głównym checkoutcie.");
    await installLocalEntrypoints(root);
    console.log("Zaktualizowano integrację OpenCode i interfejsu. Konfiguracja i kolejka zostały zachowane.");
    return;
  }
  if (operation && ["status", "scan", "run", "pause", "resume", "retry"].includes(operation)) {
    const { root } = await checkout(process.cwd());
    if (["run", "pause", "resume"].includes(operation) && !process.argv[3]) process.argv.push("github-issues");
    process.argv.splice(3, 0, root);
    await import("./manage.js");
    return;
  }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    model: { type: "string" }, check: { type: "string", multiple: true }, trigger: { type: "string" },
    "skip-tests": { type: "boolean", default: false },
    local: { type: "boolean", default: false }, help: { type: "boolean", short: "h" },
  } });
  if (values.help || positionals[0] !== "init" || positionals.length !== 1) {
    console.log("Usage: opencode2-automation init [--model provider/model] [--trigger @d3ckerbot] [--check executable --check argument | --skip-tests] [--local]\n       opencode2-automation <status|scan|pause|resume|run|upgrade>\n       opencode2-automation retry owner/repo#123 [--restart-session]\nRun inside your repository. --local enables an installation in .opencode/node_modules.");
    return;
  }
  const { root, primary } = await checkout(process.cwd());
  if (!primary) throw new Error("Uruchom init w głównym checkoutcie repozytorium.");
  if (values["skip-tests"] && values.check) throw new Error("Wybierz --check albo --skip-tests.");
  const detected = await detectCheck(root);
  let model = values.model;
  let check: string[] | false | undefined = values["skip-tests"] ? false : values.check ?? detected;
  if ((!model || check === undefined) && !stdin.isTTY) throw new Error("Podaj --model provider/model oraz --check lub --skip-tests, jeśli nie wykryto testów.");
  if (!model || check === undefined) {
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      model ??= (await prompt.question("Model z OpenCode 2 (provider/model): ")).trim();
      if (check === undefined) {
        const command = (await prompt.question("Komenda testów (np. npm test). Enter = pomiń, jeśli projekt nie ma testów: ")).trim();
        if (/["'|;&<>`$\\]/.test(command)) throw new Error("Dla złożonych argumentów użyj powtarzanego --check.");
        check = command ? command.split(/\s+/).filter(Boolean) : false;
      }
    } finally { prompt.close(); }
  }
  const settings = { model, ...(values.trigger ? { trigger: values.trigger } : {}), ...(check === false || values.check || !detected ? { check } : {}) };
  const resolved = await resolveEasy(root, EasyOptions.parse(settings));
  // Resolve everything before changing files. Never overwrite existing user configuration.
  const folder = join(root, ".opencode");
  if (values.local) await readFile(join(folder, "node_modules", "opencode2-automation", "package.json"));
  await mkdir(folder, { recursive: true });
  const file = join(folder, "automation.json");
  await writeFile(file, JSON.stringify(settings, null, 2) + "\n", { flag: "wx" });
  try {
    if (values.local) {
      await installLocalEntrypoints(root);
    }
  } catch (error) { await rm(file); throw error; }
  console.log(`Gotowe: ${resolved.repo}. Znacznik: ${values.trigger ?? "@d3ckerbot"}. Autor: ${resolved.login}. Testy: ${resolved.check === false ? "pominięte — PR będzie zawierał tę informację" : resolved.check.join(" ")}.\nOtwórz ponownie projekt w OpenCode 2. Automatyzacja podejmie także istniejące pasujące issues.`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Konfiguracja nie powiodła się"); process.exitCode = 1; });
