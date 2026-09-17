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
test("owner disposal releases a wait that ignores cancellation and preserves the worker for reconciliation", async () => {
  let interrupted = false;
  const controller = new AbortController();
  const ctx = { session: {
    get: async () => ({ location: { directory: "/worktree" } }),
    wait: async () => { controller.abort(); return new Promise(() => {}); },
    interrupt: async () => { interrupted = true; },
  } } as unknown as Plugin.Context;
  await assert.rejects(new OpenCodeExecutor(ctx, options, controller.signal, async () => {}).run({ ...task(), sessionID: "ses_test", promptAttempted: true }, async () => {}));
  assert.equal(interrupted, false);
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
    assert.equal(await git.hasBranch(repo, "release/next"), true);
    assert.equal(await git.hasBranch(repo, "release"), false);
    assert.equal(await git.hasBranch(repo, "missing"), false);
    const t: Task = { ...task(), worktree: undefined }; Object.assign(t, await git.prepare(t, repo));
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
    // Recovery can rename a published branch without moving its worktree.
    // Follow-up prepare, verification, and push must all honor the checkpoint.
    const savedPath = t.worktree!, savedBase = t.baseSha;
    await run(savedPath, ["git", "branch", "-m", "recovered-feature"]);
    t.branch = "recovered-feature";
    await writeFile(join(savedPath, "followup.txt"), "preserve this uncommitted work\n");
    Object.assign(t, await git.prepare(t, repo));
    assert.equal(t.worktree, savedPath);
    assert.equal(t.baseSha, savedBase);
    assert.equal(await readFile(join(savedPath, "followup.txt"), "utf8"), "preserve this uncommitted work\n");
    Object.assign(t, await git.verify(t, repo));
    await git.push(t, repo);
    assert.equal(await run(dir, ["git", "--git-dir", remote, "rev-parse", "refs/heads/recovered-feature"]), t.commit);
    await assert.rejects(git.prepare({ ...t, worktree: join(state, "worktrees", "missing-checkpoint") }, repo), /Saved task worktree is missing/);
    await assert.rejects(git.prepare({ ...t, worktree: checkout }, repo), /Unexpected worktree path/);
    await assert.rejects(git.prepare({ ...t, branch: "wrong-branch" }, repo), /Worktree branch changed/);
    const foreign = join(savedPath, "..", "foreign");
    await mkdir(foreign);
    await run(foreign, ["git", "init", "-b", t.branch]);
    await assert.rejects(git.prepare({ ...t, worktree: foreign }, repo), /another repository/);
    assert.equal(await run(t.worktree!, ["git", "ls-files", "--", ".opencode/plugins/automation-runtime/index.js"]), "");
    await writeFile(runtimePath, "// User customization\n");
    await assert.rejects(installWorkerPlugin(t.worktree!, options, run), /customized/);
    await assert.rejects(git.prepare({ ...task(), worktree: undefined, branch: "automation/missing-base" }, { ...repo, baseBranch: "missing" }), /Could not fetch base branch missing/);
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
  const prompts: any[] = []; let fail = true, interrupted: boolean;
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

test("base selection uses the configured model for natural-language requests and requires a structured decision", async () => {
  let response: unknown = { kind: "branch", branch: "develop", source: 0, quote: "Please use branch develop." };
  const prompts: string[] = [];
  const ctx = { generate: { text: async (input: any) => { assert.deepEqual(input.model, route.model); prompts.push(input.prompt); return { text: JSON.stringify(response) }; } } } as unknown as Plugin.Context;
  const executor = new OpenCodeExecutor(ctx, options, new AbortController().signal);
  for (const request of ["Please use branch develop.", "Użyj brancha develop.", "Work from develop for this change.", "/base develop"]) {
    response = { kind: "branch", branch: "develop", source: 0, quote: request };
    assert.deepEqual(await executor.selectBase(task(), options.repositories[0]!, [{ text: request }]), { kind: "branch", branch: "develop" });
    assert.ok(prompts.at(-1)!.includes(request));
  }
  assert.match(prompts[0]!, /Later clear corrections supersede/); assert.match(prompts[0]!, /Honor negation/);
  response = { kind: "question", question: "Which of these two branches should I use?" };
  assert.equal((await executor.selectBase(task(), options.repositories[0]!, [{ text: "Use develop or staging" }])).kind, "question");
  response = { kind: "branch", branch: "invented", source: 0, quote: "invented" };
  await assert.rejects(executor.selectBase(task(), options.repositories[0]!, [{ text: "Use develop" }]), /not supported/);
});

test("analysis returns a structured question and reassesses actual clarification replies on the main model", async () => {
  const question = { kind: "question", comment: "I propose heapsort or Timsort.", question: "Which algorithm should I implement?" };
  let output = JSON.stringify(question); let prompt = "";
  const ctx = { generate: { text: async (input: any) => {
    assert.deepEqual(input.model, route.model); prompt = input.prompt; return { text: output };
  } } } as unknown as Plugin.Context;
  const executor = new OpenCodeExecutor(ctx, options, new AbortController().signal);
  const t = task();
  t.issue.body = "Add sorting algorithms. Give me proposals before implementing.";
  assert.deepEqual(await executor.analyze(t), question);
  assert.ok(prompt.includes(t.issue.body)); assert.match(prompt, /Providing proposals is not permission/);
  t.analysis = "Previously asked which algorithm to implement.";
  t.analysisDialogue = [{ question: question.question, answer: { id: 20, body: "Implement heapsort only", user: { login: "alice" } } }];
  output = JSON.stringify({ kind: "proceed", comment: "Implement heapsort only and verify it." });
  assert.equal((await executor.analyze(t)).kind, "proceed");
  assert.ok(prompt.includes(t.analysis)); assert.ok(prompt.includes('"id":20')); assert.ok(prompt.includes("Implement heapsort only"));
  for (const invalid of ["", "Which algorithm do you want?", "{}", JSON.stringify({ kind: "proceed", comment: "Ready", question: "Pick one?" }), JSON.stringify({ kind: "question", comment: "Options" }), JSON.stringify({ kind: "proceed", comment: " " })]) {
    output = invalid; await assert.rejects(executor.analyze(t));
  }
});

test("the initial coding prompt preserves the confirmed choice and never treats publishing proposals as approval", async () => {
  const t = task(); let prompt = "";
  t.analysisDialogue = [{ question: "Heapsort or Timsort?", answer: { id: 20, body: "Heapsort only, with integer input", user: { login: "alice" } } }];
  const ctx = { session: {
    get: async () => ({ location: { directory: "/worktree" }, outcome: "succeeded" }),
    prompt: async (input: any) => { prompt = input.text; }, wait: async () => {},
    context: async () => [{ type: "user", text: "opencode2-task:owner/repo#1" }, { type: "assistant", finish: "stop" }],
  } } as unknown as Plugin.Context;
  await new OpenCodeExecutor(ctx, options, new AbortController().signal, async () => {}).run(t, async p => { Object.assign(t, p); });
  assert.match(prompt, /Heapsort only, with integer input/);
  assert.match(prompt, /publishing proposals alone is never approval/i);
});

for (const active of [false, true]) {
  test(`workflow recovery ${active ? "waits for active work without another prompt" : "continues the same interrupted session once across a lost response"}`, async () => {
    const t: Task = { ...task(), sessionID: "ses_saved", promptAttempted: true, recovery: { id: "recovery-1" } };
    let outcome = "interrupted", prompts = 0;
    const messages: unknown[] = [{ type: "user", text: "opencode2-task:owner/repo#1" }, { type: "assistant", finish: "stop" }];
    const ctx = { session: {
      get: async () => ({ location: { directory: "/worktree" }, outcome }),
      wait: async () => { if (active) outcome = "succeeded"; },
      context: async () => messages,
      prompt: async (input: { sessionID: string; id: string; text: string }) => {
        assert.equal(input.sessionID, "ses_saved"); assert.ok(input.id); assert.equal(t.recovery?.attempted, true);
        assert.match(input.text, /preserve all completed work/);
        prompts++; messages.push({ type: "user", text: input.text }, { type: "assistant", finish: "stop" });
        outcome = "succeeded";
        throw new Error("Lost prompt response");
      },
      interrupt: async () => { assert.fail("Recovery must not interrupt an active session"); },
      create: async () => { assert.fail("Recovery must reuse its session"); },
    } } as unknown as Plugin.Context;
    const make = () => new OpenCodeExecutor(ctx, options, new AbortController().signal, async () => {});
    const checkpoint = async (patch: Partial<Task>) => { Object.assign(t, patch); };
    if (!active) await assert.rejects(make().run(t, checkpoint), /Lost prompt response/);
    await make().run(t, checkpoint);
    assert.equal(prompts, active ? 0 : 1);
    assert.equal(t.sessionID, "ses_saved");
  });
}

test("an unconfirmed recovery prompt is blocked instead of silently publishing or sending it twice", async () => {
  const t: Task = { ...task(), sessionID: "ses_saved", promptAttempted: true, recovery: { id: "missing", attempted: true } };
  const ctx = { session: {
    get: async () => ({ location: { directory: "/worktree" }, outcome: "succeeded" }), wait: async () => {},
    context: async () => [{ type: "user", text: "opencode2-task:owner/repo#1" }, { type: "assistant", finish: "stop" }],
    prompt: async () => { assert.fail("Do not repeat a prompt of uncertain delivery"); },
  } } as unknown as Plugin.Context;
  await assert.rejects(new OpenCodeExecutor(ctx, options, new AbortController().signal, async () => {}).run(t, async () => {}), /Recovery prompt delivery is uncertain/);
});

test("a real wait deadline records a recoverable session stop and interrupts once", async () => {
  const { SessionStopped } = await import("../src/dispatcher.js");
  let interrupts = 0;
  const ctx = { session: {
    get: async () => ({ location: { directory: "/worktree" } }),
    wait: async () => new Promise(() => {}),
    interrupt: async () => { interrupts++; },
  } } as unknown as Plugin.Context;
  const executor = new OpenCodeExecutor(ctx, { ...options, sessionTimeoutSeconds: 0.01 }, new AbortController().signal, async () => {});
  const timer = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(executor.run({ ...task(), sessionID: "ses_saved", promptAttempted: true }, async () => {}), SessionStopped);
    assert.equal(interrupts, 1);
  } finally { clearTimeout(timer); }
});

test("task closure interrupts all saved sessions, tolerates missing ones and waits for idleness", async () => {
  const interrupted: string[] = [], waited: string[] = [];
  const ctx = { session: {
    interrupt: async ({ sessionID }: { sessionID: string }) => { interrupted.push(sessionID); if (sessionID === "gone") throw { _tag: "Session.NotFoundError" }; },
    wait: async ({ sessionID }: { sessionID: string }) => { waited.push(sessionID); },
  } } as unknown as Plugin.Context;
  const t = { ...task(), sessionID: "main", sessionIDs: ["main", "previous", "gone"], helpers: [{ id: "media", parentID: "main", capability: "vision" as const }] };
  await new OpenCodeExecutor(ctx, options, new AbortController().signal).cancel(t, true);
  assert.deepEqual(interrupted.sort(), ["gone", "main", "media", "previous"]);
  assert.deepEqual(waited.sort(), ["main", "media", "previous"]);
});

test("closing after a checkpoint prevents a late implementation prompt", async () => {
  let prompts = 0;
  const t = { ...task(), sessionID: "existing", sessionReady: true };
  const ctx = { session: {
    get: async () => ({ location: { directory: "/worktree" } }),
    prompt: async () => { prompts++; },
  } } as unknown as Plugin.Context;
  const executor = new OpenCodeExecutor(ctx, options, new AbortController().signal, async () => {});
  await assert.rejects(executor.run(t, async patch => { Object.assign(t, patch); if (patch.promptAttempted) t.status = "closing"; }), /tracking is closed/);
  assert.equal(prompts, 0);
});

test("legacy publication retrieves the saved final summary without invoking the model and distinguishes missing sessions from transient errors", async () => {
  let mode = "success";
  const ctx = { session: {
    get: async () => { if (mode === "missing") throw { _tag: "SessionNotFoundError" }; if (mode === "network") throw new Error("network"); return { outcome: "succeeded" }; },
    context: async () => [{ type: "assistant", finish: "stop", content: [{ type: "reasoning", text: "hidden" }, { type: "text", text: "## Summary\n\nDelivered changes." }] }],
  } } as unknown as Plugin.Context;
  const e = new OpenCodeExecutor(ctx, options, new AbortController().signal);
  const t = { ...task(), sessionID: "ses_test", round: 1 };
  assert.deepEqual(await e.summary(t), { sessionID: "ses_test", round: 1, text: "## Summary\n\nDelivered changes." });
  mode = "missing"; assert.match((await e.summary(t)).unavailable!, /no longer available/);
  mode = "network"; await assert.rejects(e.summary(t), /network/);
});
