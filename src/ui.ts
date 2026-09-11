import type { Plugin } from "@opencode/plugin/tui";
import { GithubRpc } from "./rpc.js";
import { Activity } from "./activity.js";

export function setupUI(context: Plugin.Context) {
  const location = context.location ?? context.data.location.default();
  if (!location?.directory) return;
  const rpc = context.client.rpc(GithubRpc);
  const states = new Map<string, Activity>();
  const seen = new Set<string>();
  let stopped = false, syncing = false;
  const controller = new AbortController();
  const receive = (raw: unknown, initial = false) => {
    if (stopped) return;
    const activity = Activity.parse(raw);
    if ((states.get(activity.key)?.round ?? 0) > activity.round) return;
    states.set(activity.key, activity);
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
    }],
    }));
    return null;
  } });
  void sync(true);
  const timer = setInterval(() => void sync(), 10_000);
  return () => { stopped = true; clearInterval(timer); controller.abort(); unsubscribe(); unregisterSlot(); };
}
