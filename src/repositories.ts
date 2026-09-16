import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { checkout, EasyOptions, run } from "./easy.js";
import { JsonStore, redact } from "./state.js";
import { heartbeat } from "./lifecycle.js";
import { DispatcherMonitor, SchedulerMonitor } from "./monitor.js";
import { RepositoryEntry, type RepositoryReport, type RepositoryRow } from "./repository-report.js";

const Registration = z.object({ version: z.literal(1), entries: z.array(RepositoryEntry).min(1) });
const Runtime = z.object({
  pid: z.number().int().positive(), at: z.number(), stopped: z.boolean(),
  dispatcher: DispatcherMonitor.optional(), scheduler: SchedulerMonitor.optional(),
});
type Runtime = z.infer<typeof Runtime>;
export function registryDirectory() {
  return resolve(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode2-automation", "repositories");
}
function prefix(owner: string) { return createHash("sha256").update(owner).digest("hex"); }
async function save<T>(file: string, schema: z.ZodType<T>, value: T) {
  await mkdir(registryDirectory(), { recursive: true, mode: 0o700 });
  await new JsonStore(file, schema, () => value).save(value);
}
export async function registerRepositories(entries: RepositoryEntry[], preserveConfig = false) {
  if (!entries.length) return;
  const owner = await realpath(entries[0]!.ownerDirectory);
  entries = await Promise.all(entries.map(async e => ({ ...e, directory: await realpath(e.directory) })));
  if (preserveConfig) {
    try {
      const old = Registration.parse(JSON.parse(await readFile(join(registryDirectory(), `${prefix(owner)}.json`), "utf8")));
      entries = entries.map(e => ({ ...e, configFile: old.entries.find(previous => previous.repo === e.repo && previous.directory === e.directory)?.configFile }));
    } catch { /* Registration replaces invalid metadata, never task state. */ }
  }
  await save(join(registryDirectory(), `${prefix(owner)}.json`), Registration, { version: 1, entries: entries.map(e => ({ ...e, ownerDirectory: owner })) });
}

// Import standard configs without resolving credentials, contacting GitHub, or activating an owner.
export async function registerConfigured(directory: string, raw?: unknown) {
  const { root, common, primary } = await checkout(directory);
  if (!primary || root !== await realpath(directory)) return false;
  const configFile = join(root, ".opencode", "automation.json");
  const options = EasyOptions.parse(raw ?? JSON.parse(await readFile(configFile, "utf8")));
  const remote = await run(root, ["git", "remote", "get-url", "origin"]);
  const repo = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote)?.[1];
  if (!repo) throw new Error("origin must point to a GitHub.com repository");
  await registerRepositories([{ ownerDirectory: root, directory: root, repo, baseBranch: options.baseBranch ?? "auto (resolved on activation)", stateDirectory: join(common, "opencode2-automation"), ...(raw === undefined ? { configFile } : {}), registeredAt: Date.now() }]);
  return true;
}

export async function discoverRepositories(directory: string) {
  const warnings: string[] = [];
  const found: string[] = [];
  let visited = 0;
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (++visited > 10000) throw new Error("Discovery reached 10000 directories. Choose a smaller root.");
    let children;
    try { children = await readdir(folder, { withFileTypes: true }); }
    catch { warnings.push(`Cannot read directory: ${folder}`); return; }
    try {
      await readFile(join(folder, ".opencode", "automation.json"));
      if (await registerConfigured(folder)) found.push(folder);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`${folder}: ${redact(error)}`); }
    const dirs = children.filter(d => d.isDirectory() && !d.name.startsWith(".") && !["node_modules", "vendor", "build", "dist"].includes(d.name));
    if (depth === 6) { if (dirs.length) warnings.push(`Discovery depth limit reached: ${folder}`); return; }
    for (const child of dirs) await walk(join(folder, child.name), depth + 1);
  };
  await walk(await realpath(directory), 0);
  return { found, warnings };
}

// Snapshot writes never control execution. They use independent files for each component.
export function publishRepositoryRuntime(owner: string, component: "dispatcher" | "scheduler", read: () => DispatcherMonitor | SchedulerMonitor, isStopped = () => false) {
  const canonical = realpath(owner);
  const write = async (stopped: boolean) => {
    const file = join(registryDirectory(), `${prefix(await canonical)}.${component}.json`);
    const data = read();
    await save(file, Runtime, { pid: process.pid, at: Date.now(), stopped: stopped || isStopped(),
      ...(component === "dispatcher" ? { dispatcher: DispatcherMonitor.parse(data) } : { scheduler: SchedulerMonitor.parse(data) }),
    });
  };
  const report = (error: unknown) => console.error("Repository status snapshot failed", redact(error));
  const stop = heartbeat(() => write(false), report, 5000);
  return async () => { await stop(); await write(true).catch(report); };
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function readRuntime(owner: string, component: string) {
  try {
    const value = Runtime.parse(JSON.parse(await readFile(join(registryDirectory(), `${prefix(owner)}.${component}.json`), "utf8")));
    if (component === "dispatcher" ? !value.dispatcher : !value.scheduler) throw new Error("Missing component snapshot");
    return value;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error(`Invalid or unreadable ${component} snapshot`, { cause: error }); }
}
export async function listRepositories(now = Date.now()): Promise<RepositoryReport> {
  const report: RepositoryReport = { entries: [], warnings: [] };
  let files: string[];
  try { files = await readdir(registryDirectory()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return report; throw error; }
  for (const file of files.filter(f => /^[a-f0-9]{64}\.json$/.test(f)).sort()) {
    try {
      const registration = Registration.parse(JSON.parse(await readFile(join(registryDirectory(), file), "utf8")));
      for (const entry of registration.entries) {
        const row: RepositoryRow = { ...entry, status: "unavailable" };
        report.entries.push(row);
        try {
          const [d, s] = await Promise.all([readRuntime(entry.ownerDirectory, "dispatcher"), readRuntime(entry.ownerDirectory, "scheduler")]);
          row.dispatcher = d?.dispatcher; row.dispatcherAt = d?.at; row.scheduler = s?.scheduler; row.schedulerAt = s?.at;
          const fresh = (v?: Runtime) => Boolean(v && !v.stopped && alive(v.pid) && now >= v.at && now - v.at <= 15000);
          if (!d || d.stopped || !alive(d.pid)) {
            row.status = "not-running"; row.reason = "Configured; dispatcher is not running or has not reported since registration. Snapshots, if present, are historical.";
          } else if (!fresh(d) || !fresh(s) || !s?.scheduler?.length) {
            row.reason = "Runtime status unavailable or stale. Retained snapshots are historical, not proof of activity.";
          } else if (d.dispatcher?.worker === "stopped" || d.dispatcher?.scanError || s?.scheduler?.some(j => j.failures > 0)) {
            row.status = "error"; row.reason = "Dispatcher stopped or the latest scan/job failed. Inspect the details.";
          } else row.status = s?.scheduler?.length && s.scheduler.every(j => j.paused) ? "paused" : "running";
        } catch (error) { row.reason = redact(error); }
        try {
          if (!(await stat(entry.directory)).isDirectory() || !(await stat(entry.ownerDirectory)).isDirectory()) throw new Error("Not a directory");
        } catch (error) {
          row.status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable";
          row.reason = "Registered directory is missing, moved, or inaccessible. No files have been removed."; continue;
        }
        if (entry.configFile) {
          try { EasyOptions.parse(JSON.parse(await readFile(entry.configFile, "utf8"))); }
          catch (error) {
            row.status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "unconfigured" : "error";
            row.reason = "Project configuration is missing, invalid, or unreadable. A previously loaded runtime may still be active.";
          }
        }
      }
    } catch { report.warnings.push(`Invalid or unreadable registry record: ${file}`); }
  }
  report.entries.sort((a, b) => a.directory.localeCompare(b.directory) || a.repo.localeCompare(b.repo));
  return report;
}
