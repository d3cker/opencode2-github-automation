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
import { installGlobalEntrypoints } from "./install.js";
import { discoverRepositories, listRepositories, registerRepositories } from "./repositories.js";
import { formatRepositories } from "./repository-report.js";
import { fileURLToPath } from "node:url";

async function main() {
  const operation = process.argv[2];
  if (operation === "list") {
    const { values, positionals } = parseArgs({ args: process.argv.slice(3), options: { json: { type: "boolean" }, discover: { type: "string" } } });
    if (positionals.length) throw new Error("Usage: opencode2-automation list [--json] [--discover /path/to/projects]");
    const discovered = values.discover ? await discoverRepositories(values.discover) : undefined;
    const report = await listRepositories();
    report.warnings.push(...discovered?.warnings ?? []);
    console.log(values.json ? JSON.stringify(report, null, 2) : formatRepositories(report));
    return;
  }
  if (operation === "install") {
    const directory = await installGlobalEntrypoints(fileURLToPath(new URL("..", import.meta.url)));
    console.log(`Registered OpenCode 2 automation and TUI in ${directory}. Restart the service when its sessions are idle. Run init inside a project when ready.`);
    return;
  }
  if (operation === "upgrade") {
    const { root, primary } = await checkout(process.cwd());
    if (!primary) throw new Error("Run upgrade in the primary checkout.");
    await installLocalEntrypoints(root);
    console.log("Updated the OpenCode integration and UI. Configuration and queue were preserved.");
    return;
  }
  if (operation && ["status", "scan", "run", "pause", "resume", "retry", "restartworkflow", "cancelround", "resumetracking"].includes(operation)) {
    const { root } = await checkout(process.cwd());
    if (["run", "pause", "resume"].includes(operation) && !process.argv[3]) process.argv.push("github-issues");
    process.argv.splice(3, 0, root);
    await import("./manage.js");
    return;
  }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    "base-branch": { type: "string" }, capabilities: { type: "string" }, "media-model": { type: "string" }, "media-capabilities": { type: "string" }, "system-prompt": { type: "string" },
    signature: { type: "string" }, authors: { type: "string", multiple: true },
    model: { type: "string" }, check: { type: "string", multiple: true }, trigger: { type: "string" },
    "skip-tests": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    local: { type: "boolean", default: false }, help: { type: "boolean", short: "h" },
  } });
  if (values.help || positionals[0] !== "init" || positionals.length !== 1) {
    console.log("Usage: opencode2-automation install\n       opencode2-automation init [--model provider/model] [--trigger @opencodebot] [--base-branch name] [--capabilities text,vision,audio] [--media-model provider/model] [--media-capabilities text,vision] [--system-prompt path.md] [--signature text] [--authors login (repeatable)] [--check executable --check argument | --skip-tests] [--local] [--yes]\n       opencode2-automation <status|scan|pause|resume|run|upgrade>\n       opencode2-automation list [--json] [--discover /path/to/projects]\n       opencode2-automation retry owner/repo#123 [--restart-session]\n       opencode2-automation restartworkflow owner/repo#123\n       opencode2-automation cancelround owner/repo#123\n       opencode2-automation resumetracking owner/repo#123\ninstall registers the global plugin. list works from any directory. Run other commands inside your repository. --local enables an installation in .opencode/node_modules.");
    return;
  }
  const { root, primary } = await checkout(process.cwd());
  if (!primary) throw new Error("Run init in the primary repository checkout.");
  if (values["skip-tests"] && values.check) throw new Error("Choose --check or --skip-tests.");
  const detected = await detectCheck(root);
  const check = values["skip-tests"] ? false : values.check ?? detected;
  const extensions = {
    ...(values["base-branch"] ? { baseBranch: values["base-branch"] } : {}),
    ...(values.capabilities ? { capabilities: values.capabilities.split(",").map(s => s.trim()) as ("text" | "vision" | "audio")[] } : {}),
    ...(values["media-model"] ? { mediaModel: { model: values["media-model"], capabilities: (values["media-capabilities"] ?? "text,vision").split(",").map(s => s.trim()) as ("text" | "vision" | "audio")[] } } : {}),
    ...(values["system-prompt"] ? { systemPromptFile: values["system-prompt"] } : {}),
  };
  let settings: unknown = { ...extensions, model: values.model, ...(values.trigger ? { trigger: values.trigger } : {}),
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
        ...extensions, model: values.model, trigger: values.trigger, signature: values.signature, authors: values.authors,
        check: values["skip-tests"] ? false : values.check,
      });
      if (values["system-prompt"]) settings = { ...settings as object, systemPromptFile: values["system-prompt"] };
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
  await registerRepositories(resolved.github.repositories.map(r => ({ ownerDirectory: root, directory: r.directory, repo: r.repo, baseBranch: r.baseBranch, stateDirectory: resolved.github.stateDirectory, configFile: file, registeredAt: Date.now() }))).catch(error => console.error(`Repository registration failed; retry with list --discover "${root}": ${error instanceof Error ? error.message : "unknown error"}`));
  console.log(`Ready: ${resolved.repo}. Trigger: ${EasyOptions.parse(settings).trigger}. Account: ${resolved.login}. Tests: ${resolved.check === false ? "skipped — the PR will report this" : resolved.check.join(" ")}.\nLoad the project in OpenCode 2 through the TUI or the API. Automation also considers existing matching issues.`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Configuration failed"); process.exitCode = 1; });
