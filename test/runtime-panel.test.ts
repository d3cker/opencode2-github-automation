import test from "node:test";
import assert from "node:assert/strict";
import { RuntimePoller, runtimeLines, selectedTask, type RuntimeSnapshot } from "../src/runtime-panel.js";
const snapshot: RuntimeSnapshot = {
  dispatcherAt: 1000, schedulerAt: 1000,
  dispatcher: { ownerDirectory: "/repo", worker: "executing", activeTask: "owner/repo#1", scanning: true, tasks: [
    { key: "owner/repo#1", repo: "owner/repo", issueNumber: 1, round: 3, status: "ready", phase: "verifying", sessionReady: true, sessionID: "one", prNumber: 2, prState: "open", pendingFeedback: 2 },
    { key: "owner/repo#3", repo: "owner/repo", issueNumber: 3, round: 1, status: "waiting", phase: "running", sessionReady: true, sessionID: "two", sessionIDs: ["helper"], question: "permission" },
  ] },
  scheduler: [{ id: "github-issues", running: false, paused: true, nextAt: 6000, failures: 0 }],
};
const text = (state = snapshot, now = 1000, sessionID?: string) => runtimeLines(state, now, sessionID).map(l => l.text).join("\n");
test("sidebar distinguishes worker execution, paused polling and the selected task", () => {
  assert.match(text(), /Dispatcher: Verifying changes/); assert.match(text(), /Scheduler: Paused/);
  assert.match(text(), /Feedback: 2/);
  assert.match(text(), /Queue: 0 scheduled · 1 waiting/);
  assert.equal(selectedTask(snapshot, "helper")?.key, "owner/repo#3");
  assert.match(text(snapshot, 1000, "two"), /Waiting for permission/);
  assert.equal(selectedTask(snapshot, "unrelated")?.key, "owner/repo#1");
});
test("initial, stale and failed status never masquerade as a healthy idle bot", () => {
  assert.match(text({}), /Connecting to owner/); assert.doesNotMatch(text({}), /Dispatcher: Idle/);
  const old = text(snapshot, 17000);
  assert.match(old, /Last dispatcher/); assert.match(old, /STALE \/ partial data/);
  assert.match(text({ dispatcherError: "network" }), /Dispatcher unavailable/);
  assert.match(text({ ...snapshot, schedulerError: "network" }), /Last Scheduler/);
});
test("labels sanitize terminal controls and distinguish scheduled retries from model execution", () => {
  const state = structuredClone(snapshot);
  state.dispatcher!.worker = "idle"; delete state.dispatcher!.activeTask;
  state.dispatcher!.tasks[0] = { ...state.dispatcher!.tasks[0]!, status: "retry_wait", nextAt: 12000, branch: "\u001b[31mbranch\nname", error: "\u001b[2Jtest failed", recovery: true };
  const result = text(state, 1000, "one");
  assert.match(result, /Retry in 11s/); assert.match(result, /Workflow recovery requested/);
  assert.match(result, /Branch: branch name/); assert.equal(result.includes("\u001b"), false);
});
test("independent status failures preserve last known data and recover without replacing successful snapshots", async () => {
  let now = 1000, dispatcherFails = false, schedulerFails = false;
  const poller = new RuntimePoller(async () => { if (dispatcherFails) throw new Error("network"); return snapshot.dispatcher; }, async () => { if (schedulerFails) throw new Error("network"); return snapshot.scheduler; }, () => now);
  try {
    await poller.refresh(); assert.equal(poller.get().dispatcherAt, 1000);
    dispatcherFails = true; now = 6000; await poller.refresh();
    assert.ok(poller.get().dispatcherError); assert.equal(poller.get().dispatcherAt, 1000); assert.equal(poller.get().schedulerAt, 6000);
    dispatcherFails = false; schedulerFails = true; now = 11000; await poller.refresh();
    assert.equal(poller.get().dispatcherError, undefined); assert.equal(poller.get().dispatcherAt, 11000);
    assert.ok(poller.get().schedulerError); assert.equal(poller.get().schedulerAt, 6000);
  } finally { poller.stop(); }
});
test("refresh coalesces concurrent calls and disposal cancels ignored SDK waits without late updates", async () => {
  let reads = 0, changes = 0;
  let resolve!: (value: unknown) => void;
  const pending = new Promise(r => { resolve = r; });
  const poller = new RuntimePoller(async () => { reads++; return pending; }, async () => snapshot.scheduler);
  poller.subscribe(() => { changes++; });
  const first = poller.refresh(); assert.equal(poller.refresh(), first);
  await new Promise(r => setImmediate(r)); assert.equal(reads, 1);
  poller.stop(); await first;
  resolve(snapshot.dispatcher); await new Promise(r => setImmediate(r));
  assert.equal(changes, 1); assert.deepEqual(poller.get(), {});
});

test("sidebar names attention tasks and excludes locally closed tasks from live counts", () => {
  const state = structuredClone(snapshot);
  state.dispatcher!.tasks[0] = { ...state.dispatcher!.tasks[0]!, status: "closed" };
  state.dispatcher!.tasks[1] = { ...state.dispatcher!.tasks[1]!, status: "blocked", error: "Session stopped" };
  delete state.dispatcher!.activeTask;
  assert.match(text(state), /owner\/repo#3: blocked · Session stopped/);
  assert.match(text(state), /Queue: 0 scheduled · 0 waiting/);
  assert.match(text(state), /1 blocked\/failed/);
  assert.equal(selectedTask(state)?.key, "owner/repo#3");
});
