import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { Plugin } from "@opencode/plugin";
import { cleanup, heartbeat, touchOwner, type OwnerClient } from "../src/lifecycle.js";
import github from "../src/plugins/github.js";
import scheduler from "../src/plugins/scheduler.js";
import { acquire } from "../src/state.js";
import { runtimeBridge } from "../src/bridge.js";

test("cleanup settles work and releases ownership even after disposal failures", async () => {
  const steps: string[] = [];
  const failure = new Error("SDK scope was evicted");
  await assert.rejects(cleanup(
    async () => { steps.push("settled"); },
    () => { steps.push("dispose"); throw failure; },
    () => { steps.push("bridge removed"); },
    () => { steps.push("lock released"); },
  ), (error: AggregateError) => error.errors[0] === failure);
  assert.deepEqual(steps, ["settled", "dispose", "bridge removed", "lock released"]);
});

for (const kind of ["github", "scheduler"] as const) {
  test(`${kind} plugin releases its actual lock when RPC disposal rejects`, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "oc2-lifecycle-")));
    const tokenName = "OC2_LIFECYCLE_TEST_TOKEN";
    process.env[tokenName] = "test-token";
    const rpc = Object.assign(() => ({ scan: async () => ({}) }), {
      register: async () => ({ dispose: async () => { throw new Error("evicted registration"); }, events: { emit: async () => {} } }),
    });
    const options = kind === "github" ? {
      tokenEnv: tokenName, ownerDirectory: directory, stateDirectory: directory,
      autoMerge: { enabled: false },
      repositories: [{ repo: "owner/repo", directory, baseBranch: "main", allowedAuthors: ["alice"], checks: [] }],
      routes: { "@bot": { model: { providerID: "test", id: "model" } } },
    } : { ownerDirectory: directory, stateDirectory: directory, jobs: [{ id: "scan", everySeconds: 60 }] };
    try {
      const plugin = kind === "github" ? github : scheduler;
      const stop = await plugin.setup({ location: { directory }, options, rpc } as unknown as Plugin.Context);
      assert.ok(stop);
      await assert.rejects(async () => stop(), /Automation cleanup failed/);
      const release = await acquire(directory, kind, () => {});
      await release();
      assert.equal(runtimeBridge(directory), undefined);
    } finally {
      delete process.env[tokenName];
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("owner heartbeat only touches the matching service process and owner directory", async () => {
  const calls: string[] = [];
  let pid = process.pid + 1;
  const client: OwnerClient = {
    health: { get: async () => ({ pid }) },
    plugin: { list: async ({ location }) => { calls.push(location.directory); } },
  };
  const signal = new AbortController().signal;
  assert.equal(await touchOwner("/owner", signal, async () => undefined), false);
  assert.equal(await touchOwner("/owner", signal, async () => client), false);
  assert.deepEqual(calls, []);
  pid = process.pid;
  assert.equal(await touchOwner("/owner", signal, async () => client), true);
  assert.deepEqual(calls, ["/owner"]);
});

test("heartbeat does not overlap requests and aborts pending work on cleanup", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  let pendingSignal: AbortSignal | undefined;
  const errors: unknown[] = [];
  const stop = heartbeat(signal => {
    calls++;
    pendingSignal = signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, error => errors.push(error));
  t.mock.timers.tick(30_000);
  await setImmediate();
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(calls, 1);
  await stop();
  assert.equal(pendingSignal?.aborted, true);
  assert.deepEqual(errors, []);
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(calls, 1);
});

test("heartbeat retries after a transient failure", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const errors: unknown[] = [];
  const stop = heartbeat(async () => { if (++calls === 1) throw new Error("connection lost"); }, error => errors.push(error));
  try {
    t.mock.timers.tick(30_000);
    await setImmediate();
    t.mock.timers.tick(30_000);
    await setImmediate();
    assert.equal(calls, 2);
    assert.equal(errors.length, 1);
  } finally { await stop(); }
});
