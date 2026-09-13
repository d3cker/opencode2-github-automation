import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { releaseNotes } from "../scripts/release-notes.mjs";
import { updateReadme } from "../scripts/update-release-readme.mjs";

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
