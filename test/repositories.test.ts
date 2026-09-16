import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discoverRepositories, listRepositories, publishRepositoryRuntime, registerConfigured, registerRepositories, registryDirectory } from "../src/repositories.js";
import { formatRepositories, repositoryDetails, type RepositoryEntry } from "../src/repository-report.js";
import type { DispatcherMonitor, SchedulerMonitor } from "../src/monitor.js";
import { run } from "../src/easy.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc2-repositories-")));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  const project = join(root, "project");
  await mkdir(project);
  const entry: RepositoryEntry = { ownerDirectory: project, directory: project, repo: "owner/repo", baseBranch: "main", stateDirectory: join(project, ".git", "opencode2-automation"), registeredAt: Date.now() };
  const dispatcher: DispatcherMonitor = { ownerDirectory: project, worker: "idle", scanning: false, tasks: [] };
  const scheduler: SchedulerMonitor = [{ id: "github-issues", paused: false, running: false, nextAt: Date.now(), failures: 0 }];
  return { root, project, entry, dispatcher, scheduler, async cleanup() {
    if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous;
    await rm(root, { recursive: true, force: true });
  } };
}
async function waitFor(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail("Snapshot was not published");
}

test("inventory is read-only and distinguishes active, paused, stale, stopped and missing owners", async () => {
  const f = await fixture(); let stopD: (() => Promise<void>) | undefined, stopS: (() => Promise<void>) | undefined;
  try {
    await registerRepositories([f.entry]);
    assert.equal((await listRepositories()).entries[0]?.status, "not-running");
    stopD = publishRepositoryRuntime(f.project, "dispatcher", () => f.dispatcher);
    stopS = publishRepositoryRuntime(f.project, "scheduler", () => f.scheduler);
    await waitFor(async () => (await listRepositories()).entries[0]?.status === "running");
    const names = await readdir(registryDirectory());
    const before = await Promise.all(names.map(n => readFile(join(registryDirectory(), n), "utf8")));
    await listRepositories(); await listRepositories();
    assert.deepEqual(await Promise.all(names.map(n => readFile(join(registryDirectory(), n), "utf8"))), before);
    assert.equal((await listRepositories(Date.now() + 16000)).entries[0]?.status, "unavailable");
    await stopS(); stopS = undefined;
    f.scheduler[0]!.paused = true;
    stopS = publishRepositoryRuntime(f.project, "scheduler", () => f.scheduler);
    await waitFor(async () => (await listRepositories()).entries[0]?.status === "paused");
    await stopD(); stopD = undefined;
    assert.equal((await listRepositories()).entries[0]?.status, "not-running");
    await rm(f.project, { recursive: true });
    assert.equal((await listRepositories()).entries[0]?.status, "missing");
  } finally { await stopD?.(); await stopS?.(); await f.cleanup(); }
});

test("dead processes and corrupt snapshots never look healthy; damaged records do not hide other repositories", async () => {
  const f = await fixture();
  try {
    await registerRepositories([f.entry]);
    const meta = (await readdir(registryDirectory()))[0]!;
    const prefix = meta.replace(/\.json$/, "");
    await writeFile(join(registryDirectory(), `${prefix}.dispatcher.json`), JSON.stringify({ pid: 2147483647, at: Date.now(), stopped: false, dispatcher: f.dispatcher }));
    assert.equal((await listRepositories()).entries[0]?.status, "not-running");
    await writeFile(join(registryDirectory(), `${prefix}.dispatcher.json`), "broken");
    assert.equal((await listRepositories()).entries[0]?.status, "unavailable");
    await writeFile(join(registryDirectory(), `${"a".repeat(64)}.json`), "broken");
    const report = await listRepositories();
    assert.equal(report.entries.length, 1); assert.equal(report.warnings.length, 1);
  } finally { await f.cleanup(); }
});

test("migration finds old configurations without auth or service, deduplicates aliases and excludes worktrees", async () => {
  const f = await fixture();
  try {
    await run(f.project, ["git", "init", "-b", "main"]);
    await run(f.project, ["git", "remote", "add", "origin", "git@github.com:owner/repo.git"]);
    await run(f.project, ["git", "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "Initial"]);
    await mkdir(join(f.project, ".opencode"));
    const config = join(f.project, ".opencode", "automation.json");
    await writeFile(config, JSON.stringify({ model: "provider/model", check: false, baseBranch: "main" }));
    const worker = join(f.root, "worker");
    await run(f.project, ["git", "worktree", "add", "-b", "task", worker]);
    await mkdir(join(worker, ".opencode"));
    await writeFile(join(worker, ".opencode", "automation.json"), await readFile(config));
    const alias = join(f.root, "alias"); await symlink(f.project, alias);
    const result = await discoverRepositories(f.root);
    assert.deepEqual(result.found, [f.project]); assert.deepEqual(result.warnings, []);
    assert.equal(await registerConfigured(worker), false);
    await registerConfigured(alias);
    const report = await listRepositories(); assert.equal(report.entries.length, 1);
    assert.equal(report.entries[0]?.repo, "owner/repo"); assert.equal(report.entries[0]?.directory, f.project);
    await rm(config);
    assert.equal((await listRepositories()).entries[0]?.status, "unconfigured");
    await writeFile(config, "broken");
    assert.equal((await listRepositories()).entries[0]?.status, "error");
  } finally { await f.cleanup(); }
});

test("independent concurrent registrations do not overwrite each other and multi-repository owners remain distinct", async () => {
  const f = await fixture();
  try {
    const other = join(f.root, "other"); await mkdir(other);
    await Promise.all([
      registerRepositories([f.entry, { ...f.entry, repo: "owner/second", directory: other }]),
      registerRepositories([{ ...f.entry, ownerDirectory: other, directory: other, repo: "owner/third" }]),
    ]);
    assert.equal((await listRepositories()).entries.length, 3);
  } finally { await f.cleanup(); }
});

test("reports show concrete issue failures without counting closed history or implying queued work is executing", async () => {
  const f = await fixture();
  try {
    const task = { key: "owner/repo#7", repo: "owner/repo", issueNumber: 7, round: 1, status: "blocked", phase: "running", sessionReady: true, error: "Session failed\u001b[2J" };
    const details = repositoryDetails({ ...f.entry, status: "running", dispatcher: { ...f.dispatcher, tasks: [task, { ...task, key: "owner/repo#8", status: "closed" }, { ...task, key: "owner/other#9", repo: "owner/other" }] }, scheduler: f.scheduler });
    assert.match(details, /Active: 0 · Scheduled: 0 · Waiting: 0 · Blocked\/failed: 1/);
    assert.match(details, /owner\/repo#7: blocked/); assert.doesNotMatch(details, /#8|#9/); assert.equal(details.includes("\u001b"), false);
    assert.match(formatRepositories({ entries: [], warnings: [] }), /list --discover/);
  } finally { await f.cleanup(); }
});

test("CLI list works outside Git without a service and returns machine-readable inventory", async () => {
  const f = await fixture();
  try {
    await registerRepositories([f.entry]);
    const cli = resolve("src/setup.ts"), tsx = resolve("node_modules/tsx/dist/loader.mjs");
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", tsx, cli, "list", "--json"], { cwd: f.root, env: process.env });
    assert.equal(JSON.parse(stdout).entries[0].repo, "owner/repo");
  } finally { await f.cleanup(); }
});


test("fresh scan failures are errors, whereas a missing scheduler or aborted scheduler is unavailable", async () => {
  const f = await fixture(); let stopD: (() => Promise<void>) | undefined, stopS: (() => Promise<void>) | undefined;
  try {
    await registerRepositories([f.entry]);
    f.dispatcher.scanError = "GitHub unavailable";
    stopD = publishRepositoryRuntime(f.project, "dispatcher", () => f.dispatcher);
    await waitFor(async () => Boolean((await listRepositories()).entries[0]?.dispatcher));
    assert.equal((await listRepositories()).entries[0]?.status, "unavailable");
    stopS = publishRepositoryRuntime(f.project, "scheduler", () => f.scheduler);
    await waitFor(async () => (await listRepositories()).entries[0]?.status === "error");
    await stopS(); stopS = undefined;
    stopS = publishRepositoryRuntime(f.project, "scheduler", () => f.scheduler, () => true);
    await waitFor(async () => (await listRepositories()).entries[0]?.status === "unavailable");
    assert.match(repositoryDetails((await listRepositories()).entries[0]!), /Scan error: GitHub unavailable/);
  } finally { await stopD?.(); await stopS?.(); await f.cleanup(); }
});
