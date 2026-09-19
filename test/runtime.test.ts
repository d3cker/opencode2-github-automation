import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { GithubOptions } from "../src/config.js";
import { setupRuntime } from "../src/runtime.js";
import { registerRuntimeBridge } from "../src/bridge.js";
import type { Task } from "../src/dispatcher.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "oc2-runtime-"));
  const task: Task = { key: "o/r#1", repo: "o/r", issue: { number: 1, title: "Feature", body: "", state: "open", user: { login: "alice" } }, phase: "running", status: "ready", attempts: 0, nextAt: 0, createdAt: 0, branch: "bot/one", baseBranch: "develop", sessionID: "ses_main", worktree: directory,
    route: { agent: "build", model: { providerID: "local", id: "text" }, capabilities: ["text"], mediaModel: { model: { providerID: "local", id: "vision" }, capabilities: ["text", "vision"] } } };
  const options = GithubOptions.parse({ ownerDirectory: directory, stateDirectory: directory, repositories: [{ repo: "o/r", directory, baseBranch: "main", allowedAuthors: ["alice"], checks: [] }], routes: { "@bot": task.route } });
  const hooks: Record<string, (event: any) => Promise<void>> = {}, tools = new Map<string, any>();
  let normalQuestions = 0; const created: any[] = [], prompted: any[] = []; let helperLookups = 0;
  tools.set("question", { id: "question", name: "question", execute: async () => { normalQuestions++; return { content: "ordinary UI" }; } });
  const registration = { dispose: async () => {} };
  const ctx = {
    session: { hook: async (name: string, hook: any) => { hooks[name] = hook; return registration; },
      get: async ({ sessionID }: any) => { if (sessionID === task.sessionID) return { location: { directory: task.worktree } }; if (sessionID === "ses_child") return { parentID: task.sessionID, location: { directory: task.worktree } }; if (sessionID === "normal") return {}; if (helperLookups++ === 0) throw { _tag: "SessionNotFoundError" }; return { outcome: "succeeded" }; },
      create: async (value: any) => { created.push(value); return value; }, prompt: async (value: any) => { prompted.push(value); }, wait: async () => {},
      context: async () => [{ type: "assistant", text: "The button is red.", finish: "stop" }], interrupt: async () => {},
    },
    tool: { transform: async (apply: any) => { apply({ list: () => [...tools.values()], update: (id: string, fn: any) => fn(tools.get(id)), add: (tool: any) => tools.set(tool.name, tool) }); return registration; }, hook: async (name: string, hook: any) => { hooks[name] = hook; return registration; } },
    permission: { hook: async (name: string, hook: any) => { hooks[name] = hook; return registration; } },
  } as unknown as Plugin.Context;
  const unbind = registerRuntimeBridge(directory, {
    runtime: async ({ sessionID }) => sessionID === task.sessionID || task.helpers?.some(h => h.id === sessionID) ? structuredClone(task) : null,
    question: async ({ sessionID, id, text, permission }) => { task.question = { sessionID, id, text, permission, commentID: 100 }; return { id }; },
    helper: async ({ sessionID, capability }) => { task.helpers = [{ id: "ses_helper", parentID: sessionID, capability }]; return { id: "ses_helper" }; },
  });
  const stop = await setupRuntime(ctx, options);
  return { directory, task, options, hooks, tools, created, prompted, restart: async () => { await stop(); return setupRuntime(ctx, GithubOptions.parse(JSON.parse(JSON.stringify(options)))); }, normalQuestions: () => normalQuestions, close: async () => { await stop(); unbind(); await rm(directory, { recursive: true, force: true }); } };
}
test("runtime replaces console questions only for bot sessions and blocks tools while waiting", async () => {
  const f = await fixture();
  try {
    await f.tools.get("question").execute({ questions: ["Which color?"] }, { sessionID: "normal", id: "call1" });
    assert.equal(f.normalQuestions(), 1);
    const result = await f.tools.get("question").execute({ questions: ["Which color?"] }, { sessionID: "ses_main", id: "call2" });
    assert.match(result.content, /GitHub issue/); assert.match(f.task.question!.text, /Which color/); assert.equal(f.normalQuestions(), 1);
    const event = { sessionID: "ses_main", system: [], tools: { bash: {} } };
    await f.hooks.context!(event); assert.deepEqual(event.tools, {}); assert.match(JSON.stringify(event.system), /Assigned base branch: develop/);
    await assert.rejects(f.hooks["execute.before"]!({ sessionID: "ses_main", tool: "bash" }), /waiting for a reply/);
  } finally { await f.close(); }
});
test("permission prompts go to GitHub and require an exact scoped approval", async () => {
  const f = await fixture();
  try {
    const event = { sessionID: "ses_main", action: "bash", resources: ["npm test"], effect: "ask" };
    await f.hooks.evaluate!(event); assert.equal(event.effect, "deny"); assert.equal(f.task.question?.permission?.action, "bash");
    f.task.permissions = [{ sessionID: "ses_main", action: "bash", resources: ["npm test"], allow: true }];
    event.effect = "ask"; await f.hooks.evaluate!(event); assert.equal(event.effect, "allow");
    const unrelated = { ...event, resources: ["rm -rf ."], effect: "ask" }; await f.hooks.evaluate!(unrelated); assert.equal(unrelated.effect, "deny");
  } finally { await f.close(); }
});
test("vision delegation uses a distinct model session, attachments, and no helper tools", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "image.png"), "fixture");
    const result = await f.tools.get("inspect_media").execute({ capability: "vision", question: "What color is the button?", files: ["image.png"] }, { sessionID: "ses_main", id: "call1" });
    assert.equal(f.created[0].model.id, "vision"); assert.equal(f.created[0].metadata.automationParentSessionID, "ses_main");
    assert.equal(f.task.route?.model.id, "text"); assert.ok(f.prompted[0].files[0].uri.startsWith("file:")); assert.match(result.content, /button is red/);
    const event = { sessionID: "ses_helper", system: [], tools: { bash: {}, ask_issue: {} } };
    await f.hooks.context!(event); assert.deepEqual(event.tools, {});
    await assert.rejects(f.tools.get("inspect_media").execute({ capability: "vision", question: "Read", files: ["/etc/hosts"] }, { sessionID: "ses_main", id: "call2" }), /inside the task worktree/);
  } finally { await f.close(); }
});
test("unsupported audio requests ask for configuration or a transcript in the issue", async () => {
  const f = await fixture();
  try {
    const result = await f.tools.get("inspect_media").execute({ capability: "audio", question: "Transcribe", files: ["https://example.com/clip.wav"] }, { sessionID: "ses_main", id: "call1" });
    assert.match(result.content, /Stop all work/); assert.match(f.task.question!.text, /audio/); assert.equal(f.created.length, 0);
  } finally { await f.close(); }
});

test("native subagent questions are routed to the owning issue session", async () => {
  const f = await fixture();
  try {
    const result = await f.tools.get("question").execute({ questions: [{ question: "Use retries?", options: [{ label: "Yes", description: "Retry twice" }] }] }, { sessionID: "ses_child", id: "call1" });
    assert.match(result.content, /GitHub issue/);
    assert.equal(f.task.question?.sessionID, "ses_main");
    assert.match(f.task.question!.text, /1\. Use retries\?/); assert.match(f.task.question!.text, /Yes: Retry twice/);
    assert.equal(f.normalQuestions(), 0);
  } finally { await f.close(); }
});

test("repository opt-in approves file access for new sessions and native workers after runtime reload", async () => {
  const f = await fixture();
  let stopReloaded;
  const worktree = await mkdtemp(join(tmpdir(), "oc2-policy-worktree-"));
  try {
    f.task.worktree = worktree;
    f.options.repositories[0]!.autoApproveRepositoryFiles = true;
    // Reconstruct settings as a worker loader does after installation/restart.
    stopReloaded = await f.restart();
    for (const main of ["ses_main", "ses_next_round"]) {
      f.task.sessionID = main;
      for (const sessionID of [main, "ses_child"]) {
        for (const [action, resources] of [["external_directory", [f.directory + "/*"]], ["read", ["README.md"]], ["edit", ["new/file.ts"]]] as const) {
          const event = { sessionID, action, resources: [...resources], effect: "ask" };
          await f.hooks.evaluate!(event);
          assert.equal(event.effect, "allow", `${main}/${sessionID}/${action}`);
          assert.equal(f.task.question, undefined);
        }
      }
    }
  } finally { await stopReloaded?.(); await f.close(); await rm(worktree, { recursive: true, force: true }); }
});

test("repository approval preserves explicit denials, unrelated sessions, other repos and non-file permissions", async () => {
  const f = await fixture();
  try {
    const fileEvent = { sessionID: "ses_main", action: "external_directory", resources: [f.directory + "/*"], effect: "ask" };
    await f.hooks.evaluate!({ ...fileEvent }); assert.ok(f.task.question); // Existing configs remain opt-out.
    f.task.question = undefined;
    f.options.repositories[0]!.autoApproveRepositoryFiles = true;
    const deny = { ...fileEvent, effect: "deny" }; await f.hooks.evaluate!(deny); assert.equal(deny.effect, "deny"); assert.equal(f.task.question, undefined);
    f.task.permissions = [{ sessionID: "ses_main", action: fileEvent.action, resources: fileEvent.resources, allow: false }];
    const deniedInIssue = { ...fileEvent }; await f.hooks.evaluate!(deniedInIssue); assert.equal(deniedInIssue.effect, "deny"); assert.equal(f.task.question, undefined);
    f.task.permissions = [];
    const normal = { ...fileEvent, sessionID: "normal" }; await f.hooks.evaluate!(normal); assert.equal(normal.effect, "ask"); assert.equal(f.task.question, undefined);
    f.task.helpers = [{ id: "ses_helper", parentID: "ses_main", capability: "vision" }];
    for (const change of [{ sessionID: "ses_helper" }, { action: "shell", resources: ["npm test"] }, { resources: ["/etc/*"] }]) {
      const event = { ...fileEvent, ...change }; await f.hooks.evaluate!(event); assert.equal(event.effect, "deny"); assert.ok(f.task.question); f.task.question = undefined;
    }
    f.task.repo = "other/repository";
    const other = { ...fileEvent }; await f.hooks.evaluate!(other); assert.equal(other.effect, "deny"); assert.ok(f.task.question);
    f.task.repo = "o/r";
    const pending = { ...fileEvent }; await f.hooks.evaluate!(pending); assert.equal(pending.effect, "deny");
  } finally { await f.close(); }
});
