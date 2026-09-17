import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EasyOptions, detectCheck, resolveEasy, type Run } from "../src/easy.js";
import bundle from "../src/index.js";

test("one package exports a V2 plugin and accepts a one-field configuration", () => {
  assert.equal(bundle.id, "automation");
  assert.equal(EasyOptions.parse({ model: "provider/model" }).everySeconds, 60);
  assert.throws(() => EasyOptions.parse({ model: "model-without-provider" }));
});

test("check detection follows lockfiles and never invents a check for unsupported projects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc2-easy-"));
  try {
    assert.equal(await detectCheck(directory), undefined);
    await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    assert.deepEqual(await detectCheck(directory), ["npm", "test"]);
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: 9");
    assert.deepEqual(await detectCheck(directory), ["pnpm", "test"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("minimal setup resolves repository, account, branch, private state and both plugins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc2-defaults-"));
  await mkdir(join(directory, ".git"));
  const calls: string[] = [];
  const execute: Run = async (_, args) => {
    calls.push(args.join(" "));
    if (args[0] === "gh") return "test-token";
    if (args.includes("--show-toplevel")) return directory;
    if (args.includes("--git-common-dir") || args.includes("--absolute-git-dir")) return join(directory, ".git");
    return "git@github.com:owner/project.git";
  };
  const fetcher: typeof fetch = async url => Response.json(String(url).endsWith("/user") ? { login: "alice" } : { default_branch: "develop" });
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    const result = await resolveEasy(directory, { model: "deepseek/model/variant" }, execute, fetcher);
    assert.equal(result.repo, "owner/project");
    assert.equal(result.github.repositories[0]?.autoApproveRepositoryFiles, undefined);
    assert.deepEqual(result.github.repositories[0]?.allowedAuthors, ["alice"]);
    assert.equal(result.github.repositories[0]?.baseBranch, "develop");
    assert.equal(result.github.routes["@opencodebot"]?.model.id, "model/variant");
    assert.equal(result.scheduler.jobs[0]?.everySeconds, 60);
    assert.equal(result.scheduler.stateDirectory, result.github.stateDirectory);
    assert.ok(result.github.stateDirectory.endsWith("/.git/opencode2-automation"));
    const overridden = await resolveEasy(directory, { model: "provider/model", trigger: "@fix", autoApproveRepositoryFiles: true, everySeconds: 120, authors: ["bob"], check: ["pytest", "-q"] }, execute, fetcher);
    assert.equal(overridden.github.repositories[0]?.autoApproveRepositoryFiles, true);
    assert.deepEqual(overridden.github.repositories[0]?.checks, [["pytest", "-q"]]);
    assert.deepEqual(overridden.github.repositories[0]?.allowedAuthors, ["bob"]);
    assert.equal(overridden.scheduler.jobs[0]?.everySeconds, 120);
    const skipped = await resolveEasy(directory, { model: "provider/model", check: false }, execute, fetcher);
    assert.deepEqual(skipped.github.repositories[0]?.checks, []);
    assert.equal(skipped.check, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("global installation stays inactive outside git and in unconfigured repositories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc2-inactive-"));
  try {
    const result = await bundle.setup({ location: { directory: dir }, options: {} } as never);
    assert.equal(result, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
