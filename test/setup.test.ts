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
    const args = ["--import", import.meta.resolve("tsx"), "--import", mock, fileURLToPath(new URL("../src/setup.ts", import.meta.url)), "init", "--model", "provider/model", "--yes"];
    const result = await exec(process.execPath, args, { cwd: dir, env: { ...process.env, GITHUB_TOKEN: "fixture-secret" } });
    assert.match(result.stdout, /Ready: owner\/repo/);
    assert.ok(!result.stdout.includes("fixture-secret"));
    const path = join(dir, ".opencode", "automation.json");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { model: "provider/model" });
    await rm(path);
    await rm(join(dir, "package.json"));
    const skipped = await exec(process.execPath, [...args, "--skip-tests"], { cwd: dir, env: { ...process.env, GITHUB_TOKEN: "fixture-secret" } });
    assert.match(skipped.stdout, /skipped/);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { model: "provider/model", check: false });
    await writeFile(path, JSON.stringify({ model: "provider/model" }));
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    await assert.rejects(exec(process.execPath, args, { cwd: dir, env: { ...process.env, GITHUB_TOKEN: "fixture-secret" } }));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { model: "provider/model" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("interactive CLI saves account-derived defaults and displays English prompts", async () => {
  const { spawn } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "oc2-interactive-"));
  try {
    await exec("git", ["init", "-b", "main"], { cwd: dir });
    await exec("git", ["remote", "add", "origin", "git@github.com:owner/repo.git"], { cwd: dir });
    const mock = join(dir, "interactive-mock.mjs");
    await writeFile(mock, 'Object.defineProperty(process.stdin,"isTTY",{value:true});globalThis.fetch=async url=>{if(!String(url).startsWith("https://api.github.com/"))throw new Error("Unexpected network request");return Response.json(String(url).endsWith("/user")?{login:"alice"}:{default_branch:"main"})};');
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--import", mock, fileURLToPath(new URL("../src/setup.ts", import.meta.url)), "init", "--model", "provider/model", "--capabilities", "text,vision", "--base-branch", "main"], { cwd: dir, env: { ...process.env, GITHUB_TOKEN: "fixture-secret" }, stdio: ["pipe", "pipe", "pipe"] });
      let output = "", error = "", pending = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("Wizard timed out")); }, 15000);
      child.stdout.on("data", chunk => {
        const text = String(chunk); output += text; pending += text;
        if (pending.endsWith(": ")) { pending = ""; child.stdin.write("\n"); }
      });
      child.stderr.on("data", chunk => { error += chunk; });
      child.on("error", err => { clearTimeout(timer); reject(err); });
      child.on("close", code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(error)); });
    });
    assert.match(output, /Message signature \[alice\[OpenCode2\]\]/);
    assert.match(output, /Allowed GitHub users/); assert.match(output, /Ready: owner\/repo/);
    assert.ok(!output.includes("d3cker")); assert.ok(!output.includes("fixture-secret"));
    const saved = JSON.parse(await readFile(join(dir, ".opencode/automation.json"), "utf8"));
    assert.equal(saved.trigger, "@opencodebot"); assert.equal(saved.signature, "alice[OpenCode2]");
    assert.deepEqual(saved.authors, ["alice"]); assert.equal(saved.check, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
