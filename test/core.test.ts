import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { GithubOptions, Job, matchRoute } from "../src/config.js";
import { Scheduler } from "../src/scheduler.js";
import { Dispatcher, Blocked, type Queue, type Executor, type GithubPort } from "../src/dispatcher.js";
import { JsonStore, acquire, type Store } from "../src/state.js";
import { Github, GithubError, type Issue } from "../src/github.js";

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
    ensurePull: async () => { events.push("pr"); return { number: 2, html_url: "https://github.com/owner/repo/pull/2", state: "open" }; },
  };
  const executor: Executor = {
    title: async () => "Repair counter increment",
    analyze: async () => { events.push("analyze"); return "Problem and verification plan"; },
    prepare: async () => { events.push("prepare"); return { worktree: "/worktree", baseSha: "base" }; },
    run: async (_, checkpoint) => { events.push("run"); await checkpoint({ sessionID: "ses_test" }); },
    verify: async () => { events.push("verify"); return { checks: ["npm test passed"], commit: "sha" }; },
    push: async () => { events.push("push"); }, cancel: async () => { events.push("cancel"); },
  };
  const make = () => new Dispatcher(options, store, github, executor, new AbortController().signal, [], () => time);
  return { events, store, github, executor, make, advance: () => { time += 4_000_000; } };
}

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
