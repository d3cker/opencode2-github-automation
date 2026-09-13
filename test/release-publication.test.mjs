import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { releaseNotes } from "../scripts/release-notes.mjs";
import { syncReadme, updateReadme } from "../scripts/update-release-readme.mjs";

const repository = "example/automation";
const readme = "# Product\n\n<!-- latest-release:start -->\nold install\n<!-- latest-release:end -->\n\nOther instructions.\n";
function release(version = "0.6.2", tag = `v${version}`) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: ["tgz", "tgz.sha256"].map(extension => ({
      name: `opencode2-automation-${version}.${extension}`,
      state: "uploaded",
      browser_download_url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/opencode2-automation-${encodeURIComponent(version)}.${extension}`,
    })),
  };
}
function file(content, sha = "original-sha") {
  return { encoding: "base64", sha, content: Buffer.from(content).toString("base64") };
}

test("release notes select only the exact tagged version regardless of surrounding releases", () => {
  const changelog = "# Changelog\n\n## Unreleased\n- Future\n\n## 0.6.2\n### Fixed\n- Keep owner active\n\n## 0.6.1\n- Banner\n";
  assert.equal(releaseNotes(changelog, "v0.6.2"), "### Fixed\n- Keep owner active\n");
  assert.equal(releaseNotes(changelog.replaceAll("\n", "\r\n"), "0.6.1"), "- Banner\n");
  assert.equal(releaseNotes("## 0.7.0-beta.1\n- Preview\n", "v0.7.0-beta.1"), "- Preview\n");
});

test("missing, empty, duplicate, and invalid release sections fail instead of guessing notes", () => {
  for (const changelog of ["## Unreleased\n- Pending", "## 0.6.2\n\n## 0.6.1\n- Old", "## 0.6.2\n- One\n## 0.6.2\n- Two", "## 0.6.2\n### Fixed"]) {
    assert.throws(() => releaseNotes(changelog, "v0.6.2"), /CHANGELOG.md/);
  }
  for (const tag of ["v0.6", "v0.6.2\n", "Unreleased"]) {
    assert.throws(() => releaseNotes("## 0.6.2\n- Fix", tag), /SemVer/);
  }
});

test("the recorded 0.6.2 notes describe lifecycle fixes rather than the previous release", async () => {
  const notes = releaseNotes(await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8"), "v0.6.2");
  assert.match(notes, /heartbeat/);
  assert.match(notes, /cleanup/);
  assert.doesNotMatch(notes, /0\.6\.1|banner/i);
});

test("README links uploaded versioned assets and preserves all surrounding content", () => {
  const updated = updateReadme(readme, release(), repository);
  assert.match(updated, /npm install --global --prefix "\$HOME\/\.local" "https:\/\/github\.com\/example\/automation\/releases\/download\/v0\.6\.2\/opencode2-automation-0\.6\.2\.tgz"/);
  assert.match(updated, /opencode2-automation-0\.6\.2\.tgz\.sha256/);
  assert.ok(updated.startsWith("# Product\n\n"));
  assert.ok(updated.endsWith("\n\nOther instructions.\n"));
  assert.equal(updateReadme(updated, release(), repository), updated);
  assert.match(updateReadme(readme, release("0.6.3", "0.6.3"), repository), /download\/0\.6\.3\//);
});

test("README refuses drafts, prereleases, absent assets, and untrusted download URLs", () => {
  const invalid = [
    { ...release(), draft: true },
    { ...release(), prerelease: true },
    release("0.7.0-beta.1"),
    { ...release(), assets: [] },
    { ...release(), assets: release().assets.slice(0, 1) },
  ];
  for (const change of [
    { state: "starter" },
    { browser_download_url: "https://example.com/package.tgz" },
    { browser_download_url: release().assets[0].browser_download_url + '?x=$(env)' },
  ]) {
    const candidate = release();
    Object.assign(candidate.assets[0], change);
    invalid.push(candidate);
  }
  for (const candidate of invalid) assert.throws(() => updateReadme(readme, candidate, repository));
});

test("README refuses missing, duplicate, or reversed markers", () => {
  for (const content of ["# README", readme + readme, "<!-- latest-release:end --><!-- latest-release:start -->"]) {
    assert.throws(() => updateReadme(content, release(), repository), /marker/);
  }
});

test("a delayed updater queries latest and writes only the default-branch README with its SHA", async () => {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === `/repos/${repository}`) return { default_branch: "main" };
    if (path.endsWith("?ref=main")) return file(readme);
    if (path.endsWith("/latest")) return release("0.6.4");
    assert.equal(method, "PUT");
    return {};
  };
  assert.equal(await syncReadme(repository, request), "Updated README on main to v0.6.4.");
  const put = calls.at(-1);
  assert.equal(put.path, `/repos/${repository}/contents/README.md`);
  assert.equal(put.body.sha, "original-sha");
  assert.equal(put.body.branch, "main");
  assert.equal(Buffer.from(put.body.content, "base64").toString(), updateReadme(readme, release("0.6.4"), repository));
});

test("an up-to-date README produces no commit", async () => {
  const updated = updateReadme(readme, release(), repository);
  const request = async (method, path) => {
    assert.equal(method, "GET");
    if (path.endsWith("/latest")) return release();
    if (path.includes("/contents/")) return file(updated);
    return { default_branch: "master" };
  };
  assert.match(await syncReadme(repository, request), /already points to v0.6.2/);
});

test("a conflicting edit retries with fresh content, SHA, and latest release", async () => {
  let writes = 0;
  const concurrent = readme.replace("Other instructions.", "Someone else's new instructions.");
  const request = async (method, path, body) => {
    if (method === "PUT") {
      writes++;
      if (writes === 1) throw Object.assign(new Error("Conflict"), { status: 409 });
      assert.equal(body.sha, "new-sha");
      const content = Buffer.from(body.content, "base64").toString();
      assert.match(content, /Someone else's new instructions/);
      assert.match(content, /v0\.6\.3/);
      return {};
    }
    if (path.endsWith("/latest")) return release(writes ? "0.6.3" : "0.6.2");
    if (path.includes("/contents/")) return file(writes ? concurrent : readme, writes ? "new-sha" : "original-sha");
    return { default_branch: "main" };
  };
  assert.match(await syncReadme(repository, request), /v0.6.3/);
  assert.equal(writes, 2);
});

test("write failures are surfaced and conflict retries are bounded", async () => {
  for (const status of [403, 409, 422]) {
    let writes = 0;
    const request = async (method, path) => {
      if (method === "PUT") {
        writes++;
        throw Object.assign(new Error("Write failed"), { status });
      }
      if (path.endsWith("/latest")) return release();
      if (path.includes("/contents/")) return file(readme);
      return { default_branch: "main" };
    };
    await assert.rejects(syncReadme(repository, request), /Write failed/);
    assert.equal(writes, status === 409 ? 3 : 1);
  }
});
