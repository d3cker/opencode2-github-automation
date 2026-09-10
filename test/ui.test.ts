import test from "node:test";
import assert from "node:assert/strict";
import type { Plugin } from "@opencode/plugin/tui";
import { setupUI } from "../src/ui.js";
import type { Activity } from "../src/activity.js";

const activity: Activity = { key: "owner/repo#1", repo: "owner/repo", issueNumber: 1, round: 1, phase: "running", status: "ready", sessionID: "ses_test", sessionReady: true, worktree: "/worktree" };
function fixture(initial: Activity[] = []) {
  const toasts: unknown[] = [], opened: string[] = [], navigated: unknown[] = [];
  let listener!: (event: { location: { directory: string }; data: Activity }) => void;
  let command!: () => Promise<void>, unsubscribed = false;
  const context = {
    location: { directory: "/repo" },
    client: { rpc: () => ({ activity: async () => initial, events: { on: (_name: string, cb: typeof listener) => { listener = cb; return () => { unsubscribed = true; }; } } }) },
    data: { session: { sync: async () => {} } },
    keymap: { layer: (get: () => { commands: { run: () => Promise<void> }[] }) => { command = get().commands[0]!.run; } },
    ui: {
      slot: (claim: { render: () => unknown }) => { claim.render(); return () => {}; },
      toast: { show: (value: unknown) => toasts.push(value) },
      tabs: { open: (id: string) => { opened.push(id); return true; }, focus: () => false },
      router: { navigate: (value: unknown) => navigated.push(value) },
      dialog: { select: async () => activity.key, alert: async () => {} },
    },
  } as unknown as Plugin.Context;
  const stop = setupUI(context)!;
  return { toasts, opened, navigated, stop, unsubscribed: () => unsubscribed, command: () => command(), event: (data: Activity, directory = "/repo") => listener({ data, location: { directory } }) };
}

test("a start event opens a background tab once without navigating the current conversation", async () => {
  const f = fixture();
  try {
    f.event(activity); f.event(activity);
    assert.deepEqual(f.opened, ["ses_test"]); assert.equal(f.toasts.length, 1); assert.equal(f.navigated.length, 0);
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
