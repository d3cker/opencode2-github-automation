import type { Plugin } from "@opencode/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createSignal } from "solid-js";
import { GithubRpc, SchedulerRpc } from "./rpc.js";
import { RuntimePoller, runtimeLines, selectedTask, type RuntimeSnapshot } from "./runtime-panel.js";

export function RuntimeSidebar(props: { context: Plugin.Context; snapshot: () => RuntimeSnapshot; now: () => number; sessionID: string }) {
  const theme = props.context.theme;
  return jsx("box", { flexDirection: "column", marginTop: 1, flexShrink: 0,
    get children() {
      const snapshot = props.snapshot();
      const task = selectedTask(snapshot, props.sessionID);
      const sessionStatus = task?.sessionID && props.context.data.session.get(task.sessionID)
        ? props.context.data.session.status(task.sessionID) : undefined;
      return runtimeLines(snapshot, props.now(), props.sessionID, sessionStatus).map(line => jsx("text", {
        content: line.text, wrapMode: "word", marginTop: line.tone === "heading" ? 1 : 0,
        fg: line.tone === "error" ? theme.text.feedback.error.default : line.tone === "warning" ? theme.text.feedback.warning.default : line.tone === "heading" ? theme.text.status.running : line.tone === "muted" ? theme.text.subdued : theme.text.default,
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
