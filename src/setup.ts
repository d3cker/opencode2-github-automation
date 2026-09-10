#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { EasyOptions, checkout, detectCheck, resolveEasy, githubToken } from "./easy.js";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { configure } from "./wizard.js";
import { installLocalEntrypoints } from "./local.js";

async function main() {
  const operation = process.argv[2];
  if (operation === "upgrade") {
    const { root, primary } = await checkout(process.cwd());
    if (!primary) throw new Error("Run upgrade in the primary checkout.");
    await installLocalEntrypoints(root);
    console.log("Updated the OpenCode integration and UI. Configuration and queue were preserved.");
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
    signature: { type: "string" }, authors: { type: "string", multiple: true },
    model: { type: "string" }, check: { type: "string", multiple: true }, trigger: { type: "string" },
    "skip-tests": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    local: { type: "boolean", default: false }, help: { type: "boolean", short: "h" },
  } });
  if (values.help || positionals[0] !== "init" || positionals.length !== 1) {
    console.log("Usage: opencode2-automation init [--model provider/model] [--trigger @opencodebot] [--signature text] [--authors login (repeatable)] [--check executable --check argument | --skip-tests] [--local] [--yes]\n       opencode2-automation <status|scan|pause|resume|run|upgrade>\n       opencode2-automation retry owner/repo#123 [--restart-session]\nRun inside your repository. --local enables an installation in .opencode/node_modules.");
    return;
  }
  const { root, primary } = await checkout(process.cwd());
  if (!primary) throw new Error("Run init in the primary repository checkout.");
  if (values["skip-tests"] && values.check) throw new Error("Choose --check or --skip-tests.");
  const detected = await detectCheck(root);
  const check = values["skip-tests"] ? false : values.check ?? detected;
  let settings: unknown = { model: values.model, ...(values.trigger ? { trigger: values.trigger } : {}),
    ...(values.signature ? { signature: values.signature } : {}), ...(values.authors ? { authors: values.authors } : {}),
    ...(check === false || values.check || !detected ? { check } : {}) };
  // Refuse an existing configuration before making requests or asking questions.
  try { await readFile(join(root, ".opencode", "automation.json")); throw new Error("Configuration already exists. Edit .opencode/automation.json instead."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (stdin.isTTY && !values.yes) {
    const token = await githubToken();
    const user = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!user.ok) throw new Error(`GitHub HTTP ${user.status}. Check your authentication.`);
    const login = (await user.json() as { login?: string }).login;
    if (!login) throw new Error("GitHub did not return an account login");
    let defaultModel: string | undefined;
    if (!values.model) {
      try {
        const endpoint = await Service.discover();
        if (endpoint) {
          const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
          const result = await client.model.default({ location: { directory: root } }, { signal: AbortSignal.timeout(5000) });
          if (result.data) defaultModel = `${result.data.providerID}/${result.data.id}`;
        }
      } catch { /* If no model can be detected, require an explicit choice. */ }
    }
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      settings = await configure(message => prompt.question(message), { login, model: defaultModel, check: detected }, {
        model: values.model, trigger: values.trigger, signature: values.signature, authors: values.authors,
        check: values["skip-tests"] ? false : values.check,
      });
    } finally { prompt.close(); }
  } else if (!values.model || check === undefined) {
    throw new Error("Pass --model provider/model and --check or --skip-tests when no tests are detected.");
  }
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
  console.log(`Ready: ${resolved.repo}. Trigger: ${EasyOptions.parse(settings).trigger}. Account: ${resolved.login}. Tests: ${resolved.check === false ? "skipped — the PR will report this" : resolved.check.join(" ")}.\nReopen the project in OpenCode 2. Automation also considers existing matching issues.`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Configuration failed"); process.exitCode = 1; });
