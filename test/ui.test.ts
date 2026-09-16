import test from "node:test";
import assert from "node:assert/strict";
import type { Plugin } from "@opencode/plugin/tui";
import { setupUI } from "../src/ui.js";
import type { Activity } from "../src/activity.js";

const activity: Activity = { key: "owner/repo#1", repo: "owner/repo", issueNumber: 1, round: 1, phase: "running", status: "ready", sessionID: "ses_test", sessionReady: true, worktree: "/worktree" };
function fixture(initial: Activity[] = [], restored: string[] = []) {
  const recovered: string[] = [], alerts: unknown[] = [], ended: string[] = [];
  const choices: (string | undefined)[] = [];
  let recoveryError: Error | undefined;
  let repositoriesError = false;
  const repositoryRequests: unknown[] = [];
  const repositoryReport = { entries: [{ ownerDirectory: "/remote/owner", directory: "/remote/project", stateDirectory: "/remote/state", repo: "remote/repo", baseBranch: "devel", registeredAt: 0, status: "not-running" }], warnings: [] };
  const commands = new Map<string, () => Promise<void>>();
  const toasts: unknown[] = [], opened: string[] = [], navigated: unknown[] = [], closed: string[] = [];
  const tabs = new Map(restored.map(sessionID => [sessionID, { sessionID, busy: false }]));
  let enabled = true;
  let listener!: (event: { location: { directory: string }; data: Activity }) => void;
  let command!: () => Promise<void>, unsubscribed = false;
  const context = {
    location: { directory: "/repo" },
    client: { rpc: () => ({ repositories: async (_input: unknown, request: unknown) => { repositoryRequests.push(request); if (repositoriesError) throw new Error("Unavailable"); return repositoryReport; }, activity: async () => initial, close: async ({ key }: { key: string }) => { ended.push(key); return { accepted: true }; }, restartworkflow: async ({ key }: { key: string }) => { if (recoveryError) throw recoveryError; recovered.push(key); return { accepted: true }; }, events: { on: (_name: string, cb: typeof listener) => { listener = cb; return () => { unsubscribed = true; }; } } }) },
    data: { session: { sync: async () => {} } },
    keymap: { layer: (get: () => { commands: { slash: { name: string }; run: () => Promise<void> }[] }) => { command = get().commands[0]!.run; for (const cmd of get().commands) commands.set(cmd.slash.name, cmd.run); } },
    ui: {
      slot: (claim: { render: () => unknown }) => { claim.render(); return () => {}; },
      toast: { show: (value: unknown) => toasts.push(value) },
      tabs: {
        enabled: () => enabled, list: () => [...tabs.values()],
        open: (id: string) => { if (!enabled) return false; opened.push(id); tabs.set(id, { sessionID: id, busy: false }); return true; }, focus: () => false,
        close: (id: string) => { assert.equal(typeof id, "string"); if (!tabs.delete(id)) return false; closed.push(id); return true; },
      },
      router: { navigate: (value: unknown) => navigated.push(value) },
      dialog: { select: async (input: { options: { value: string }[] }) => choices.length ? choices.shift() : input.options.some(o => o.value === activity.key) ? activity.key : "open", alert: async (value: unknown) => { alerts.push(value); } },
    },
  } as unknown as Plugin.Context;
  const stop = setupUI(context)!;
  return { repositoryRequests, repositoriesError: () => { repositoriesError = true; }, ended, choose: (...values: (string | undefined)[]) => choices.push(...values), recovered, alerts, recoveryError: (error: Error) => { recoveryError = error; }, restart: () => commands.get("restartworkflow")!(), toasts, opened, navigated, closed, tabs, enableTabs: (value: boolean) => { enabled = value; }, stop, unsubscribed: () => unsubscribed, command: () => command(), event: (data: Activity, directory = "/repo") => listener({ data, location: { directory } }) };
}

test("a start event opens a background tab once without navigating the current conversation", async () => {
  const f = fixture();
  try {
    f.event(activity); f.event(activity);
    assert.deepEqual(f.opened, ["ses_test"]); assert.equal(f.toasts.length, 1); assert.equal(f.navigated.length, 0);
    assert.match(JSON.stringify(f.toasts[0]), /OpenCode Automation/);
    assert.match(JSON.stringify(f.toasts[0]), /Working on/);
    f.event({ ...activity, key: "other/repo#1" }, "/other"); assert.equal(f.opened.length, 1);
    await f.command(); assert.deepEqual(f.navigated, [{ type: "session", sessionID: "ses_test" }]);
    f.event({ ...activity, status: "done", phase: "pr_opened" }); assert.equal(f.toasts.length, 2);
    f.event({ ...activity, round: 2, sessionID: "ses_next" }); assert.deepEqual(f.opened, ["ses_test", "ses_next"]);
  } finally { f.stop(); }
  assert.equal(f.unsubscribed(), true);
  f.event({ ...activity, round: 3 }); assert.equal(f.opened.length, 2);
});
test("opening the TUI restores a running task but does not toast historical completions", async () => {
  const f = fixture([activity, { ...activity, key: "owner/repo#2", status: "done", phase: "pr_opened" }]);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.opened, ["ses_test"]); assert.equal(f.toasts.length, 1);
  } finally { f.stop(); }
});

test("activity payloads contain JSON values only, including tasks with missing optional fields", async () => {
  const { activityOf } = await import("../src/activity.js");
  const row = activityOf({ key: "owner/repo#1", repo: "owner/repo", issue: { number: 1 }, phase: "queued", status: "ready" } as import("../src/dispatcher.js").Task);
  assert.deepEqual(row, JSON.parse(JSON.stringify(row)));
});

for (const phase of ["pr_closed", "merged"]) {
  test(`${phase} closes related tabs once and leaves unrelated sessions available`, async () => {
    const f = fixture([], ["ses_unrelated"]);
    try {
      f.event(activity);
      f.event({ ...activity, status: "done", phase: "pr_opened", prState: "open" });
      assert.deepEqual(f.closed, []); // Opening a PR is not completion of its review.
      const final = { ...activity, status: "done", phase, prState: "closed" };
      f.event(final); f.event(final);
      assert.deepEqual(f.closed, ["ses_test"]); assert.ok(f.tabs.has("ses_unrelated"));
      f.tabs.set("ses_test", { sessionID: "ses_test", busy: false }); // Manually reopened from history.
      f.event(final); assert.equal(f.closed.length, 1); assert.ok(f.tabs.has("ses_test"));
      await f.command(); assert.deepEqual(f.navigated.at(-1), { type: "session", sessionID: "ses_test" });
    } finally { f.stop(); }
  });
}

test("a closure snapshot closes restored tabs from earlier rounds and helpers without replaying old notifications", async () => {
  const snapshot = { ...activity, round: 3, status: "done", phase: "pr_closed", prState: "closed", sessionIDs: ["ses_old", "ses_test", "ses_vision"] };
  const f = fixture([snapshot], ["ses_old", "ses_test", "ses_vision", "ses_unrelated"]);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.closed, ["ses_old", "ses_test", "ses_vision"]);
    assert.equal(f.toasts.length, 0); assert.ok(f.tabs.has("ses_unrelated"));
    f.event({ ...activity, round: 3 }); // A late start notification must not reopen it.
    assert.deepEqual(f.opened, []);
  } finally { f.stop(); }
});

test("busy tabs remain open until idle and disabled tabs do not prevent later cleanup", async () => {
  const f = fixture();
  const final = { ...activity, status: "done", phase: "pr_closed", prState: "closed" };
  try {
    f.event(activity); f.tabs.get("ses_test")!.busy = true;
    f.event(final); assert.deepEqual(f.closed, []);
    f.tabs.get("ses_test")!.busy = false;
    f.enableTabs(false); f.event(final); assert.deepEqual(f.closed, []);
    f.enableTabs(true); f.event(final); assert.deepEqual(f.closed, ["ses_test"]);
    f.event(final, "/other"); assert.equal(f.closed.length, 1);
  } finally { f.stop(); }
});

test("activity includes saved main sessions, previous sessions and media helpers for closure", async () => {
  const { activityOf } = await import("../src/activity.js");
  const row = activityOf({ key: "owner/repo#1", repo: "owner/repo", issue: { number: 1 }, phase: "pr_opened", status: "done", sessionID: "ses_current", previousSessionID: "ses_previous", sessionIDs: ["ses_old", "ses_previous", "ses_current"], helpers: [{ id: "ses_vision" }], pr: { state: "closed", html_url: "https://github.com/owner/repo/pull/2" } } as import("../src/dispatcher.js").Task);
  assert.deepEqual(row.sessionIDs, ["ses_old", "ses_previous", "ses_current", "ses_vision"]);
  assert.equal(row.phase, "pr_closed"); assert.equal(row.prState, "closed");
});

test("/restartworkflow sends the selected task to its owner and displays recovery failures", async () => {
  const f = fixture([{ ...activity, status: "blocked" }]);
  try {
    await new Promise(resolve => setImmediate(resolve));
    await f.restart();
    assert.deepEqual(f.recovered, [activity.key]);
    assert.match(JSON.stringify(f.toasts.at(-1)), /recovery queued from the saved stage/);
    assert.equal(f.opened.length, 0);
    f.recoveryError(new Error("Answer the pending question in the GitHub issue first"));
    await f.restart();
    assert.match(JSON.stringify(f.alerts.at(-1)), /pending question/);
    assert.equal(f.recovered.length, 1);
  } finally { f.stop(); }
});

test("/bot closes tracking only after confirmation and keeps closed sessions accessible", async () => {
  const f = fixture([{ ...activity, status: "blocked" }], ["ses_test"]);
  try {
    await new Promise(r => setImmediate(r));
    f.choose(activity.key, "close", "cancel"); await f.command(); assert.deepEqual(f.ended, []);
    f.choose(activity.key, "close", "confirm"); await f.command(); assert.deepEqual(f.ended, [activity.key]);
    f.event({ ...activity, status: "closed" }); assert.deepEqual(f.closed, ["ses_test"]);
    f.event(activity); assert.deepEqual(f.opened, []);
    f.choose(activity.key, "open"); await f.command(); assert.equal(f.navigated.length, 1);
  } finally { f.stop(); }
});

test("/bot can close tracking before a session exists and tab-only closure never calls the owner", async () => {
  const f = fixture([{ ...activity, sessionID: undefined, sessionReady: false, status: "blocked" }]);
  try {
    await new Promise(r => setImmediate(r));
    f.choose(activity.key, "close", "confirm"); await f.command(); assert.equal(f.ended.length, 1);
    f.event(activity); f.tabs.get("ses_test")!.busy = true;
    f.choose(activity.key, "tabs"); await f.command(); assert.equal(f.closed.length, 0); assert.equal(f.ended.length, 1);
    assert.match(JSON.stringify(f.toasts.at(-1)), /Busy tabs/);
  } finally { f.stop(); }
});


test("/bot lists remote repositories even with no tasks and never starts or restarts a task", async () => {
  const f = fixture();
  try {
    f.choose("repositories", "0"); await f.command();
    assert.match(JSON.stringify(f.alerts.at(-1)), /remote\/repo/);
    assert.match(JSON.stringify(f.alerts.at(-1)), /remote\/project/);
    assert.equal((f.repositoryRequests[0] as { location: { directory: string } }).location.directory, "/repo");
    assert.deepEqual(f.recovered, []); assert.deepEqual(f.ended, []); assert.deepEqual(f.navigated, []);
    f.repositoriesError(); f.choose("repositories"); await f.command();
    assert.match(JSON.stringify(f.alerts.at(-1)), /Repositories unavailable/);
  } finally { f.stop(); }
});
