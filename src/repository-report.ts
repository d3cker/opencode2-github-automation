import { z } from "zod";
import { DispatcherMonitor, SchedulerMonitor } from "./monitor.js";

export const RepositoryEntry = z.object({
  ownerDirectory: z.string(), directory: z.string(), repo: z.string(), baseBranch: z.string(),
  stateDirectory: z.string(), configFile: z.string().optional(), registeredAt: z.number(),
});
export type RepositoryEntry = z.infer<typeof RepositoryEntry>;
export const RepositoryReport = z.object({
  entries: z.array(RepositoryEntry.extend({
    status: z.enum(["running", "paused", "error", "not-running", "unavailable", "missing", "unconfigured"]),
    reason: z.string().optional(), dispatcherAt: z.number().optional(), schedulerAt: z.number().optional(),
    dispatcher: DispatcherMonitor.optional(), scheduler: SchedulerMonitor.optional(),
  })), warnings: z.array(z.string()),
});
export type RepositoryReport = z.infer<typeof RepositoryReport>;
export type RepositoryRow = RepositoryReport["entries"][number];

// Labels can originate in paths, issue text and saved error messages.
export function plain(value: string) {
  // eslint-disable-next-line no-control-regex -- Never emit terminal control sequences from repository data.
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
const timestamp = (value?: number) => value === undefined ? "unknown" : new Date(value).toISOString();
export function repositoryDetails(row: RepositoryRow) {
  const d = row.dispatcher;
  const tasks = d?.tasks.filter(t => t.repo === row.repo && t.status !== "closed" && (["closing", "cancelling"].includes(t.status) || t.prState !== "closed" && t.phase !== "merged"));
  const counts = tasks ? `Active: ${tasks.filter(t => t.key === d?.activeTask).length} · Scheduled: ${tasks.filter(t => ["ready", "retry_wait"].includes(t.status) && t.key !== d?.activeTask).length} · Waiting: ${tasks.filter(t => t.status === "waiting").length} · Blocked/failed: ${tasks.filter(t => ["blocked", "failed"].includes(t.status)).length} · Watching: ${tasks.filter(t => t.status === "watching").length} · Cancelling: ${tasks.filter(t => t.status === "cancelling").length} · Closing: ${tasks.filter(t => t.status === "closing").length}` : "Task counts: unavailable";
  return [
    `${row.repo} · ${row.status}`, `Directory: ${row.directory}`, `Owner: ${row.ownerDirectory}`,
    `Base branch (last registered): ${row.baseBranch}`, ...(row.reason ? [row.reason] : []),
    `Dispatcher snapshot: ${timestamp(row.dispatcherAt)} · Scheduler snapshot: ${timestamp(row.schedulerAt)}`,
    `Last scan attempt finished: ${timestamp(d?.lastScanFinished)}`, ...(d?.scanError ? [`Scan error: ${d.scanError}`] : []),
    `Dispatcher: ${d?.worker ?? "unavailable"}${d?.scanning ? " · scanning" : ""}`, counts,
    ...(row.scheduler?.map(s => `Job ${s.id}: ${s.paused ? "paused" : s.running ? "running" : "scheduled"} · next ${s.paused ? "paused" : timestamp(s.nextAt)} · failures ${s.failures}${s.error ? ` · ${s.error}` : ""}`) ?? ["Scheduler: unavailable"]),
    ...(tasks?.filter(t => ["blocked", "failed", "closing", "cancelling"].includes(t.status)).map(t => `${t.key}: ${t.status} · ${t.error ?? "Stopping sessions"}`) ?? []),
  ].map(plain).join("\n");
}
export function formatRepositories(report: RepositoryReport) {
  return ["Repositories on this host (current user)", "Snapshots refresh every 5s; readings older than 15s are unavailable. Pausing scans does not stop accepted work.",
    ...report.entries.map(repositoryDetails), ...report.warnings.map(w => `Warning: ${plain(w)}`),
    ...(!report.entries.length ? ["No registered repositories. Run list --discover /path/to/projects to import existing configurations, or init in a new repository."] : []),
  ].join("\n\n");
}
