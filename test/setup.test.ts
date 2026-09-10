import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
test("configuration command writes one field and never overwrites existing settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc2-init-"));
  try {
    await exec("git", ["init", "-b", "main"], { cwd: dir });
    await exec("git", ["remote", "add", "origin", "git@github.com:owner/repo.git"], { cwd: dir });
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    const mock = join(dir, "github-mock.mjs");
    await writeFile(mock, 'globalThis.fetch = async url => { if (!String(url).startsWith("https://api.github.com/")) throw new Error("Unexpected network request"); return Response.json(String(url).endsWith("/user") ? {login:"alice"} : {default_branch:"main"}); };');
    const args = ["--import", import.meta.resolve("tsx"), "--import", mock, fileURLToPath(new URL("../src/setup.ts", import.meta.url)), "init", "--model", "provider/model"];
    const result = await exec(process.execPath, args, { cwd: dir, env: { ...process.env, GITHUB_TOKEN: "fixture-secret" } });
    assert.match(result.stdout, /Gotowe: owner\/repo/);
    assert.ok(!result.stdout.includes("fixture-secret"));
    const path = join(dir, ".opencode", "automation.json");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { model: "provider/model" });
    await rm(path);
    await rm(join(dir, "package.json"));
    const skipped = await exec(process.execPath, [...args, "--skip-tests"], { cwd: dir, env: { ...process.env, GITHUB_TOKEN: "fixture-secret" } });
    assert.match(skipped.stdout, /pominięte/);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { model: "provider/model", check: false });
    await writeFile(path, JSON.stringify({ model: "provider/model" }));
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    await assert.rejects(exec(process.execPath, args, { cwd: dir, env: { ...process.env, GITHUB_TOKEN: "fixture-secret" } }));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { model: "provider/model" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
