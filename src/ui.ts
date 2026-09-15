import type { Plugin } from "@opencode/plugin/tui";
import { GithubRpc } from "./rpc.js";
import { Activity } from "./activity.js";

export function setupUI(context: Plugin.Context) {
  const location = context.location ?? context.data.location.default();
  if (!location?.directory) return;
  const rpc = context.client.rpc(GithubRpc);
  const states = new Map<string, Activity>();
  const seen = new Set<string>();
  const sessions = new Map<string, Set<string>>();
  const closed = new Map<string, Set<string>>();
  let stopped = false, syncing = false;
  const controller = new AbortController();
  const receive = (raw: unknown, initial = false) => {
    if (stopped) return;
    const activity = Activity.parse(raw);
    if ((states.get(activity.key)?.round ?? 0) > activity.round) return;
    states.set(activity.key, activity);
    const known = sessions.get(activity.key) ?? new Set<string>();
    for (const id of [...(activity.sessionIDs ?? []), ...(activity.sessionID ? [activity.sessionID] : [])]) known.add(id);
    sessions.set(activity.key, known);
    if (activity.prState === "closed" || activity.phase === "merged") {
      // Closing a tab preserves its session. Handle each tab once so a person
      // can reopen it from /bot or history without the next poll closing it.
      seen.add(`${activity.key}:${activity.round}:started`);
      if (context.ui.tabs.enabled()) {
        const handled = closed.get(activity.key) ?? new Set<string>();
        const tabs = context.ui.tabs.list();
        for (const id of known) {
          if (handled.has(id)) continue;
          const tab = tabs.find(t => t.sessionID === id);
          if (tab?.busy) continue; // Retry after ongoing work finishes.
          if (!tab || context.ui.tabs.close(id)) handled.add(id);
        }
        closed.set(activity.key, handled);
      }
      return;
    }
    if (activity.prState === "open") closed.delete(activity.key);
    const started = activity.sessionReady && activity.sessionID && ["ready", "retry_wait"].includes(activity.status);
    const terminal = ["done", "blocked", "failed", "waiting"].includes(activity.status);
    const id = `${activity.key}:${activity.round}:${started ? "started" : activity.status}`;
    if ((!started && !terminal) || seen.has(id)) return;
    seen.add(id);
    if (initial && !started) return;
    if (started) {
      const opened = context.ui.tabs.open(activity.sessionID!); // The SDK explicitly opens this in the background.
      context.ui.toast.show({ title: "OpenCode Automation", message: `Working on ${activity.key}. ${opened ? "Session in a tab · " : "Open session: "}/bot`, variant: "info", duration: 8000 });
    } else {
      context.ui.toast.show({ title: "OpenCode Automation", message: `${activity.key}: ${activity.status === "done" ? "done — PR updated" : activity.status === "waiting" ? "waiting for a reply in the GitHub issue" : "needs attention"}. /bot`, variant: activity.status === "done" ? "success" : "warning", duration: 8000 });
    }
  };
  const sync = async (initial = false) => {
    if (stopped || syncing) return;
    syncing = true;
    try {
      const rows = await rpc.activity({}, { location, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
      for (const activity of rows) receive(activity, initial);
    } catch { /* Polling recovers missed events and transient server restarts. */ }
    finally { syncing = false; }
  };
  const unsubscribe = rpc.events.on("activity", event => {
    if (event.location.directory === location.directory) receive(event.data);
  }, { signal: controller.signal });
  const unregisterSlot = context.ui.slot({ append: "app", render: () => {
    context.keymap.layer(() => ({
    mode: "global",
    commands: [{
      id: "automation.sessions", title: "Bot: show issue tasks", group: "Bot", palette: true,
      slash: { name: "bot" },
      run: async () => {
        await sync(true);
        const rows = [...states.values()].reverse();
        if (!rows.length) { context.ui.toast.show({ message: "No bot tasks in this project.", variant: "info" }); return; }
        const selected = await context.ui.dialog.select({
          title: "Bot tasks", options: rows.map(a => ({ title: `${a.key} · ${a.status}`, description: a.error ?? `Round ${a.round} · ${a.phase}`, value: a.key })),
        });
        if (!selected || stopped) return;
        const activity = states.get(selected);
        if (!activity?.sessionReady || !activity.sessionID) {
          await context.ui.dialog.alert({ title: selected, message: activity?.error ?? "The session has not started yet." }); return;
        }
        await context.data.session.sync(activity.sessionID);
        if (!context.ui.tabs.focus(activity.sessionID)) context.ui.router.navigate({ type: "session", sessionID: activity.sessionID });
      },
    }, {
      id: "automation.restartworkflow", title: "Bot: restart saved workflow", group: "Bot", palette: true,
      slash: { name: "restartworkflow" },
      run: async () => {
        await sync(true);
        const rows = [...states.values()].reverse();
        if (!rows.length) { context.ui.toast.show({ message: "No bot tasks in this project.", variant: "info" }); return; }
        const key = await context.ui.dialog.select({ title: "Restart workflow — preserve worktree and PR", options: rows.map(a => ({ title: `${a.key} · ${a.status}`, description: a.error ?? `Round ${a.round} · ${a.phase}`, value: a.key })) });
        if (!key || stopped) return;
        try {
          const result = await rpc.restartworkflow({ key }, { location, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
          context.ui.toast.show({ message: result.accepted ? `${key}: recovery queued from the saved stage. Existing work is preserved.` : `${key}: already scheduled, running, or complete. No duplicate recovery started.`, variant: "info", duration: 8000 });
          await sync(true);
        } catch (error) {
          await context.ui.dialog.alert({ title: "Workflow recovery", message: error instanceof Error ? error.message : "Recovery request failed; check the project service and retry." });
        }
      },
    }],
    }));
    return null;
  } });
  void sync(true);
  const timer = setInterval(() => void sync(), 10_000);
  return () => { stopped = true; clearInterval(timer); controller.abort(); unsubscribe(); unregisterSlot(); };
}
