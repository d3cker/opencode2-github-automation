import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { GithubOptions } from "../src/config.js";
import { Blocked, WaitingForAnswer, type Task } from "../src/dispatcher.js";
import { GitWorkspace, OpenCodeExecutor, commandRunner } from "../src/executor.js";
import { installWorkerPlugin } from "../src/worker.js";
import githubPlugin from "../src/plugins/github.js";
import schedulerPlugin from "../src/plugins/scheduler.js";
import { GithubRpc, SchedulerRpc } from "../src/rpc.js";
import { redact } from "../src/state.js";

const route = { agent: "build", model: { providerID: "deepseek", id: "test-model" } };
function task(): Task { return { key: "owner/repo#1", repo: "owner/repo", issue: { number: 1, title: "Fix counter", body: "@deepseek counter", state: "open", user: { login: "alice" } }, route, phase: "running", status: "ready", attempts: 0, nextAt: 0, createdAt: 0, branch: "automation/issue-1-test", commentID: 1, analysis: "Analysis", worktree: "/worktree" }; }
const options = GithubOptions.parse({ ownerDirectory: "/repo", stateDirectory: "/state", repositories: [{ repo: "owner/repo", directory: "/repo", baseBranch: "main", allowedAuthors: ["alice"], checks: [["true"]] }], routes: { "@deepseek": route } });

test("two V2 entrypoints and RPC definitions load with the real SDK", () => {
  assert.equal(githubPlugin.id, "automation.github"); assert.equal(schedulerPlugin.id, "automation.scheduler");
  assert.equal(GithubRpc.id, "automation.github"); assert.equal(SchedulerRpc.id, "automation.scheduler");
});
test("OpenCode executor checkpoints IDs before sending work and resumes without another prompt", async () => {
  const events: string[] = []; let exists = false, prompted = false;
  const t = task();
  const ctx = { session: {
    get: async () => { if (!exists) throw { _tag: "SessionNotFoundError" }; return { location: { directory: "/worktree" }, outcome: "succeeded" }; },
    create: async () => { assert.ok(t.sessionID); events.push("create"); exists = true; return { location: { directory: "/worktree" } }; },
    prompt: async () => { assert.equal(t.promptAttempted, true); events.push("prompt"); prompted = true; },
    wait: async () => {},
    context: async () => prompted ? [{ type: "user", text: "opencode2-task:owner/repo#1" }, { type: "assistant", finish: "stop" }] : [],
  } } as unknown as Plugin.Context;
  const executor = new OpenCodeExecutor(ctx, options, new AbortController().signal, async () => {});
  await executor.run(t, async patch => { Object.assign(t, patch); });
  await executor.run(t, async patch => { Object.assign(t, patch); });
  assert.deepEqual(events, ["create", "prompt"]);
});
test("transport failure while looking up a session never creates a duplicate", async () => {
  let created = false;
  const ctx = { session: { get: async () => { throw new Error("network"); }, create: async () => { created = true; } } } as unknown as Plugin.Context;
  const t = task(); await assert.rejects(new OpenCodeExecutor(ctx, options, new AbortController().signal, async () => {}).run(t, async p => { Object.assign(t, p); }), /network/);
  assert.equal(created, false);
});
test("in-process Session.NotFoundError with an empty message creates the session", async () => {
  const t = task(); let created = false;
  const error = new Error(""); error.name = "Session.NotFoundError";
  const ctx = { session: {
    get: async () => { if (!created) throw error; return { location: { directory: "/worktree" }, outcome: "succeeded" }; },
    create: async () => { created = true; return { location: { directory: "/worktree" } }; },
    prompt: async () => {}, wait: async () => {},
    context: async () => [{ type: "user", text: "opencode2-task:owner/repo#1" }, { type: "assistant", finish: "stop" }],
    interrupt: async () => { throw error; },
  } } as unknown as Plugin.Context;
  const executor = new OpenCodeExecutor(ctx, options, new AbortController().signal, async () => {});
  await executor.run(t, async patch => { Object.assign(t, patch); });
  assert.equal(created, true);
  await executor.cancel(t);
  assert.equal(redact(error), "Session.NotFoundError");
  assert.equal(redact({ _tag: "SessionNotFoundError", message: "secret" }, ["secret"]), "SessionNotFoundError: [REDACTED]");
});
test("uncertain prompt and failed session outcomes block verification", async () => {
  const t = { ...task(), sessionID: "ses_test", promptAttempted: true };
  let messages: unknown[] = [];
  const ctx = { session: { get: async () => ({ location: { directory: "/worktree" }, outcome: "failed" }), wait: async () => {}, context: async () => messages } } as unknown as Plugin.Context;
  const executor = new OpenCodeExecutor(ctx, options, new AbortController().signal, async () => {});
  await assert.rejects(executor.run(t, async () => {}), /delivery is uncertain/);
  messages = [{ type: "user", text: "opencode2-task:owner/repo#1" }, { type: "assistant", finish: "error" }];
  await assert.rejects(executor.run(t, async () => {}), /did not complete successfully/);
});
test("abort of a running wait interrupts the server session", async () => {
  let interrupted = false;
  const controller = new AbortController();
  const ctx = { session: {
    get: async () => ({ location: { directory: "/worktree" } }),
    wait: async () => { controller.abort(); throw new Error("aborted"); },
    interrupt: async () => { interrupted = true; },
  } } as unknown as Plugin.Context;
  await assert.rejects(new OpenCodeExecutor(ctx, options, controller.signal, async () => {}).run({ ...task(), sessionID: "ses_test", promptAttempted: true }, async () => {}));
  assert.equal(interrupted, true);
});

test("real git worktree isolates a fix, verifies, commits and pushes to a local bare remote", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc2-git-"));
  const run = commandRunner(new AbortController().signal, 30_000, "GITHUB_TOKEN");
  const checkout = join(dir, "checkout"), remote = join(dir, "remote.git"), state = join(dir, "state");
  await mkdir(checkout);
  try {
    await run(dir, ["git", "init", "--bare", remote]);
    await run(checkout, ["git", "init", "-b", "main"]);
    await run(checkout, ["git", "config", "user.name", "Test"]);
    await run(checkout, ["git", "config", "user.email", "test@example.invalid"]);
    await run(checkout, ["git", "config", "commit.gpgsign", "false"]);
    await writeFile(join(checkout, "counter.txt"), "broken\n");
    await run(checkout, ["git", "add", "."]); await run(checkout, ["git", "commit", "-m", "Initial"]);
    await run(checkout, ["git", "remote", "add", "origin", remote]);
    await run(checkout, ["git", "push", "-u", "origin", "main"]);
    await run(checkout, ["git", "switch", "-c", "release/next"]);
    await writeFile(join(checkout, "release.txt"), "release-only feature\n");
    await run(checkout, ["git", "add", "."]); await run(checkout, ["git", "commit", "-m", "Release base"]);
    await run(checkout, ["git", "push", "origin", "release/next"]);
    const selectedBase = await run(checkout, ["git", "rev-parse", "HEAD"]);
    await run(checkout, ["git", "switch", "main"]);
    // Only identity lookup is substituted; fetch, worktree, checks, commit and push use real git.
    const git = new GitWorkspace(state, (cwd, argv) => argv.join(" ") === "git remote get-url origin" ? Promise.resolve("git@github.com:owner/repo.git") : run(cwd, argv));
    const repo = { ...options.repositories[0]!, baseBranch: "release/next", directory: checkout, checks: [[process.execPath, "-e", 'if (require("fs").readFileSync("counter.txt", "utf8") !== "fixed\\n") process.exit(1)']] };
    const t = task(); Object.assign(t, await git.prepare(t, repo));
    assert.equal(t.baseSha, selectedBase);
    assert.match(await readFile(join(t.worktree!, "release.txt"), "utf8"), /release-only/);
    await installWorkerPlugin(t.worktree!, options, run);
    await installWorkerPlugin(t.worktree!, options, run);
    assert.equal(await run(t.worktree!, ["git", "status", "--porcelain"]), "");
    const runtimePath = join(t.worktree!, ".opencode/plugins/automation-runtime/index.js");
    assert.match(await readFile(runtimePath, "utf8"), /workerPlugin/);
    await assert.rejects(git.verify(t, repo), Blocked);
    await writeFile(join(t.worktree!, "counter.txt"), "fixed\n");
    Object.assign(t, await git.verify(t, repo)); await git.push(t, repo);
    assert.equal(await readFile(join(checkout, "counter.txt"), "utf8"), "broken\n");
    assert.equal(await run(dir, ["git", "--git-dir", remote, "rev-parse", `refs/heads/${t.branch}`]), t.commit);
    const resumed = await git.prepare(t, repo); assert.equal(resumed.worktree, t.worktree);
    const withoutTests = await git.verify(t, { ...repo, checks: [] });
    assert.deepEqual(withoutTests.checks, []);
    assert.equal(withoutTests.commit, t.commit);
    assert.equal(await run(t.worktree!, ["git", "ls-files", "--", ".opencode/plugins/automation-runtime/index.js"]), "");
    await writeFile(runtimePath, "// User customization\n");
    await assert.rejects(installWorkerPlugin(t.worktree!, options, run), /customized/);
    await assert.rejects(git.prepare({ ...task(), branch: "automation/missing-base" }, { ...repo, baseBranch: "missing" }), /Could not fetch base branch missing/);
    await writeFile(join(t.worktree!, "counter.txt"), "changed after verification\n");
    await assert.rejects(git.push(t, repo), /changed after verification/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("PR title assessment uses the completed session and accepts features without a Fix prefix", async () => {
  let prompt = ""; let result = "Add Python sorting algorithms";
  const ctx = {
    session: { context: async () => [{ type: "assistant", text: "Implemented merge sort and quicksort with tests." }] },
    generate: { text: async (input: { prompt: string }) => { prompt = input.prompt; return { text: result }; } },
  } as unknown as Plugin.Context;
  const e = new OpenCodeExecutor(ctx, options, new AbortController().signal, async () => {});
  const t = { ...task(), sessionID: "ses_test" };
  assert.equal(await e.title(t), "Add Python sorting algorithms");
  assert.match(prompt, /Implemented merge sort/); assert.match(prompt, /never default to Fix/);
  for (const invalid of ["", "Title\nExplanation", "x".repeat(241)]) {
    result = invalid; await assert.rejects(e.title(t), /invalid PR title/);
  }
});

test("issue answers resume the same session once and retry uncertain delivery with the same ID", async () => {
  const t = { ...task(), sessionID: "ses_main", promptAttempted: true };
  const prompts: any[] = []; let fail = true, interrupted = false;
  const ctx = { session: {
    get: async () => ({ location: { directory: "/worktree" }, outcome: "succeeded" }),
    prompt: async (input: any) => { prompts.push(input); if (fail) { fail = false; throw new Error("connection lost after acceptance"); } },
    wait: async () => {}, interrupt: async () => { interrupted = true; },
    context: async () => [{ type: "user", text: "opencode2-task:owner/repo#1" }, { type: "assistant", finish: "stop" }],
  } } as unknown as Plugin.Context;
  t.question = { id: "q1", sessionID: "ses_main", text: "Which color?", commentID: 10 };
  const executor = new OpenCodeExecutor(ctx, options, new AbortController().signal, async () => {});
  const checkpoint = async (patch: Partial<Task>) => { Object.assign(t, patch); };
  await assert.rejects(executor.run(t, checkpoint), WaitingForAnswer);
  assert.equal(prompts.length, 0);
  t.question.answer = { id: 11, body: "Blue", user: { login: "alice" } };
  await assert.rejects(executor.run(t, checkpoint), /connection lost/);
  await executor.run(t, checkpoint);
  assert.equal(prompts.length, 2); assert.equal(prompts[0].id, prompts[1].id);
  assert.equal(prompts[1].sessionID, "ses_main"); assert.match(prompts[1].text, /Blue/);
  assert.equal(t.question.answerSent, true);
  await executor.run(t, checkpoint); assert.equal(prompts.length, 2);
  interrupted = false;
  ctx.session.wait = async () => { t.question = { id: "q2", sessionID: "ses_main", text: "Next?" }; throw new Error("waiting connection lost"); };
  await assert.rejects(executor.run(t, checkpoint), WaitingForAnswer);
  assert.equal(interrupted, true);
});
