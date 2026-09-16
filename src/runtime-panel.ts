import type { Activity } from "./activity.js";
import { DispatcherMonitor, SchedulerMonitor } from "./monitor.js";
import { abortable } from "./lifecycle.js";

export type RuntimeSnapshot = {
  dispatcher?: DispatcherMonitor; scheduler?: SchedulerMonitor;
  dispatcherAt?: number; schedulerAt?: number;
  dispatcherError?: string; schedulerError?: string;
};
export class RuntimePoller {
  private snapshot: RuntimeSnapshot = {};
  private controller = new AbortController();
  private listeners = new Set<(value: RuntimeSnapshot) => void>();
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readDispatcher: (signal: AbortSignal) => Promise<unknown>, private readScheduler: (signal: AbortSignal) => Promise<unknown>, private now = Date.now) {}
  get() { return this.snapshot; }
  subscribe(listener: (value: RuntimeSnapshot) => void) {
    this.listeners.add(listener); listener(this.snapshot);
    return () => { this.listeners.delete(listener); };
  }
  start() {
    if (this.timer || this.controller.signal.aborted) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 5000);
  }
  refresh(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    if (this.pending) return this.pending;
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(4000)]);
    this.pending = Promise.allSettled([
      abortable(() => this.readDispatcher(signal), signal).then(value => DispatcherMonitor.parse(value)),
      abortable(() => this.readScheduler(signal), signal).then(value => SchedulerMonitor.parse(value)),
    ]).then(([dispatcher, scheduler]) => {
      if (this.controller.signal.aborted) return;
      this.snapshot = { ...this.snapshot,
        ...(dispatcher.status === "fulfilled" ? { dispatcher: dispatcher.value, dispatcherAt: this.now(), dispatcherError: undefined } : { dispatcherError: "Dispatcher unavailable. Load or update the owner plugin." }),
        ...(scheduler.status === "fulfilled" ? { scheduler: scheduler.value, schedulerAt: this.now(), schedulerError: undefined } : { schedulerError: "Scheduler unavailable. Check the owner plugin." }),
      };
      for (const listener of this.listeners) listener(this.snapshot);
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  stop() { clearInterval(this.timer); this.controller.abort(); this.listeners.clear(); }
}

export type PanelLine = { text: string; tone?: "heading" | "muted" | "success" | "warning" | "error" };
const phaseNames: Record<string, string> = { queued: "Queued", analyzing: "Analyzing", commented: "Preparing worktree", running: "Session execution", verifying: "Verifying changes", publishing: "Publishing", pr_opened: "PR published", merged: "Merged", pr_closed: "PR closed" };
function safe(text: string, limit = 110) {
  // Treat issue/branch/error strings as text, never terminal control sequences.
  // eslint-disable-next-line no-control-regex -- Strip terminal controls from external labels.
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}
function duration(ms: number) { const s = Math.max(0, Math.ceil(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; }
function ago(time: number | undefined, now: number) { return time === undefined ? "not yet" : `${duration(now - time)} ago`; }
function due(time: number, now: number) { return time > now ? `in ${duration(time - now)}` : "due"; }
export function selectedTask(snapshot: RuntimeSnapshot, sessionID?: string): Activity | undefined {
  const tasks = snapshot.dispatcher?.tasks ?? [];
  return tasks.find(t => sessionID && (t.sessionID === sessionID || t.sessionIDs?.includes(sessionID)))
    ?? tasks.find(t => t.key === snapshot.dispatcher?.activeTask)
    ?? tasks.find(t => ["closing", "waiting", "blocked", "failed"].includes(t.status) && t.prState !== "closed")
    ?? tasks.find(t => ["ready", "retry_wait"].includes(t.status))
    ?? tasks.filter(t => t.status !== "closed").at(-1);
}
export function runtimeLines(snapshot: RuntimeSnapshot, now: number, sessionID?: string, sessionStatus?: string): PanelLine[] {
  const lines: PanelLine[] = [{ text: "BOT RUNTIME", tone: "heading" }];
  const d = snapshot.dispatcher, jobs = snapshot.scheduler;
  const stale = Boolean(snapshot.dispatcherError || snapshot.dispatcherAt !== undefined && now - snapshot.dispatcherAt > 15000);
  const schedulerStale = Boolean(snapshot.schedulerError || snapshot.schedulerAt !== undefined && now - snapshot.schedulerAt > 15000);
  if (!d) lines.push({ text: snapshot.dispatcherError ? "Dispatcher unavailable" : "Connecting to owner…", tone: snapshot.dispatcherError ? "warning" : "muted" });
  else {
    const active = d.tasks.find(t => t.key === d.activeTask);
    const worker = d.worker === "executing" ? phaseNames[active?.phase ?? ""] ?? "Working" : ({ idle: "Idle", reconciling: "Reconciling state", merging: "Checking merges", maintenance: "Task maintenance", stopped: "Stopped" }[d.worker]);
    lines.push({ text: `${stale ? "Last dispatcher" : "Dispatcher"}: ${worker}`, tone: stale || d.worker === "stopped" ? "warning" : undefined });
    if (d.activeTask) lines.push({ text: safe(d.activeTask, 65), tone: "muted" });
    lines.push({ text: `${stale ? "Last scan" : "Discovery"}: ${d.scanning ? "scanning GitHub" : ago(d.lastScanFinished, now)}`, tone: d.scanError ? "warning" : "muted" });
    if (d.scanError) lines.push({ text: safe(d.scanError), tone: "error" });
    const open = d.tasks.filter(t => t.status !== "closed" && (t.status === "closing" || t.prState !== "closed" && t.phase !== "merged"));
    const count = (states: string[]) => open.filter(t => states.includes(t.status)).length;
    const scheduled = open.filter(t => ["ready", "retry_wait"].includes(t.status) && t.key !== d.activeTask).length;
    lines.push({ text: `Queue: ${scheduled} scheduled · ${count(["waiting"])} waiting`, tone: "muted" });
    for (const task of open.filter(t => ["blocked", "failed", "closing"].includes(t.status)).slice(0, 3)) lines.push({ text: `${safe(task.key, 55)}: ${task.status} · ${safe(task.error ?? "Stopping sessions", 90)}`, tone: "warning" });
    if (count(["closing"])) lines.push({ text: `${count(["closing"])} closing · /bot to manage`, tone: "warning" });
    lines.push({ text: `${count(["blocked", "failed"])} blocked/failed · ${count(["done"])} published`, tone: count(["blocked", "failed"]) ? "warning" : "muted" });
  }
  if (!jobs) lines.push({ text: snapshot.schedulerError ? "Scheduler unavailable" : "Scheduler: connecting…", tone: snapshot.schedulerError ? "warning" : "muted" });
  else if (!jobs.length) lines.push({ text: "Scheduler: no jobs", tone: "muted" });
  else {
    for (const job of jobs.slice(0, 3)) {
      const label = jobs.length > 1 ? safe(job.id, 24) : "Scheduler";
      const state = job.running ? (job.paused ? "Running · polling paused" : "Running") : job.paused ? "Paused" : `${job.failures ? "Retry" : "Next scan"} ${due(job.nextAt, now)}`;
      lines.push({ text: `${schedulerStale ? "Last " : ""}${label}: ${state}`, tone: schedulerStale || job.paused || job.failures ? "warning" : "muted" });
      if (job.error) lines.push({ text: safe(job.error), tone: "error" });
    }
    if (jobs.length > 3) lines.push({ text: `+${jobs.length - 3} jobs · /botstatus`, tone: "muted" });
  }
  const task = selectedTask(snapshot, sessionID);
  if (task) {
    lines.push({ text: stale ? "LAST TASK SNAPSHOT" : "TASK", tone: "heading" }, { text: safe(task.key, 65) });
    lines.push({ text: `${phaseNames[task.phase] ?? safe(task.phase)} · round ${task.round}`, tone: "muted" });
    const status = task.status === "waiting" ? `Waiting for ${task.question === "permission" ? "permission" : "issue reply"}` : task.status === "retry_wait" ? `Retry ${due(task.nextAt ?? now, now)}` : task.status === "ready" ? d?.activeTask === task.key ? task.phase === "running" ? `Session: ${sessionStatus ?? "not observed"}` : "In progress" : "Scheduled" : task.status;
    lines.push({ text: status, tone: ["blocked", "failed", "waiting", "retry_wait"].includes(task.status) ? "warning" : "muted" });
    if (task.recovery) lines.push({ text: "Workflow recovery requested", tone: "warning" });
    if (task.branch) lines.push({ text: `Branch: ${safe(task.branch, 65)}`, tone: "muted" });
    if (task.baseBranch) lines.push({ text: `Base: ${safe(task.baseBranch, 45)}`, tone: "muted" });
    if (task.model) lines.push({ text: `Model: ${safe(task.model, 75)}`, tone: "muted" });
    lines.push({ text: `Feedback: ${task.pendingFeedback ?? 0} queued · Media: ${task.helpers ?? 0}`, tone: "muted" });
    if (task.attempts) lines.push({ text: `Failed attempts: ${task.attempts}`, tone: "warning" });
    if (task.prNumber) lines.push({ text: `PR #${task.prNumber} · ${task.phase === "merged" ? "merged" : task.prState ?? "unknown"}`, tone: "muted" });
    if (task.error) lines.push({ text: safe(task.error), tone: "error" });
  }
  if (stale || schedulerStale) lines.push({ text: "STALE / partial data", tone: "warning" });
  lines.push({ text: `Dispatcher updated: ${ago(snapshot.dispatcherAt, now)}`, tone: "muted" });
  if (snapshot.schedulerAt !== snapshot.dispatcherAt) lines.push({ text: `Scheduler updated: ${ago(snapshot.schedulerAt, now)}`, tone: "muted" });
  lines.push({ text: "/botstatus · /bot", tone: "muted" });
  if (task && ["blocked", "failed"].includes(task.status)) lines.push({ text: "/restartworkflow", tone: "warning" });
  return lines;
}
