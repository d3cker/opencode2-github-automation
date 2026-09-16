import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { GithubOptions, Job, matchRoute } from "../src/config.js";
import { Scheduler } from "../src/scheduler.js";
import { Dispatcher, Blocked, Queue, type Executor, type GithubPort } from "../src/dispatcher.js";
import { JsonStore, acquire, type Store } from "../src/state.js";
import { Github, GithubError, type Issue, type Comment } from "../src/github.js";
import type { Plugin } from "@opencode/plugin";
import { OpenCodeExecutor } from "../src/executor.js";

const route = { agent: "build", model: { providerID: "deepseek", id: "test-model" } };
const options = GithubOptions.parse({ ownerDirectory: "/repo", stateDirectory: "/state", repositories: [{ repo: "owner/repo", directory: "/repo", baseBranch: "main", allowedAuthors: ["alice"], checks: [["npm", "test"]] }], routes: { "@deepseek": route } });
const issue: Issue = { number: 1, title: "Broken counter", body: "Please fix @deepseek", state: "open", user: { login: "alice" } };
class Memory<T> implements Store<T> {
  constructor(public data: T) {}
  async load() { return structuredClone(this.data); }
  async save(data: T) { this.data = structuredClone(data); }
}
function fixture() {
  const events: string[] = [];
  const store = new Memory<Queue>({ version: 1, tasks: [] });
  let time = 1000;
  const github: GithubPort = {
    comments: async () => [],
    issues: async () => [structuredClone(issue)], issue: async () => structuredClone(issue),
    ensureComment: async () => { events.push("comment"); return 42; },
    findPull: async () => undefined,
    pull: async (_repo, number) => ({ number, html_url: `https://github.com/owner/repo/pull/${number}`, state: "open" }),
    ensurePull: async () => { events.push("pr"); return { number: 2, html_url: "https://github.com/owner/repo/pull/2", state: "open" }; },
  };
  const executor: Executor = {
    selectBase: async (_task, repo) => ({ kind: "branch", branch: repo.baseBranch }),
    hasBranch: async () => true,
    title: async () => "Repair counter increment",
    analyze: async () => { events.push("analyze"); return { kind: "proceed", comment: "Problem and verification plan" }; },
    prepare: async () => { events.push("prepare"); return { worktree: "/worktree", baseSha: "base" }; },
    run: async (_, checkpoint) => { events.push("run"); await checkpoint({ sessionID: "ses_test" }); },
    verify: async () => { events.push("verify"); return { checks: ["npm test passed"], commit: "sha" }; },
    push: async () => { events.push("push"); }, cancel: async () => { events.push("cancel"); },
  };
  const make = () => new Dispatcher(options, store, github, executor, new AbortController().signal, [], () => time);
  return { events, store, github, executor, make, advance: () => { time += 4_000_000; } };
}

test("an evicted dispatcher resumes the completed saved session and publishes exactly once", async () => {
  const f = fixture(), controller = new AbortController();
  let prompts = 0, interrupts = 0, finished = false;
  let entered!: () => void, complete!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const sdkWait = new Promise<void>(resolve => { complete = resolve; });
  const ctx = { session: {
    get: async () => ({ location: { directory: "/worktree" }, outcome: finished ? "succeeded" : undefined }),
    prompt: async () => { prompts++; },
    // Deliberately ignore request options, as the affected OpenCode adapter does.
    wait: async () => { entered(); if (!finished) await sdkWait; },
    context: async () => [{ type: "user", text: "opencode2-task:owner/repo#1" }, { type: "assistant", finish: "stop" }],
    interrupt: async () => { interrupts++; },
  } } as unknown as Plugin.Context;
  const original = new OpenCodeExecutor(ctx, options, controller.signal, async () => {});
  f.executor.run = original.run.bind(original);
  const old = new Dispatcher(options, f.store, f.github, f.executor, controller.signal, [], () => 1000);
  await old.init(); await old.scan();
  const running = old.tick(); await waiting;
  const sessionID = f.store.data.tasks[0]!.sessionID;
  controller.abort(); await running; await old.settle();
  assert.equal(f.store.data.tasks[0]!.phase, "running");
  assert.equal(interrupts, 0);
  finished = true; complete();
  const resumed = new OpenCodeExecutor(ctx, options, new AbortController().signal, async () => {});
  f.executor.run = resumed.run.bind(resumed);
  const next = f.make(); await next.init(); await next.tick(); await next.tick();
  assert.equal(next.status()[0]!.status, "done");
  assert.equal(next.status()[0]!.sessionID, sessionID);
  assert.equal(prompts, 1);
  assert.deepEqual(f.events, ["analyze", "comment", "prepare", "verify", "push", "pr"]);
});

function proposalFixture(botLogin = "alice") {
  const f = fixture();
  const comments: Comment[] = [];
  let nextID = 20;
  const addComment = (body: string, login = "alice", type = "User") => {
    const comment = { id: nextID++, body, user: { login, type } };
    comments.push(comment); return comment;
  };
  const request = { ...issue, title: "Questions test", body: "I would like new sorting algorithms in scripts/. Give me some proposals before you start implementing. @deepseek" };
  f.github.issues = async () => [request]; f.github.issue = async () => request;
  f.github.comments = async () => structuredClone(comments);
  f.github.ensureComment = async (_repo, _number, marker, body) => {
    const prior = comments.find(c => c.body.startsWith(marker));
    if (prior) return prior.id;
    const isQuestion = marker.includes(":question:");
    // The decision and pending question must be durable before POST starts.
    if (isQuestion) assert.ok(f.store.data.tasks[0]?.question);
    f.events.push(isQuestion ? "question" : "comment");
    return addComment(`${marker}\n${body}\n\n${botLogin}[OpenCode2]`, botLogin).id;
  };
  f.executor.analyze = async task => {
    f.events.push("analyze");
    if (task.analysisDialogue?.at(-1)?.answer.body === "Implement heapsort only. Use branch develop.") {
      return { kind: "proceed", comment: "I will implement heapsort only, then verify it. Code has not yet been inspected." };
    }
    return { kind: "question", comment: "Proposals: heapsort or a Timsort-style hybrid. Code has not yet been inspected.", question: "Which algorithm should I implement?" };
  };
  return { ...f, comments, addComment };
}

for (const botLogin of ["alice", "automation-service"]) {
  test(`analysis questions wait across scans and restart with ${botLogin === "alice" ? "a shared" : "a separate"} posting account`, async () => {
    const f = proposalFixture(botLogin);
    // An older comment cannot answer a question that has not been posted yet.
    f.addComment("An earlier request");
    let d = f.make(); await d.init(); await d.scan(); await d.tick();
    assert.deepEqual(f.events, ["analyze", "question"]);
    const waiting = d.status()[0]!;
    assert.equal(waiting.status, "waiting"); assert.equal(waiting.phase, "analyzing");
    assert.equal(waiting.question?.purpose, "analysis");
    assert.equal(waiting.sessionID, undefined); assert.equal(waiting.worktree, undefined);
    // All robot posts carry markers, even when the robot uses the person's login.
    f.addComment("<!-- opencode2:owner/repo#1:analysis:v1 --> Implement heapsort only. Use branch develop.", botLogin);
    f.addComment("Implement heapsort only. Use branch develop.", "stranger");
    f.addComment("Implement heapsort only. Use branch develop.", "alice", "Bot");
    f.store.data = Queue.parse(JSON.parse(JSON.stringify(f.store.data)));
    f.advance(); d = f.make(); await d.init();
    for (let i = 0; i < 3; i++) { await d.scan(); await d.tick(); }
    assert.equal(d.status()[0]?.status, "waiting");
    assert.equal(d.status()[0]?.question?.answer, undefined);
    assert.deepEqual(f.events, ["analyze", "question"]);
    const answer = f.addComment("Implement heapsort only. Use branch develop.");
    f.executor.selectBase = async (task, _repo, inputs) => {
      assert.equal(task.analysisDialogue?.[0]?.answer.id, answer.id);
      assert.ok(inputs.some(i => i.text === answer.body));
      return { kind: "branch", branch: "develop" };
    };
    f.executor.run = async task => {
      assert.deepEqual(task.analysisDialogue?.map(d => d.answer.id), [answer.id]);
      assert.equal(task.question, undefined); f.events.push("run");
    };
    await d.scan(); await d.tick();
    assert.equal(d.status()[0]?.status, "done"); assert.equal(d.status()[0]?.baseBranch, "develop");
    assert.deepEqual(d.status()[0]?.pendingFeedback, []);
    assert.deepEqual(f.events, ["analyze", "question", "analyze", "comment", "prepare", "run", "verify", "push", "pr"]);
    await d.scan(); await d.tick();
    assert.equal(f.events.filter(e => e === "run").length, 1);
  });
}

test("an unclear answer asks again instead of authorizing a default, and only a new reply can resolve it", async () => {
  const f = proposalFixture(); let d = f.make();
  await d.init(); await d.scan(); await d.tick();
  const first = d.status()[0]!.question!;
  f.addComment("Not sure yet");
  await d.scan(); await d.tick();
  const second = d.status()[0]!.question!;
  assert.notEqual(second.id, first.id); assert.ok(second.commentID! > first.commentID!);
  assert.equal(d.status()[0]?.status, "waiting");
  assert.equal(d.status()[0]?.analysisDialogue?.length, 1);
  d = f.make(); await d.init(); await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.question?.answer, undefined);
  assert.ok(!f.events.includes("prepare"));
  f.addComment("Implement heapsort only. Use branch develop.");
  await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.status, "done");
  assert.equal(d.status()[0]?.analysisDialogue?.length, 2);
});

test("a lost analysis-question POST response recovers the same comment and a reply seen before reconciliation", async () => {
  const f = proposalFixture(); let d = f.make();
  const post = f.github.ensureComment; let lose = true;
  f.github.ensureComment = async (...args) => {
    const id = await post(...args);
    if (lose) { lose = false; throw new Error("Connection lost after posting"); }
    return id;
  };
  await d.init(); await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.status, "retry_wait");
  assert.equal(d.status()[0]?.question?.commentID, undefined);
  const id = d.status()[0]?.question?.id;
  const reply = f.addComment("Implement heapsort only. Use branch develop.");
  await d.scan(); // Seen before the question's comment ID was reconciled.
  f.advance(); d = f.make(); await d.init(); await d.tick();
  assert.equal(d.status()[0]?.status, "waiting");
  assert.equal(d.status()[0]?.question?.id, id);
  assert.deepEqual(f.events, ["analyze", "question"]);
  await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.status, "done");
  assert.equal(d.status()[0]?.analysisDialogue?.[0]?.answer.id, reply.id);
  assert.deepEqual(d.status()[0]?.pendingFeedback, []);
});

test("a failed model reassessment preserves the accepted reply exactly once across restart", async () => {
  const f = proposalFixture(); let d = f.make();
  await d.init(); await d.scan(); await d.tick();
  f.addComment("Implement heapsort only. Use branch develop.");
  const analyze = f.executor.analyze;
  f.executor.analyze = async () => { throw new Error("Model unavailable"); };
  await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.status, "retry_wait");
  assert.equal(d.status()[0]?.analysisDecision, undefined);
  assert.equal(d.status()[0]?.analysisDialogue?.length, 1);
  assert.ok(!f.events.includes("prepare"));
  f.advance(); f.executor.analyze = analyze; d = f.make(); await d.init(); await d.tick();
  assert.equal(d.status()[0]?.status, "done");
  assert.equal(d.status()[0]?.analysisDialogue?.length, 1);
});

test("a closed issue stays blocked after a clarification reply", async () => {
  const f = proposalFixture(), d = f.make();
  await d.init(); await d.scan(); await d.tick();
  f.addComment("Implement heapsort only. Use branch develop.");
  await d.scan();
  f.github.issue = async () => ({ ...issue, state: "closed" });
  await d.tick();
  assert.equal(d.status()[0]?.status, "blocked"); assert.ok(!f.events.includes("prepare"));
});

test("legacy published prose is reassessed before a worktree is created", async () => {
  const f = proposalFixture(); let d = f.make();
  await d.init(); await d.scan();
  Object.assign(f.store.data.tasks[0]!, { phase: "commented", analysis: "Heapsort or Timsort? Please choose before I start.", commentID: 10 });
  d = f.make(); await d.init(); await d.tick();
  assert.equal(d.status()[0]?.status, "waiting"); assert.ok(!f.events.includes("prepare"));
});

test("invalid analysis decisions never post or start implementation", async () => {
  const f = fixture();
  f.executor.analyze = async () => ({ kind: "proceed", comment: "Plan", question: "Which one?" }) as any;
  const d = f.make(); await d.init(); await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.status, "retry_wait");
  assert.deepEqual(f.events, []);
});

test("a new round requires its own clarification and does not reuse a previous answer", async () => {
  const f = proposalFixture(), d = f.make();
  await d.init(); await d.scan(); await d.tick();
  f.addComment("Implement heapsort only. Use branch develop.");
  await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.status, "done");
  f.github.findPull = async () => ({ number: 2, html_url: "https://github.com/owner/repo/pull/2", state: "open" });
  f.addComment("Propose one more algorithm before implementing it.");
  await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.round, 2); assert.equal(d.status()[0]?.status, "waiting");
  assert.equal(d.status()[0]?.analysisDialogue, undefined);
  assert.equal(d.status()[0]?.question?.answer, undefined);
  assert.equal(f.events.filter(e => e === "run").length, 1);
  assert.equal(f.events.filter(e => e === "push").length, 1);
  assert.equal(f.events.filter(e => e === "pr").length, 1);
});

test("another issue can proceed while an analysis question remains unanswered", async () => {
  const f = proposalFixture(), d = f.make();
  const request = await f.github.issue("owner/repo", 1);
  f.github.issues = async () => [request, { ...issue, number: 2 }];
  f.github.issue = async (_repo, number) => number === 1 ? request : { ...issue, number: 2 };
  const analyze = f.executor.analyze;
  f.executor.analyze = async task => task.issue.number === 1 ? analyze(task) : { kind: "proceed", comment: "Repair the counter and verify it." };
  await d.init(); await d.scan(); await d.tick(); await d.tick();
  assert.equal(d.status()[0]?.status, "waiting");
  assert.equal(d.status()[0]?.sessionID, undefined);
  assert.equal(d.status()[1]?.status, "done");
  assert.equal(f.events.filter(e => e === "run").length, 1);
});

test("routing matches full tags, ignores emails and rejects ambiguous routes", () => {
  assert.deepEqual(matchRoute("(@DEEPSEEK) fix", options.routes), route);
  for (const body of ["x@deepseek", "@@deepseek", "@deepseeker", "@deepseek-extra"]) assert.equal(matchRoute(body, options.routes), undefined);
  assert.throws(() => matchRoute("@deepseek @other", { ...options.routes, "@other": route }), /Multiple/);
});
test("configuration requires explicit authors and accepts skipping tests, but not empty commands", () => {
  assert.throws(() => GithubOptions.parse({ ...options, repositories: [{ ...options.repositories[0], allowedAuthors: [] }] }));
  assert.deepEqual(GithubOptions.parse({ ...options, repositories: [{ ...options.repositories[0], checks: [] }] }).repositories[0]?.checks, []);
  assert.throws(() => GithubOptions.parse({ ...options, repositories: [{ ...options.repositories[0], checks: [[]] }] }));
  assert.throws(() => GithubOptions.parse({ ...options, routes: { "@deepseek": route, "@DEEPSEEK": route } }));
});
test("workflow comments before work and creates a PR only after verification", async () => {
  const f = fixture(), dispatcher = f.make(); await dispatcher.init();
  assert.deepEqual(await dispatcher.scan(), { queued: 1, ignored: 0 });
  await dispatcher.tick();
  assert.deepEqual(f.events, ["analyze", "comment", "prepare", "run", "verify", "push", "pr"]);
  assert.equal(dispatcher.status()[0]?.status, "done");
  const restarted = f.make(); await restarted.init(); await restarted.scan(); await restarted.tick();
  assert.equal(f.events.filter(e => e === "run").length, 1);
});
test("dispatcher emits a start only after a real session is ready, then emits completion", async () => {
  const f = fixture(); const notifications: string[] = [];
  f.executor.run = async (_, checkpoint) => {
    await checkpoint({ sessionID: "ses_test" }); assert.equal(notifications.length, 0);
    await checkpoint({ sessionReady: true }); await checkpoint({ sessionReady: true });
  };
  const d = new Dispatcher(options, f.store, f.github, f.executor, new AbortController().signal, [], () => 1000, async a => { notifications.push(a.status); });
  await d.init(); await d.scan(); await d.tick();
  assert.deepEqual(notifications, ["ready", "done"]);
});
test("failed comment prevents any fix and retries without repeating analysis", async () => {
  const f = fixture(); let count = 0;
  f.github.ensureComment = async () => { f.events.push("comment"); if (++count === 1) throw new Error("network"); return 42; };
  const first = f.make(); await first.init(); await first.scan(); await first.tick();
  assert.deepEqual(f.events, ["analyze", "comment"]);
  assert.equal(first.status()[0]?.phase, "analyzing");
  f.advance(); const second = f.make(); await second.init(); await second.tick();
  assert.equal(f.events.filter(e => e === "analyze").length, 1);
  assert.equal(second.status()[0]?.status, "done");
});
test("concurrent scans and workers do not duplicate a task", async () => {
  const f = fixture(), d = f.make(); await d.init();
  await Promise.all([d.scan(), d.scan(), d.scan()]);
  await Promise.all([d.tick(), d.tick(), d.tick()]);
  assert.equal(d.status().length, 1); assert.equal(f.events.filter(e => e === "run").length, 1);
});
test("authorized comments after a PR start another round and update the same PR once", async () => {
  const f = fixture(); let comments: Awaited<ReturnType<GithubPort["comments"]>> = [];
  const markers: string[] = [];
  f.github.comments = async () => comments;
  f.github.ensureComment = async (_repo, _number, marker) => { markers.push(marker); return markers.length === 1 ? 42 : 44; };
  const d = f.make(); await d.init(); await d.scan(); await d.tick();
  f.github.findPull = async () => ({ number: 2, html_url: "https://github.com/owner/repo/pull/2", state: "open" });
  comments = [{ id: 42, body: "<!-- opencode2:owner/repo#1:analysis:v1 --> bot reply", user: { login: "alice" } }, { id: 43, body: "Also handle an empty counter", user: { login: "alice" } }];
  await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.round, 2);
  assert.equal(d.status()[0]?.pr?.number, 2);
  assert.equal(f.events.filter(e => e === "run").length, 2);
  assert.equal(f.events.filter(e => e === "push").length, 2);
  assert.equal(f.events.filter(e => e === "pr").length, 1);
  assert.match(markers[0]!, /v1/); assert.match(markers[1]!, /v2/);
  const restarted = f.make(); await restarted.init(); await restarted.scan(); await restarted.tick();
  assert.equal(f.events.filter(e => e === "run").length, 2);
});
test("comments arriving during execution wait for the next round", async () => {
  const f = fixture(); let finish!: () => void;
  f.executor.run = async () => { await new Promise<void>(resolve => { finish = resolve; }); };
  const d = f.make(); await d.init(); await d.scan(); const running = d.tick();
  await new Promise(r => setImmediate(r));
  f.github.comments = async () => [{ id: 43, body: "One more requirement", user: { login: "alice" } }];
  await d.scan(); assert.equal(d.status()[0]?.round, 1); assert.equal(d.status()[0]?.pendingFeedback?.length, 1);
  finish(); await running;
  f.executor.run = async () => {};
  f.github.findPull = async () => ({ number: 2, html_url: "https://github.com/owner/repo/pull/2", state: "open" });
  await d.tick(); assert.equal(d.status()[0]?.round, 2); assert.equal(d.status()[0]?.pendingFeedback?.length, 0);
});
test("a tagged authorized comment can start an issue without a tag in its body", async () => {
  const f = fixture();
  f.github.issues = async () => [{ ...issue, body: "Counter broken", user: { login: "external" } }];
  f.github.issue = async () => ({ ...issue, body: "Counter broken", user: { login: "external" } });
  f.github.comments = async () => [{ id: 10, body: "@deepseek please handle this", user: { login: "alice" } }];
  const d = f.make(); await d.init(); await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.source, "comment"); assert.equal(d.status()[0]?.status, "done");
});
test("bot replies and unauthorized feedback never start another round", async () => {
  const f = fixture(), d = f.make(); await d.init(); await d.scan(); await d.tick();
  f.github.comments = async () => [
    { id: 50, body: "<!-- opencode2:owner/repo#1:analysis:v1 --> Plan", user: { login: "alice" } },
    { id: 51, body: "Fix more things", user: { login: "mallory" } },
    { id: 52, body: "Automated reply", user: { login: "alice", type: "Bot" } },
  ];
  await d.scan(); await d.tick(); assert.equal(d.status()[0]?.round, 1);
});
test("feedback for a closed PR is retained and blocked without publishing another PR", async () => {
  const f = fixture(), d = f.make(); await d.init(); await d.scan(); await d.tick();
  f.github.comments = async () => [{ id: 43, body: "Please change this", user: { login: "alice" } }];
  f.github.findPull = async () => ({ number: 2, html_url: "https://github.com/owner/repo/pull/2", state: "closed" });
  await d.scan(); await d.tick(); assert.equal(d.status()[0]?.status, "blocked");
  assert.equal(d.status()[0]?.feedback?.[0]?.id, 43);
  assert.equal(f.events.filter(e => e === "pr").length, 1);
});
test("PR timeout is reconciled after restart without another push or fix", async () => {
  const f = fixture(); let created = false;
  f.github.ensurePull = async () => { created = true; throw new Error("timeout after create"); };
  f.github.findPull = async () => created ? { number: 3, html_url: "https://github.com/owner/repo/pull/3", state: "open" } : undefined;
  const d = f.make(); await d.init(); await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.phase, "publishing");
  f.advance(); const restarted = f.make(); await restarted.init(); await restarted.tick();
  assert.equal(restarted.status()[0]?.status, "done");
  assert.equal(f.events.filter(e => e === "push").length, 1);
  assert.equal(f.events.filter(e => e === "run").length, 1);
});
test("verification failure blocks PR creation and explicit retry resumes verification", async () => {
  const f = fixture(); f.executor.verify = async () => { throw new Blocked("Tests failed"); };
  const d = f.make(); await d.init(); await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.status, "blocked"); assert.ok(!f.events.includes("push"));
  f.executor.verify = async () => ({ checks: ["passed"], commit: "sha" });
  assert.equal(await d.retry("owner/repo#1", false), true); await d.tick();
  assert.equal(d.status()[0]?.status, "done"); assert.equal(f.events.filter(e => e === "run").length, 1);
});
test("scan excludes pull requests and unauthorized issue authors", async () => {
  const f = fixture(); f.github.issues = async () => [{ ...issue, pull_request: {} }, { ...issue, number: 2, user: { login: "mallory" } }];
  const d = f.make(); await d.init(); assert.deepEqual(await d.scan(), { queued: 0, ignored: 2 });
});
test("PR explicitly reports skipped tests without claiming a pass", async () => {
  const f = fixture(); let body = "";
  f.executor.verify = async () => ({ checks: [], commit: "sha" });
  f.github.ensurePull = async (_repo, _branch, _base, _title, text) => {
    body = text;
    return { number: 2, html_url: "https://github.com/owner/repo/pull/2", state: "open" };
  };
  const d = f.make(); await d.init(); await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.status, "done");
  assert.match(body, /Automated tests were not run/);
  assert.ok(!body.includes("passed"));
});
test("closed issue cannot start a fix", async () => {
  const f = fixture(), d = f.make(); await d.init(); await d.scan();
  f.github.issue = async () => ({ ...issue, state: "closed" }); await d.tick();
  assert.equal(d.status()[0]?.status, "blocked"); assert.deepEqual(f.events, []);
});
test("a possibly running session is reconciled before starting another issue", async () => {
  const f = fixture();
  f.github.issues = async () => [issue, { ...issue, number: 2 }];
  f.executor.run = async (_, checkpoint) => { f.events.push("run"); await checkpoint({ sessionID: "ses_live" }); throw new Error("lost connection"); };
  const d = f.make(); await d.init(); await d.scan(); await d.tick(); await d.tick();
  assert.equal(d.status()[0]?.status, "retry_wait");
  assert.equal(d.status()[1]?.phase, "queued");
  assert.equal(f.events.filter(e => e === "run").length, 1);
});
test("scheduler avoids overlap, persists pause and backs off errors", async () => {
  const store = new Memory<Parameters<ConstructorParameters<typeof Scheduler>[1]["save"]>[0]>([]);
  let now = 0, calls = 0; let finish!: () => void;
  const jobs = [Job.parse({ id: "scan", everySeconds: 60 })];
  const scheduler = new Scheduler(jobs, store, async () => { calls++; await new Promise<void>(r => { finish = r; }); throw new Error("unavailable"); }, () => now);
  await scheduler.init(); const pending = scheduler.tick();
  await new Promise(r => setImmediate(r)); await scheduler.tick(); assert.equal(calls, 1);
  finish(); await pending; assert.equal(scheduler.status()[0]?.nextAt, 5000);
  await scheduler.pause("scan", true); now = 100_000;
  const restarted = new Scheduler(jobs, store, async () => { calls++; }, () => now);
  await restarted.init(); await restarted.tick(); assert.equal(calls, 1);
  await restarted.pause("scan", false); await restarted.tick(); assert.equal(calls, 2);
});
test("atomic storage rejects corruption, lock excludes a second owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc2-state-"));
  try {
    const store = new JsonStore(join(dir, "state.json"), z.object({ count: z.number() }), () => ({ count: 0 }));
    assert.deepEqual(await store.load(), { count: 0 }); await store.save({ count: 3 }); assert.deepEqual(await store.load(), { count: 3 });
    const release = await acquire(dir, "test", e => { throw e; });
    await assert.rejects(acquire(dir, "test", e => { throw e; })); await release();
    await writeFile(join(dir, "state.json"), "invalid"); await assert.rejects(store.load());
    assert.equal(await readFile(join(dir, "state.json"), "utf8"), "invalid");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("GitHub paginates and reconciles a comment whose POST response was lost", async () => {
  let posted = false, posts = 0, pages = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/user") return Response.json({ login: "bot" });
    if (url.pathname.endsWith("/comments")) {
      if (init?.method === "POST") { posted = true; posts++; throw new Error("timeout"); }
      return Response.json(posted ? [{ id: 7, body: "marker description", user: { login: "bot" } }] : []);
    }
    pages++; return Response.json(url.searchParams.get("page") === "1" ? Array.from({ length: 100 }, (_, i) => ({ ...issue, number: i + 1 })) : [{ ...issue, number: 101 }]);
  };
  const client = new Github("secret", new AbortController().signal, fetcher);
  assert.equal((await client.issues("owner/repo")).length, 101); assert.equal(pages, 2);
  await assert.rejects(client.ensureComment("owner/repo", 1, "marker", "description"));
  assert.equal(await client.ensureComment("owner/repo", 1, "marker", "description"), 7); assert.equal(posts, 1);
});
test("GitHub honors retry-after without leaking response bodies or tokens", async () => {
  const client = new Github("secret", new AbortController().signal, async () => new Response("secret", { status: 429, headers: { "retry-after": "60" } }));
  await assert.rejects(client.issues("owner/repo"), e => e instanceof GithubError && e.retryAt! >= Date.now() + 59_000 && !e.message.includes("secret"));
});

test("PR publication uses the assessed feature title and preserves it on retry", async () => {
  const f = fixture(); let titles = 0; const published: string[] = [];
  f.executor.title = async t => { assert.equal(t.phase, "publishing"); assert.equal(t.commit, "sha"); titles++; return "Add Python sorting algorithms"; };
  f.github.ensurePull = async (_repo, _branch, _base, title) => {
    published.push(title);
    if (published.length === 1) throw new Error("temporary publication failure");
    return { number: 2, html_url: "https://github.com/owner/repo/pull/2", state: "open" };
  };
  const d = f.make(); await d.init(); await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.status, "retry_wait");
  f.advance(); const resumed = f.make(); await resumed.init(); await resumed.tick();
  assert.equal(titles, 1); assert.deepEqual(published, ["Add Python sorting algorithms", "Add Python sorting algorithms"]);
  assert.equal(resumed.status()[0]?.status, "done");
});

test("failed title assessment never publishes a generic Fix title", async () => {
  const f = fixture(); f.executor.title = async () => { throw new Error("model unavailable"); };
  const d = f.make(); await d.init(); await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.status, "retry_wait"); assert.ok(!f.events.includes("pr")); assert.ok(!f.events.includes("push"));
});

test("completed PR merges once after approval and posts acknowledgement", async () => {
  const f = fixture(); let merges = 0;
  f.github.mergeApproved = async () => { merges++; return true; };
  const d = f.make(); await d.init(); await d.scan(); await d.tick(); await d.tick(); await d.tick();
  assert.equal(merges, 1); assert.equal(d.status()[0]?.merged, true);
  assert.equal(f.events.filter(e => e === "comment").length, 2);
});
test("new issue feedback prevents auto-merge and merge failures remain retryable", async () => {
  const f = fixture(); let merges = 0;
  f.github.mergeApproved = async () => { merges++; throw new Error("checks pending"); };
  const d = f.make(); await d.init(); await d.scan(); await d.tick(); await d.tick();
  assert.match(d.status()[0]?.mergeError ?? "", /checks pending/); assert.equal(d.status()[0]?.status, "done");
  f.advance(); f.github.comments = async () => [{ id: 99, body: "Please change this", user: { login: "alice" } }];
  await d.tick(); assert.equal(merges, 1); assert.equal(d.status()[0]?.pendingFeedback?.length, 1);
});

test("upgraded queues ignore historical approvals until a new watching baseline exists", async () => {
  const f = fixture(); const d = f.make(); await d.init(); await d.scan(); await d.tick();
  delete f.store.data.tasks[0]!.publishedAt;
  let since = 0; f.github.mergeApproved = async (_repo, _number, _commit, baseline) => { since = baseline; return false; };
  const resumed = f.make(); await resumed.init(); f.advance(); await resumed.tick();
  assert.equal(since, 0); const baseline = resumed.status()[0]!.publishedAt!;
  await resumed.tick(); assert.equal(since, baseline); assert.ok(baseline > 1000);
});
test("auto-merge can be disabled independently of issue processing", async () => {
  const f = fixture(); let called = false; f.github.mergeApproved = async () => { called = true; return true; };
  const d = new Dispatcher({ ...options, autoMerge: { ...options.autoMerge, enabled: false } }, f.store, f.github, f.executor, new AbortController().signal);
  await d.init(); await d.scan(); await d.tick(); await d.tick(); assert.equal(called, false); assert.equal(d.status()[0]?.status, "done");
});

for (const merged of [false, true]) {
  test(`scanning detects a manually ${merged ? "merged" : "closed"} PR even with auto-merge disabled and its issue closed`, async () => {
    const f = fixture(); const notifications: ReturnType<Dispatcher["activity"]>[number][] = [];
    const config = { ...options, autoMerge: { ...options.autoMerge, enabled: false } };
    const make = () => new Dispatcher(config, f.store, f.github, f.executor, new AbortController().signal, [], () => 1000, async a => { notifications.push(a); });
    let d = make(); await d.init(); await d.scan(); await d.tick();
    f.github.issues = async () => [];
    f.github.issue = async () => ({ ...issue, state: "closed" });
    f.github.pull = async (_repo, number) => ({ number, html_url: "https://github.com/owner/repo/pull/2", state: "closed", merged });
    await d.scan();
    assert.equal(d.status()[0]?.pr?.state, "closed");
    assert.equal(d.activity()[0]?.phase, merged ? "merged" : "pr_closed");
    assert.equal(notifications.filter(a => a.prState === "closed").length, 1);
    assert.deepEqual(notifications.at(-1)?.sessionIDs, ["ses_test"]);
    f.store.data = Queue.parse(JSON.parse(JSON.stringify(f.store.data)));
    d = make(); await d.init(); await d.scan(); await d.tick();
    assert.equal(d.activity()[0]?.prState, "closed");
    assert.equal(notifications.filter(a => a.prState === "closed").length, 1);
  });
}

test("a failed PR state lookup does not announce closure or change saved state", async () => {
  const f = fixture(), d = f.make(); await d.init(); await d.scan(); await d.tick();
  f.github.pull = async () => { throw new Error("GitHub unavailable"); };
  await assert.rejects(d.scan(), /GitHub unavailable/);
  assert.equal(d.status()[0]?.pr?.state, "open"); assert.equal(d.activity()[0]?.prState, "open");
});

test("main session IDs from every follow-up round survive restart for tab cleanup", async () => {
  const f = fixture(); let session = 0; let d = f.make();
  f.executor.run = async (_task, checkpoint) => { await checkpoint({ sessionID: `ses_${++session}` }); };
  await d.init(); await d.scan(); await d.tick();
  f.github.findPull = async () => ({ number: 2, html_url: "https://github.com/owner/repo/pull/2", state: "open" });
  for (const id of [50, 60]) {
    f.github.comments = async () => [{ id, body: "Please handle one more case", user: { login: "alice" } }];
    await d.scan(); await d.tick();
  }
  f.store.data = Queue.parse(JSON.parse(JSON.stringify(f.store.data)));
  d = f.make(); await d.init();
  assert.deepEqual(d.activity()[0]?.sessionIDs, ["ses_1", "ses_2", "ses_3"]);
});

test("PR state lookup uses the exact PR number and retains merge metadata", async () => {
  const github = new Github("fake", new AbortController().signal, (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://api.github.com/repos/owner/repo/pulls/17");
    assert.equal(init?.method, "GET");
    return new Response(JSON.stringify({ number: 17, html_url: "https://github.com/owner/repo/pull/17", state: "closed", merged: true, merged_at: "2026-09-11T20:00:00Z" }));
  }) as typeof fetch);
  const pr = await github.pull("owner/repo", 17);
  assert.equal(pr.state, "closed"); assert.equal(pr.merged, true);
});

test("issue questions are published once, survive restart, and resume only on an authorized reply", async () => {
  const f = fixture(); let d = f.make();
  f.github.ensureComment = async (_repo, _number, marker) => { f.events.push(marker.includes(":question:") ? "question" : "comment"); return marker.includes(":question:") ? 100 : 42; };
  f.executor.run = async (task, checkpoint) => {
    await checkpoint({ sessionID: "ses_test", promptAttempted: true });
    if (!task.question) { await d.question("ses_test", "q1", "Which color?"); await d.question("ses_test", "q1", "Which color?"); }
    else if (task.question.answer) await checkpoint({ question: { ...task.question, delivered: true, answerSent: true } });
  };
  await d.init(); await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.status, "waiting"); assert.ok(!f.events.includes("verify"));
  assert.equal(f.events.filter(e => e === "question").length, 1);
  d = f.make(); await d.init();
  f.github.comments = async () => [{ id: 101, body: "red", user: { login: "stranger" } }];
  await d.scan(); await d.tick(); assert.equal(d.status()[0]?.status, "waiting");
  f.github.comments = async () => [{ id: 102, body: "blue", user: { login: "alice" } }];
  await d.scan(); assert.equal(d.status()[0]?.question?.answer?.body, "blue");
  await d.tick(); assert.equal(d.status()[0]?.status, "done");
  assert.deepEqual(d.status()[0]?.pendingFeedback, []);
});
test("permission replies require an explicit question-scoped allow or deny", async () => {
  const f = fixture(); const d = f.make();
  f.github.ensureComment = async (_r, _n, marker) => marker.includes(":question:") ? 100 : 42;
  f.executor.run = async (_t, checkpoint) => { await checkpoint({ sessionID: "ses_test" }); await d.question("ses_test", "p1", "May I run this command?", { action: "bash", resources: ["npm test"] }); };
  await d.init(); await d.scan(); await d.tick();
  f.github.comments = async () => [{ id: 101, body: "sure", user: { login: "alice" } }];
  await d.scan(); assert.equal(d.status()[0]?.question?.answer, undefined);
  f.github.comments = async () => [{ id: 102, body: "/allow p1", user: { login: "alice" } }];
  await d.scan(); assert.equal(d.status()[0]?.permissions?.[0]?.allow, true);
});
test("an authorized base directive pins both worktree creation and PR target", async () => {
  const f = fixture(); const branchIssue = { ...issue, body: `${issue.body}\n/base release/next` };
  f.github.issues = async () => [branchIssue]; f.github.issue = async () => branchIssue;
  let prepared = "", published = "";
  f.executor.selectBase = async (_task, _repo, inputs) => {
    assert.ok(inputs.some(i => i.text.includes("/base release/next")));
    return { kind: "branch", branch: "release/next" };
  };
  f.executor.prepare = async (_t, repo) => { prepared = repo.baseBranch; return { worktree: "/worktree", baseSha: "base" }; };
  f.github.ensurePull = async (_r, _h, base) => { published = base; return { number: 2, html_url: "https://github.com/owner/repo/pull/2", state: "open" }; };
  const d = f.make(); await d.init(); await d.scan(); await d.tick();
  assert.equal(prepared, "release/next"); assert.equal(published, "release/next"); assert.equal(d.status()[0]?.baseBranch, "release/next");
});

test("concurrent questions share one post and recover a lost publication response", async () => {
  const f = fixture(); let d = f.make(), posts = 0;
  f.github.ensureComment = async (_r, _n, marker) => {
    if (!marker.includes(":question:")) return 42;
    posts++;
    // Keep the simulated request in flight while both tool calls enter.
    await new Promise<void>(resolve => setImmediate(resolve));
    if (posts === 1) throw new Error("Comment delivery unknown");
    return 100;
  };
  f.executor.run = async (_task, checkpoint) => {
    await checkpoint({ sessionID: "ses_test" });
    await Promise.allSettled([d.question("ses_test", "q1", "Which option?"), d.question("ses_test", "q2", "Duplicate parallel request")]);
  };
  await d.init(); await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.status, "waiting"); assert.equal(posts, 1);
  assert.equal(d.status()[0]?.question?.commentID, undefined);
  d = f.make(); await d.init(); await d.tick();
  assert.equal(posts, 2); assert.equal(d.status()[0]?.question?.commentID, 100);
  f.github.comments = async () => [{ id: 101, body: "The second option", user: { login: "alice" } }];
  await d.scan(); assert.equal(d.status()[0]?.status, "ready");
  assert.equal(d.status()[0]?.question?.answer?.id, 101);
});

test("an ambiguous natural-language base waits in the issue before creating a worktree and survives restart", async () => {
  const f = fixture(); let d = f.make(), selections = 0;
  const request = { ...issue, body: `${issue.body}. Please work from develop or release/next.` };
  f.github.issues = async () => [request]; f.github.issue = async () => request;
  f.github.ensureComment = async (_r, _n, marker) => { f.events.push(marker.includes(":question:") ? "question" : "comment"); return marker.includes(":question:") ? 100 : 42; };
  f.executor.selectBase = async (task, _repo, inputs) => {
    selections++;
    assert.equal(task.sessionID, undefined); assert.equal(task.worktree, undefined);
    if (!task.baseDialogue?.length) return { kind: "question", question: "Should I use develop or release/next as the base?" };
    assert.equal(inputs.at(-1)?.text, "Use branch release/next, please.");
    assert.match(inputs.at(-1)?.question ?? "", /develop or release/);
    return { kind: "branch", branch: "release/next" };
  };
  f.executor.hasBranch = async (_r, branch) => { assert.equal(branch, "release/next"); return true; };
  f.executor.prepare = async (task, repo) => { assert.equal(task.baseBranch, "release/next"); assert.equal(repo.baseBranch, "release/next"); f.events.push("prepare"); return { worktree: "/worktree", baseSha: "base" }; };
  await d.init(); await d.scan(); await d.tick();
  assert.deepEqual(f.events, ["analyze", "comment", "question"]);
  assert.equal(d.status()[0]?.status, "waiting"); assert.equal(d.status()[0]?.question?.sessionID, undefined);
  d = f.make(); await d.init(); await d.tick(); assert.equal(selections, 1);
  f.github.comments = async () => [{ id: 101, body: "Use branch attack", user: { login: "stranger" } }];
  await d.scan(); await d.tick(); assert.equal(selections, 1);
  f.github.comments = async () => [{ id: 102, body: "Use branch release/next, please.", user: { login: "alice" } }];
  await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.status, "done"); assert.equal(selections, 2);
  assert.deepEqual(d.status()[0]?.pendingFeedback, []); assert.equal(d.status()[0]?.baseDialogue?.[0]?.answer.id, 102);
  assert.equal(f.events.filter(e => e === "analyze").length, 1);
});

test("a missing requested base asks for a correction; Git transport errors do not masquerade as a missing branch", async () => {
  const f = fixture();
  f.executor.selectBase = async () => ({ kind: "branch", branch: "develpo" });
  f.executor.hasBranch = async () => false;
  const d = f.make(); await d.init(); await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.status, "waiting"); assert.equal(d.status()[0]?.baseBranch, undefined);
  assert.match(d.status()[0]?.question?.text ?? "", /develpo.*does not exist/);
  assert.ok(!f.events.includes("prepare"));
  const broken = fixture(); broken.executor.hasBranch = async () => { throw new Error("Git authentication failed"); };
  const retrying = broken.make(); await retrying.init(); await retrying.scan(); await retrying.tick();
  assert.equal(retrying.status()[0]?.status, "retry_wait"); assert.equal(retrying.status()[0]?.question, undefined);
});

test("only authorized text reaches base selection and a selected base is pinned across retries", async () => {
  const f = fixture(); let selections = 0, prepares = 0;
  const request = { ...issue, body: "Use branch attacker", user: { login: "stranger" } };
  f.github.issues = async () => [request]; f.github.issue = async () => request;
  f.github.comments = async () => [{ id: 1, body: "@deepseek Please use branch develop.", user: { login: "alice" } }];
  f.executor.selectBase = async (_t, _r, inputs) => { selections++; assert.deepEqual(inputs, [{ text: "@deepseek Please use branch develop." }]); return { kind: "branch", branch: "develop" }; };
  f.executor.prepare = async (_t, repo) => { assert.equal(repo.baseBranch, "develop"); if (++prepares === 1) throw new Error("Temporary failure"); return { worktree: "/worktree", baseSha: "base" }; };
  let d = f.make(); await d.init(); await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.baseBranch, "develop");
  f.advance(); d = f.make(); await d.init(); await d.tick();
  assert.equal(selections, 1); assert.equal(d.status()[0]?.status, "done");
});

test("a failed branch-question post is recovered after restart without another model selection", async () => {
  const f = fixture(); let selections = 0, posts = 0;
  f.executor.selectBase = async () => { selections++; return { kind: "question", question: "Which branch should I use?" }; };
  f.github.ensureComment = async (_r, _n, marker) => {
    if (!marker.includes(":question:")) return 42;
    if (++posts === 1) throw new Error("Connection lost after posting");
    return 100;
  };
  let d = f.make(); await d.init(); await d.scan(); await d.tick();
  assert.equal(d.status()[0]?.status, "retry_wait"); assert.equal(d.status()[0]?.question?.purpose, "base");
  f.advance(); d = f.make(); await d.init(); await d.tick();
  assert.equal(d.status()[0]?.status, "waiting"); assert.equal(d.status()[0]?.question?.commentID, 100);
  assert.equal(selections, 1); assert.equal(posts, 2); assert.ok(!f.events.includes("prepare"));
});

for (const legacy of [true, false]) {
  test(`a manually completed stopped session publishes and consumes queued feedback after owner restart (${legacy ? "legacy" : "typed"} checkpoint)`, async () => {
    const f = fixture();
    let completed = false, prompts = 0;
    const ctx = { session: {
      get: async () => ({ location: { directory: "/worktree" }, outcome: completed ? "succeeded" : "interrupted" }),
      wait: async () => {},
      context: async () => [{ type: "user", text: "opencode2-task:owner/repo#1" }, { type: "assistant", finish: "stop" }],
      prompt: async () => { prompts++; },
    } } as unknown as Plugin.Context;
    const executor = new OpenCodeExecutor(ctx, options, new AbortController().signal, async () => {});
    f.executor.run = executor.run.bind(executor); f.executor.completed = executor.completed.bind(executor);
    let d = f.make(); await d.init(); await d.scan(); await d.tick();
    assert.equal(d.status()[0]!.status, "blocked");
    assert.equal(f.events.includes("push"), false);
    const saved = d.status()[0]!;
    if (legacy) {
      delete f.store.data.tasks[0]!.sessionStopped;
      f.store.data.tasks[0]!.error = "Error: Session timed out and was interrupted; inspect it before retrying";
    }
    f.github.comments = async () => [{ id: 100, body: "Revise the visual design on the existing PR", user: { login: "alice" } }];
    d = f.make(); await d.init(); await d.scan();
    assert.equal(d.status()[0]!.pendingFeedback?.[0]?.id, 100);
    f.advance(); await d.tick(); // A stop alone never resumes the model.
    assert.equal(prompts, 1); assert.equal(d.status()[0]!.status, "blocked");
    completed = true; f.advance();
    f.store.data = Queue.parse(JSON.parse(JSON.stringify(f.store.data)));
    d = f.make(); await d.init(); await d.tick();
    assert.equal(d.status()[0]!.status, "done");
    assert.equal(d.status()[0]!.sessionID, saved.sessionID);
    assert.equal(d.status()[0]!.worktree, saved.worktree);
    assert.equal(d.status()[0]!.branch, saved.branch);
    assert.equal(prompts, 1);
    assert.deepEqual(f.events.slice(-3), ["verify", "push", "pr"]);
    f.github.findPull = async () => ({ number: 2, html_url: "https://github.com/owner/repo/pull/2", state: "open" });
    await d.tick(); await d.tick();
    assert.equal(d.status()[0]!.round, 2);
    assert.equal(d.status()[0]!.feedback?.[0]?.id, 100);
    assert.deepEqual(d.status()[0]!.pendingFeedback, []);
    assert.equal(d.status()[0]!.branch, saved.branch);
    assert.equal(d.status()[0]!.pr?.number, 2);
    assert.equal(prompts, 2); // Exactly one new prompt for the new feedback round.
    assert.equal(f.events.filter(e => e === "push").length, 2);
  });
}

test("automatic session reconciliation never bypasses a failed check or unresolved permission", async () => {
  const f = fixture();
  f.executor.run = async (_task, checkpoint) => { await checkpoint({ sessionID: "ses_saved", promptAttempted: true }); throw new Blocked("Session did not complete successfully; inspect its outcome and permissions"); };
  f.executor.completed = async () => true;
  let d = f.make(); await d.init(); await d.scan(); await d.tick();
  f.store.data.tasks[0]!.question = { id: "permission", text: "Allow?", sessionID: "ses_saved", permission: { action: "shell", resources: ["deploy"] } };
  f.advance(); d = f.make(); await d.init(); await d.tick();
  assert.equal(d.status()[0]!.status, "blocked");
  await assert.rejects(d.restartWorkflow("owner/repo#1"), /pending question or permission/);
  delete f.store.data.tasks[0]!.question;
  f.executor.run = async () => {};
  f.executor.verify = async () => { f.events.push("verify"); throw new Blocked("Verification failed: npm test"); };
  f.advance(); d = f.make(); await d.init(); await d.tick();
  assert.equal(d.status()[0]!.phase, "verifying");
  f.advance(); await d.tick();
  assert.equal(f.events.filter(e => e === "verify").length, 1);
  assert.equal(f.events.includes("push"), false);
  await d.restartWorkflow("owner/repo#1"); await d.tick();
  assert.equal(f.events.filter(e => e === "verify").length, 2);
  assert.equal(f.events.includes("push"), false);
});

test("restartworkflow persists one recovery request without resetting session, worktree, PR, or feedback", async () => {
  const f = fixture();
  f.executor.run = async (_task, checkpoint) => { await checkpoint({ sessionID: "ses_saved", promptAttempted: true }); throw new Blocked("Session did not complete successfully; inspect its outcome and permissions"); };
  let d = f.make(); await d.init(); await d.scan(); await d.tick();
  const saved = d.status()[0]!;
  assert.equal(await d.restartWorkflow(saved.key), true);
  const id = d.status()[0]!.recovery?.id; assert.ok(id);
  assert.equal(await d.restartWorkflow(saved.key), false);
  f.store.data = Queue.parse(JSON.parse(JSON.stringify(f.store.data)));
  d = f.make(); await d.init();
  const recovered = d.status()[0]!;
  for (const key of ["sessionID", "worktree", "branch", "baseSha", "phase", "promptAttempted"] as const) assert.equal(recovered[key], saved[key]);
  assert.equal(recovered.recovery?.id, id);
  assert.equal(f.events.includes("cancel"), false);
  f.executor.run = async task => { assert.equal(task.recovery?.id, id); };
  await d.tick();
  assert.equal(d.status()[0]!.status, "done");
  assert.equal(d.status()[0]!.recovery, undefined);
  assert.equal(await d.restartWorkflow(saved.key), false);
});

test("monitor reports in-flight discovery and redacts scan failures without changing queue state", async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.github.issues = () => new Promise((_resolve, fail) => { reject = fail; });
  const d = new Dispatcher(options, f.store, f.github, f.executor, new AbortController().signal, ["TOPSECRET"], () => 1000);
  await d.init(); const scan = d.scan();
  assert.equal(d.monitor().scanning, true); assert.equal(d.monitor().lastScanStarted, 1000);
  reject(new Error("TOPSECRET failed")); await assert.rejects(scan);
  assert.equal(d.monitor().scanning, false); assert.equal(d.monitor().lastScanFinished, 1000);
  assert.doesNotMatch(d.monitor().scanError!, /TOPSECRET/); assert.match(d.monitor().scanError!, /REDACTED/);
  assert.deepEqual(d.status(), []); assert.equal(d.monitor().worker, "idle");
});
test("monitor identifies the actual executing task and returns to idle after publication", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const running = new Promise<void>(r => { entered = r; }), wait = new Promise<void>(r => { release = r; });
  f.executor.run = async () => { entered(); await wait; };
  const d = f.make(); await d.init(); await d.scan(); const tick = d.tick(); await running;
  assert.equal(d.monitor().worker, "executing"); assert.equal(d.monitor().activeTask, "owner/repo#1");
  assert.equal(d.monitor().tasks[0]!.phase, "running");
  assert.deepEqual(d.monitor(), JSON.parse(JSON.stringify(d.monitor())));
  release(); await tick;
  assert.equal(d.monitor().worker, "idle"); assert.equal(d.monitor().activeTask, undefined);
  assert.equal(d.monitor().tasks[0]!.status, "done");
});

test("closing a stale task preserves work and stops discovery even when issue and PR are gone", async () => {
  const f = fixture(), d = f.make(); await d.init(); await d.scan(); await d.tick();
  const before = d.status()[0]!;
  await d.closeTask(before.key); await d.settle();
  assert.equal(d.status()[0]!.status, "closed");
  for (const field of ["worktree", "branch", "sessionID", "commit", "phase"] as const) assert.equal(d.status()[0]![field], before[field]);
  f.github.issues = async () => [issue];
  f.github.issue = f.github.pull = async () => { throw new Error("Deleted from GitHub"); };
  f.github.comments = async () => { throw new Error("Must not fetch comments for closed task"); };
  const next = f.make(); await next.init(); await next.scan(); await next.tick();
  assert.equal(next.status().length, 1); assert.equal(next.status()[0]!.status, "closed");
  assert.equal(next.runtime(before.sessionID!), null);
  await assert.rejects(next.restartWorkflow(before.key), /tracking is closed/);
  assert.equal(await next.closeTask(before.key), false);
  assert.equal(await next.retry(before.key, true), false);
});

test("close interrupts an active session and a late checkpoint cannot verify or publish", async () => {
  const f = fixture(); let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(r => { entered = r; }), pending = new Promise<void>(r => { finish = r; });
  f.executor.run = async (_, checkpoint) => { await checkpoint({ sessionID: "ses_active" }); entered(); await pending; await checkpoint({ sessionReady: true }); };
  f.executor.cancel = async (_task, related) => { assert.equal(related, true); finish(); };
  const d = f.make(); await d.init(); await d.scan(); const work = d.tick(); await started;
  await d.closeTask("owner/repo#1"); await work; await d.settle();
  assert.equal(d.status()[0]!.status, "closed");
  assert.equal(d.status()[0]!.sessionID, "ses_active");
  assert.ok(!f.events.includes("verify")); assert.ok(!f.events.includes("push"));
});

test("closure failures stay visible and restart retries without resuming implementation", async () => {
  const f = fixture(), d = f.make(); await d.init(); await d.scan();
  f.executor.cancel = async () => { throw new Error("Interrupt connection failed"); };
  await d.closeTask("owner/repo#1"); await d.settle();
  assert.equal(d.status()[0]!.status, "closing"); assert.match(d.activity()[0]!.error!, /Interrupt connection/);
  f.executor.cancel = async () => {};
  f.advance(); const next = f.make(); await next.init(); await next.tick(); await next.settle();
  assert.equal(next.status()[0]!.status, "closed"); assert.deepEqual(f.events, []);
});

test("closing a waiting task retains question and feedback but accepts no later runtime actions", async () => {
  const f = fixture(), d = f.make(); await d.init(); await d.scan();
  f.executor.run = async (_task, checkpoint) => { await checkpoint({ sessionID: "ses_test" }); await d.question("ses_test", "q1", "Need permission"); throw new Error("Stopped"); };
  await d.tick(); const previous = d.status()[0]!;
  await d.closeTask(previous.key); await d.settle();
  assert.deepEqual(d.status()[0]!.question, previous.question);
  await assert.rejects(d.question("ses_test", "q2", "Again"), /No active/);
  await assert.rejects(d.helper("ses_test", "h1", "vision"), /No active/);
});

test("closure refuses an in-flight publication without claiming to undo a remote push", async () => {
  const f = fixture(); let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(r => { entered = r; }), pending = new Promise<void>(r => { finish = r; });
  f.executor.push = async () => { entered(); await pending; };
  const d = f.make(); await d.init(); await d.scan(); const work = d.tick(); await started;
  await assert.rejects(d.closeTask("owner/repo#1"), /already in flight/);
  assert.equal(d.status()[0]!.status, "ready");
  finish(); await work;
  await d.closeTask("owner/repo#1"); await d.settle(); assert.equal(d.status()[0]!.status, "closed");
});

test("closure during verification waits for local work and prevents the following push", async () => {
  const f = fixture(); let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(r => { entered = r; }), pending = new Promise<void>(r => { finish = r; });
  f.executor.verify = async () => { entered(); await pending; return { checks: ["passed"], commit: "saved-locally" }; };
  const d = f.make(); await d.init(); await d.scan(); const work = d.tick(); await started;
  await d.closeTask("owner/repo#1");
  assert.equal(d.status()[0]!.status, "closing");
  assert.equal(d.monitor().worker, "maintenance");
  finish(); await work; await d.settle();
  assert.equal(d.status()[0]!.status, "closed");
  assert.equal(f.events.includes("push"), false); assert.equal(f.events.includes("pr"), false);
});
