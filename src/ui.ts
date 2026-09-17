import type { Plugin } from "@opencode/plugin/tui";
import { GithubRpc } from "./rpc.js";
import { plain, repositoryDetails } from "./repository-report.js";
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
    const previous = states.get(activity.key);
    if ((previous?.controlVersion ?? 0) > (activity.controlVersion ?? 0)) return;
    const newControl = (activity.controlVersion ?? 0) > (previous?.controlVersion ?? 0);
    if (!newControl && previous?.round === activity.round && ["cancelling", "watching"].includes(previous.status) && !["cancelling", "watching", "closing", "closed"].includes(activity.status)) return;
    if (!newControl && previous?.round === activity.round && previous.status === "watching" && activity.status === "cancelling") return;
    if ((states.get(activity.key)?.round ?? 0) > activity.round) return;
    if (!newControl && ["closing", "closed"].includes(states.get(activity.key)?.status ?? "") && !["closing", "closed"].includes(activity.status)) return;
    if (states.get(activity.key)?.status === "closed" && activity.status === "closing") return;
    states.set(activity.key, activity);
    const known = sessions.get(activity.key) ?? new Set<string>();
    for (const id of [...(activity.sessionIDs ?? []), ...(activity.sessionID ? [activity.sessionID] : [])]) known.add(id);
    sessions.set(activity.key, known);
    if (activity.status === "closed" || activity.prState === "closed" || activity.phase === "merged") {
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
      id: "automation.sessions", title: "Bot: manage issue tasks", group: "Bot", palette: true,
      slash: { name: "bot" },
      run: async () => {
        await sync(true);
        const rows = [...states.values()].reverse();
        const selected = await context.ui.dialog.select({
          title: "Bot tasks", options: [
            ...rows.map(a => ({ title: `${a.key} · ${a.status}`, description: a.error ?? `Round ${a.round} · ${a.phase}`, value: a.key })),
            { title: "Repositories", description: "Configured folders and bot status on the connected server", value: "repositories" },
          ],
        });
        if (!selected || stopped) return;
        if (selected === "repositories") {
          try {
            const report = await rpc.repositories({}, { location, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
            if (stopped) return;
            if (report.warnings.length) await context.ui.dialog.alert({ title: "Repository inventory warnings", message: report.warnings.map(plain).join("\n") });
            if (!report.entries.length) { await context.ui.dialog.alert({ title: "Repositories", message: "No registered repositories. Run opencode2-automation list --discover /path/to/projects on the server to import older configurations." }); return; }
            const choice = await context.ui.dialog.select({ title: "Repositories — connected server", options: report.entries.map((r, i) => ({ title: plain(`${r.repo} · ${r.status}`), description: plain(r.directory), value: String(i) })) });
            if (choice === undefined || stopped) return;
            const row = report.entries[Number(choice)];
            if (row) await context.ui.dialog.alert({ title: plain(row.repo), message: repositoryDetails(row) });
          } catch {
            if (!stopped) await context.ui.dialog.alert({ title: "Repositories unavailable", message: "Update/load the owner plugin, or run opencode2-automation list on the server. No repositories were started." });
          }
          return;
        }
        const activity = states.get(selected);
        if (!activity) return;
        const terminal = ["closing", "closed", "cancelling", "watching"].includes(activity.status);
        const action = await context.ui.dialog.select({ title: `${selected} · ${activity.status}`, options: [
          { title: "Open session", description: "Inspect the saved conversation and work", value: "open" },
          { title: "Show details", description: "Status, error, branch, session and PR", value: "details" },
          { title: "Close session tabs", description: "Hide idle tabs only; does not change tracking", value: "tabs" },
          ...(!["closing", "closed", "done", "watching"].includes(activity.status) ? [{ title: activity.status === "cancelling" ? "Retry cancelling round" : "Cancel current round", description: "Stop this round; preserve work and keep watching new issue comments and the PR", value: "cancelround" }] : []),
          ...(activity.status === "closed" ? [{ title: "Resume issue tracking", description: "Watch future comments; do not replay the stopped round or the closed-period backlog", value: "resumetracking" }] : []),
          ...(!terminal ? [{ title: "Restart workflow", description: "Resume an eligible stopped task, preserving work", value: "restart" }] : []),
          ...(!["closed", "cancelling"].includes(activity.status) ? [{ title: activity.status === "closing" ? "Retry closing task" : "Stop and close task", description: "Stop known bot sessions and end tracking; preserve all local work and history", value: "close" }] : []),
        ] });
        if (!action || stopped) return;
        try {
          if (action === "details") {
            await context.ui.dialog.alert({ title: selected, message: [
              `Status: ${activity.status} · phase: ${activity.phase} · round: ${activity.round}`,
              `Error: ${activity.error ?? "none"}`, ...(activity.historicalError ? [`Historical error: ${activity.historicalError}`] : []), `Session: ${activity.sessionID ?? "not created"}`,
              `Branch: ${activity.branch ?? "unknown"}`, `Worktree: ${activity.worktree ?? "not created"}`,
              `PR: ${activity.prURL ?? "none"}`, `Queued feedback: ${activity.pendingFeedback ?? 0}`,
              ...(activity.status === "closed" ? ["Tracking ended locally. GitHub issue/PR and local work were preserved."] : []),
              ...(activity.cancelledRound ? [`Cancelled round: ${activity.cancelledRound}. Its worktree and session remain preserved.`] : []),
              ...(activity.cancelledWorktree ? [`Preserved cancelled worktree: ${activity.cancelledWorktree}`] : []),
              ...(activity.localBranch ? [`Local branch: ${activity.localBranch}`] : []),
            ].join("\n") });
          } else if (action === "tabs") {
            const ids = sessions.get(selected) ?? new Set<string>();
            let busy = 0;
            for (const tab of context.ui.tabs.list()) {
              if (!ids.has(tab.sessionID)) continue;
              if (tab.busy || !context.ui.tabs.close(tab.sessionID)) busy++;
            }
            context.ui.toast.show({ message: busy ? "Busy tabs remain open. Use Cancel current round to stop work while keeping issue tracking." : "Session tabs closed. Task tracking is unchanged.", variant: "info" });
          } else if (action === "cancelround" || action === "resumetracking") {
            const resume = action === "resumetracking";
            const confirmed = await context.ui.dialog.select({ title: resume ? `Resume tracking ${selected}?` : `Cancel current round for ${selected}?`, options: [
              { title: "Back", description: "Leave the task unchanged", value: "back" },
              { title: resume ? "Resume issue tracking" : "Cancel round and keep tracking", description: resume
                ? "Keep all work. Watch future comments only; skip the stopped round and comments posted while closed."
                : "Stop sessions and skip this round without publishing. Preserve its worktree; later rounds start from the published PR or base. Already queued new feedback remains eligible.", value: "confirm" },
            ] });
            if (confirmed !== "confirm" || stopped) return;
            const request = { location, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]) };
            const result = resume ? await rpc.resumetracking({ key: selected }, request) : await rpc.cancelround({ key: selected }, request);
            context.ui.toast.show({ message: result.accepted ? `${selected}: stopping the round, then watching for new comments.` : `${selected}: no round to cancel or tracking is already active.`, variant: "info", duration: 8000 });
            await sync(true);
          } else if (action === "close") {
            const confirmed = await context.ui.dialog.select({ title: `Stop and close ${selected}?`, options: [
              { title: "Cancel", description: "Leave this task unchanged", value: "cancel" },
              { title: "Stop sessions and end tracking", description: "Preserve files, branch, worktree and history. Do not close the GitHub issue or PR. New comments will not restart this task.", value: "confirm" },
            ] });
            if (confirmed !== "confirm" || stopped) return;
            const result = await rpc.close({ key: selected }, { location, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
            context.ui.toast.show({ message: result.accepted ? `${selected}: closure queued. Waiting for sessions and in-flight work to stop.` : `${selected}: task tracking is already closed.`, variant: "info", duration: 8000 });
            await sync(true);
          } else if (action === "restart") {
            const result = await rpc.restartworkflow({ key: selected }, { location, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
            context.ui.toast.show({ message: result.accepted ? `${selected}: recovery queued from the saved stage.` : `${selected}: no recovery needed.`, variant: "info" });
            await sync(true);
          } else if (action === "open") {
            if (!activity.sessionReady || !activity.sessionID) {
              await context.ui.dialog.alert({ title: selected, message: "The session has not started yet. Use Cancel current round to skip this round, or Stop and close task to end tracking." }); return;
            }
            await context.data.session.sync(activity.sessionID);
            if (!context.ui.tabs.focus(activity.sessionID)) context.ui.router.navigate({ type: "session", sessionID: activity.sessionID });
          }
        } catch (error) {
          await context.ui.dialog.alert({ title: selected, message: error instanceof Error ? error.message : "Task action failed. Refresh /bot and retry." });
        }
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
