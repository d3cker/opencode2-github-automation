import type { RGBA } from "@opentui/core";
import type { Plugin } from "@opencode/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createSignal } from "solid-js";
import { GithubRpc, SchedulerRpc } from "./rpc.js";
import { RuntimePoller, runtimeLines, selectedTask, type RuntimeSnapshot } from "./runtime-panel.js";

// OpenCode 2.0.10 renamed semantic text tokens and removed text.status.
// Keep the adapter structural so the pinned 2.0.6 SDK remains supported.
type SidebarTheme = { text: {
  base?: RGBA; default?: RGBA; muted?: RGBA; subdued?: RGBA;
  status?: { running?: RGBA };
  action?: { primary?: { base?: RGBA; default?: RGBA } };
  feedback?: { error?: { base?: RGBA; default?: RGBA }; warning?: { base?: RGBA; default?: RGBA } };
} };

function sidebarColor(theme: SidebarTheme, tone: string | undefined) {
  const text = theme.text;
  const base = text.base ?? text.default;
  if (tone === "error" || tone === "warning") return text.feedback?.[tone]?.base ?? text.feedback?.[tone]?.default ?? base;
  if (tone === "heading") return text.action?.primary?.base ?? text.status?.running ?? base;
  if (tone === "muted") return text.muted ?? text.subdued ?? base;
  return base;
}

export function RuntimeSidebar(props: { context: Plugin.Context; snapshot: () => RuntimeSnapshot; now: () => number; sessionID: string }) {
  return jsx("box", { flexDirection: "column", marginTop: 1, flexShrink: 0,
    get children() {
      const snapshot = props.snapshot();
      const task = selectedTask(snapshot, props.sessionID);
      const sessionStatus = task?.sessionID && props.context.data.session.get(task.sessionID)
        ? props.context.data.session.status(task.sessionID) : undefined;
      return runtimeLines(snapshot, props.now(), props.sessionID, sessionStatus).map(line => jsx("text", {
        content: line.text, wrapMode: "word", marginTop: line.tone === "heading" ? 1 : 0,
        fg: sidebarColor(props.context.theme, line.tone),
      }));
    },
  });
}

export function setupSidebar(context: Plugin.Context) {
  const location = context.location ?? context.data.location.default();
  if (!location?.directory) return;
  const github = context.client.rpc(GithubRpc), scheduler = context.client.rpc(SchedulerRpc);
  const poller = new RuntimePoller(signal => github.monitor({}, { location, signal }), signal => scheduler.status({}, { location, signal }));
  const [snapshot, setSnapshot] = createSignal<RuntimeSnapshot>({});
  const [now, setNow] = createSignal(Date.now());
  let disposed = false;
  const unsubscribe = poller.subscribe(setSnapshot);
  const unregister = context.ui.slot({ append: "sidebar.content", render: props => RuntimeSidebar({ context, snapshot, now, get sessionID() { return props.sessionID; } }) });
  const unregisterCommand = context.ui.slot({ append: "app", render: () => {
    context.keymap.layer(() => ({ mode: "global", commands: [{
      id: "automation.runtime", title: "Bot: runtime status", group: "Bot", palette: true, slash: { name: "botstatus" },
      run: async () => {
        await poller.refresh();
        if (disposed) return;
        const route = context.ui.router.current();
        const state = poller.get();
        const sessionID = route.type === "session" ? route.sessionID : undefined;
        const lines = runtimeLines(state, Date.now(), sessionID).map(line => line.text);
        if (state.dispatcherError) lines.push(state.dispatcherError);
        if (state.schedulerError) lines.push(state.schedulerError);
        if (state.dispatcher) lines.push(`Owner: ${state.dispatcher.ownerDirectory}`);
        // The sidebar is deliberately compact; expose every task and job here.
        for (const task of state.dispatcher?.tasks ?? []) lines.push(`${task.key}: ${task.status} / ${task.phase} · round ${task.round}${task.prURL ? ` · ${task.prURL}` : ""}`);
        for (const job of state.scheduler ?? []) lines.push(`${job.id}: ${job.running ? "running" : job.paused ? "paused" : "scheduled"} · failures ${job.failures}`);
        await context.ui.dialog.alert({ title: "Bot runtime status", message: lines.join("\n") });
      },
    }] }));
    return null;
  } });
  poller.start();
  const timer = setInterval(() => setNow(Date.now()), 1000);
  return () => { disposed = true; clearInterval(timer); poller.stop(); unsubscribe(); unregister(); unregisterCommand(); };
}
