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
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "oc2-release-"));
  const pkg = { name: "opencode2-automation", version: "0.0.0", private: true, scripts: { postinstall: "node scripts/postinstall.mjs" } };
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
  test(`release tag ${tag} versions both manifests and reports prerelease status`, async () => {
    const f = await fixture();
    try {
      await f.run(tag);
      const pkg = JSON.parse(await readFile(join(f.directory, "package.json"), "utf8"));
      const lock = JSON.parse(await readFile(join(f.directory, "package-lock.json"), "utf8"));
      assert.deepEqual(pkg, { ...f.pkg, version });
      assert.deepEqual(lock, { ...f.lock, version, packages: { ...f.lock.packages, "": { ...f.lock.packages[""], version } } });
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

test("a mismatched lockfile fails before either manifest is versioned", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "package-lock.json"), JSON.stringify({ ...f.lock, name: "another-package" }));
    await assert.rejects(f.run("v1.2.3"), /same root package/);
    assert.equal(await readFile(join(f.directory, "package.json"), "utf8"), JSON.stringify(f.pkg));
  } finally { await f.cleanup(); }
});
