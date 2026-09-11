import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/release-version.mjs", import.meta.url));
async function fixture(version = "0.0.0") {
  const directory = await mkdtemp(join(tmpdir(), "oc2-release-"));
  const pkg = { name: "opencode2-automation", version, private: true, scripts: { postinstall: "node scripts/postinstall.mjs" } };
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {
    "": { name: pkg.name, version: pkg.version }, "node_modules/example": { version: "8.0.0", integrity: "unchanged" },
  } };
  await writeFile(join(directory, "package.json"), JSON.stringify(pkg));
  await writeFile(join(directory, "package-lock.json"), JSON.stringify(lock));
  const output = join(directory, "github-output");
  return { directory, pkg, lock, output,
    run: (tag?: string) => exec(process.execPath, [script, ...(tag === undefined ? [] : [tag])], { cwd: directory, env: { ...process.env, GITHUB_OUTPUT: output } }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

for (const [tag, version, prerelease] of [
  ["v1.2.3", "1.2.3", false],
  ["1.2.3", "1.2.3", false],
  ["v2.0.0-beta.1", "2.0.0-beta.1", true],
  ["v1.2.3+build.4", "1.2.3+build.4", false],
  ["1.2.3-rc.2+build.4", "1.2.3-rc.2+build.4", true],
] as const) {
  test(`release tag ${tag} validates committed versions without changing manifests and reports prerelease status`, async () => {
    const f = await fixture(version);
    try {
      await f.run(tag);
      assert.equal(await readFile(join(f.directory, "package.json"), "utf8"), JSON.stringify(f.pkg));
      assert.equal(await readFile(join(f.directory, "package-lock.json"), "utf8"), JSON.stringify(f.lock));
      assert.equal(await readFile(f.output, "utf8"), `version=${version}\nprerelease=${prerelease}\n`);
    } finally { await f.cleanup(); }
  });
}

test("invalid or missing release tags cannot change manifests or inject workflow outputs", async () => {
  const f = await fixture();
  try {
    for (const tag of [undefined, "", "latest", "v1.2", "v01.2.3", "v1.2.3-01", "vv1.2.3", "refs/tags/v1.2.3", "v1.2.3\nprerelease=false", "1.2.3$(false)"]) {
      await assert.rejects(f.run(tag), /Expected a SemVer tag/);
      assert.equal(await readFile(join(f.directory, "package.json"), "utf8"), JSON.stringify(f.pkg));
      assert.equal(await readFile(join(f.directory, "package-lock.json"), "utf8"), JSON.stringify(f.lock));
      await assert.rejects(readFile(f.output), { code: "ENOENT" });
    }
  } finally { await f.cleanup(); }
});

test("a mismatched lockfile fails without changing either manifest", async () => {
  const f = await fixture("1.2.3");
  try {
    await writeFile(join(f.directory, "package-lock.json"), JSON.stringify({ ...f.lock, name: "another-package" }));
    await assert.rejects(f.run("v1.2.3"), /same root package/);
    assert.equal(await readFile(join(f.directory, "package.json"), "utf8"), JSON.stringify(f.pkg));
  } finally { await f.cleanup(); }
});

for (const field of ["package", "lock", "lock root"] as const) {
  test(`a mismatched ${field} version blocks the release without changing manifests or emitting outputs`, async () => {
    const f = await fixture("1.2.3");
    try {
      if (field === "package") f.pkg.version = "1.2.2";
      if (field === "lock") f.lock.version = "1.2.2";
      if (field === "lock root") f.lock.packages[""].version = "1.2.2";
      await writeFile(join(f.directory, "package.json"), JSON.stringify(f.pkg));
      await writeFile(join(f.directory, "package-lock.json"), JSON.stringify(f.lock));
      await assert.rejects(f.run("v1.2.3"), /Release tag v1\.2\.3 must match/);
      assert.equal(await readFile(join(f.directory, "package.json"), "utf8"), JSON.stringify(f.pkg));
      assert.equal(await readFile(join(f.directory, "package-lock.json"), "utf8"), JSON.stringify(f.lock));
      await assert.rejects(readFile(f.output), { code: "ENOENT" });
    } finally { await f.cleanup(); }
  });
}
