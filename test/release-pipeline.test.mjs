import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { githubClient, prepareChangelog, releaseRequest, runRelease, syncDevel, verifyFeature, verifyPromotion } from "../scripts/release-pipeline.mjs";
import { updateReadme } from "../scripts/update-release-readme.mjs";

const exec = promisify(execFile);
const repository = "example/automation";
const template = "# Product\n\n<!-- latest-release:start -->\nold\n<!-- latest-release:end -->\n\nInstructions.\n";
function assetRelease(tag) {
  const version = tag.replace(/^v/, "");
  return { tag_name: tag, html_url: `https://github.com/${repository}/releases/tag/${tag}`, draft: false, prerelease: false,
    assets: ["tgz", "tgz.sha256"].map(ext => ({ name: `opencode2-automation-${version}.${ext}`, state: "uploaded",
      browser_download_url: `https://github.com/${repository}/releases/download/${tag}/opencode2-automation-${version}.${ext}` })),
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "oc2-release-pipeline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "checkout"), remote = join(root, "remote.git");
  await mkdir(cwd);
  const git = async (...args) => (await exec("git", args, { cwd })).stdout.trim();
  const bare = async (...args) => (await exec("git", ["--git-dir", remote, ...args])).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.com");
  await git("config", "commit.gpgsign", "false");
  const pkg = { name: "opencode2-automation", version: "0.6.2", private: true };
  await writeFile(join(cwd, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  await writeFile(join(cwd, "package-lock.json"), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { "": { ...pkg } } }, null, 2) + "\n");
  await writeFile(join(cwd, "README.md"), updateReadme(template, assetRelease("v0.6.2"), repository));
  await writeFile(join(cwd, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n## 0.6.2\n- Previous fix\n");
  await writeFile(join(cwd, "code.txt"), "original\n");
  await git("add", ".");
  await git("commit", "-m", "Initial published version");
  const main = await git("rev-parse", "HEAD");
  await git("init", "--bare", remote);
  await git("remote", "add", "origin", remote);
  await git("branch", "release");
  await git("branch", "devel");
  await git("push", "origin", "main", "release", "devel");
  // Model a protected main at the Git transport boundary, not just with a mock.
  await writeFile(join(remote, "hooks/pre-receive"), '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/main" ]; then exit 1; fi\ndone\n', { mode: 0o755 });
  await git("switch", "release");
  const eventFor = sha => ({ action: "closed", repository: { full_name: repository }, pull_request: {
    number: 7, merged: true, merge_commit_sha: sha, base: { ref: "release" }, head: { ref: "devel", repo: { full_name: repository } },
  } });
  async function mergeFeature(number = 7) {
    await git("switch", "devel");
    await git("merge", "--ff-only", "origin/devel");
    await git("switch", "-c", `feature/${number}`);
    await writeFile(join(cwd, "code.txt"), `feature ${number}\n`);
    const changelog = await readFile(join(cwd, "CHANGELOG.md"), "utf8");
    await writeFile(join(cwd, "CHANGELOG.md"), changelog.replace("## Unreleased", `## Unreleased\n- Implement feature ${number}`));
    await git("add", ".");
    await git("commit", "-m", `Feature ${number}`);
    await git("switch", "devel");
    await git("merge", "--no-ff", `feature/${number}`, "-m", `Merge PR #${number}`);
    await git("push", "origin", "devel");
    await git("switch", "release");
    await git("merge", "--no-ff", "devel", "-m", `Merge devel release PR #${number}`);
    await git("push", "origin", "release");
    const event = eventFor(await git("rev-parse", "HEAD"));
    event.pull_request.number = number;
    return event;
  }
  const event = await mergeFeature();
  const releases = new Map([["v0.6.2", assetRelease("v0.6.2")]]);
  const calls = [];
  let pull;
  const github = {
    release: async tag => releases.get(tag) ?? null,
    latest: async () => [...releases.values()].filter(r => !r.draft && !r.prerelease).at(-1),
    publish: async ({ tag }) => { calls.push(`publish:${tag}`); releases.set(tag, assetRelease(tag)); },
    promote: async data => {
      const latest = await github.latest();
      const readme = await bare("show", "refs/heads/release:README.md");
      assert.match(readme, new RegExp(latest.tag_name.replaceAll(".", "\\.")));
      calls.push("promote");
      pull = { ...data, html_url: "https://github.com/example/automation/pull/8" };
      return pull;
    },
  };
  const build = async ({ version }) => {
    calls.push(`build:${version}`);
    assert.equal(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).version, version);
    return { archive: "test.tgz", checksum: "test.tgz.sha256" };
  };
  const options = { cwd, repository, event, github, directory: join(root, "artifacts"), build };
  return { ...options, git, bare, main, calls, releases, mergeFeature,
    run: overrides => runRelease({ ...options, ...overrides }),
    pull: () => pull,
    promotionEvent: async () => ({ pull_request: { base: { ref: "main" }, head: { ref: "release", sha: await git("rev-parse", "HEAD"), repo: { full_name: repository } } } }),
  };
}

test("automatic patch publishes before README and PR, leaves protected main untouched, and retries without bumping", async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.tag, "v0.6.3");
  assert.deepEqual(f.calls, ["build:0.6.3", "publish:v0.6.3", "promote"]);
  assert.equal(await f.bare("rev-parse", "main"), f.main);
  assert.equal(await f.bare("rev-parse", "v0.6.3^"), f.event.pull_request.merge_commit_sha);
  const tagged = await f.bare("rev-parse", "v0.6.3^{commit}");
  const tip = await f.bare("rev-parse", "release");
  assert.equal(await f.bare("rev-parse", "devel"), tip);
  assert.notEqual(tip, tagged);
  assert.equal(await f.bare("diff", "--name-only", tagged, tip), "README.md");
  assert.match(await f.bare("show", "release:CHANGELOG.md"), /## 0\.6\.3\n- Implement feature 7/);
  assert.match(f.pull().body, /Implement feature 7/);
  await f.run();
  assert.equal(await f.bare("rev-parse", "release"), tip);
  assert.equal(await f.bare("rev-parse", "v0.6.3^{commit}"), tagged);
  assert.equal(f.calls.filter(c => c.startsWith("build")).length, 1);
  assert.match(await verifyPromotion({ ...f, event: await f.promotionEvent() }), /ready for review/);
});

test("a manual unprefixed 1.0.0 tag is published unchanged and the next merged PR produces 1.0.1", async t => {
  const f = await fixture(t);
  await exec("npm", ["version", "1.0.0", "--no-git-tag-version", "--ignore-scripts"], { cwd: f.cwd });
  const changelog = prepareChangelog(await readFile(join(f.cwd, "CHANGELOG.md"), "utf8"), "1.0.0");
  await writeFile(join(f.cwd, "CHANGELOG.md"), changelog);
  await f.git("add", ".");
  await f.git("commit", "-m", "Release 1.0.0");
  await f.git("tag", "-a", "1.0.0", "-m", "Release 1.0.0");
  await f.git("push", "--atomic", "origin", "release", "refs/tags/1.0.0");
  const event = { repository: { full_name: repository }, ref: "refs/tags/1.0.0", after: await f.git("rev-parse", "refs/tags/1.0.0") };
  assert.equal((await f.run({ event })).tag, "1.0.0");
  assert.deepEqual(f.calls, ["build:1.0.0", "publish:1.0.0", "promote"]);
  assert.equal(await f.git("tag", "--list", "v1.0.1"), "");
  const next = await f.mergeFeature(9);
  assert.equal((await f.run({ event: next })).tag, "v1.0.1");
  assert.equal(await f.bare("rev-parse", "main"), f.main);
});

test("package failure leaves README and PR unchanged; retry resumes the same version", async t => {
  const f = await fixture(t);
  const devel = await f.bare("rev-parse", "devel");
  const original = await f.bare("show", "release:README.md");
  await assert.rejects(f.run({ build: async () => { throw new Error("Package failed"); } }), /Package failed/);
  assert.equal(await f.bare("show", "release:README.md"), original);
  assert.equal(f.releases.has("v0.6.3"), false);
  assert.equal(f.pull(), undefined);
  assert.equal(await f.bare("rev-parse", "devel"), devel);
  assert.equal((await f.run()).tag, "v0.6.3");
  assert.equal(await f.git("tag", "--list", "v0.6.4"), "");
});

test("a lost publication response is recovered without repacking or republishing", async t => {
  const f = await fixture(t);
  const publish = f.github.publish;
  f.github.publish = async data => { await publish(data); throw new Error("Connection lost"); };
  await assert.rejects(f.run(), /Connection lost/);
  assert.equal(f.pull(), undefined);
  f.github.publish = publish;
  await f.run();
  assert.equal(f.calls.filter(c => c.startsWith("publish")).length, 1);
  assert.equal(f.calls.filter(c => c.startsWith("build")).length, 1);
  assert.ok(f.pull());
});

test("a failed PR request can be retried without creating another README or version commit", async t => {
  const f = await fixture(t);
  const promote = f.github.promote;
  f.github.promote = async () => { throw new Error("PR permission denied"); };
  await assert.rejects(f.run(), /PR permission denied/);
  const tip = await f.bare("rev-parse", "release");
  f.github.promote = promote;
  await f.run();
  assert.equal(await f.bare("rev-parse", "release"), tip);
  assert.equal(f.calls.filter(c => c.startsWith("publish")).length, 1);
});

test("unmerged PRs, main merges, ordinary pushes, and foreign repositories cannot release", () => {
  for (const event of [
    { ref: "refs/heads/release" }, { ref: "refs/heads/feature/test" },
    { action: "closed", pull_request: { merged: false, base: { ref: "release" } } },
    { action: "closed", pull_request: { merged: true, base: { ref: "main" } } },
    { action: "closed", pull_request: { merged: true, base: { ref: "devel" } } },
    { action: "closed", pull_request: { merged: true, base: { ref: "release" }, head: { ref: "feature/test", repo: { full_name: repository } } } },
    { action: "closed", pull_request: { merged: true, base: { ref: "release" }, head: { ref: "devel", repo: { full_name: "fork/automation" } } } },
    { ref: "refs/tags/v1.0.0", after: "bad" },
  ]) assert.throws(() => releaseRequest({ repository: { full_name: repository }, ...event }, repository));
  assert.throws(() => releaseRequest({ repository: { full_name: "another/repo" } }, repository));
});

test("a manual tag on an unmerged feature cannot publish", async t => {
  const f = await fixture(t);
  await f.git("switch", "-c", "feature/unmerged");
  await writeFile(join(f.cwd, "code.txt"), "unmerged");
  await f.git("commit", "-am", "Unmerged feature");
  await f.git("tag", "v1.0.0");
  await f.git("push", "origin", "refs/tags/v1.0.0");
  const event = { repository: { full_name: repository }, ref: "refs/tags/v1.0.0", after: await f.git("rev-parse", "HEAD") };
  await assert.rejects(f.run({ event }));
  assert.deepEqual(f.calls, []);
  assert.equal(await f.bare("rev-parse", "main"), f.main);
});

test("an empty changelog fails before the version changes", async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, "CHANGELOG.md"), "## Unreleased\n\n## 0.6.2\n- Old\n");
  await f.git("commit", "-am", "Empty notes");
  await f.git("push", "origin", "release");
  const event = structuredClone(f.event);
  event.pull_request.merge_commit_sha = await f.git("rev-parse", "HEAD");
  await assert.rejects(verifyFeature(f.cwd), /must contain release notes/);
  await assert.rejects(f.run({ event }), /must contain release notes/);
  assert.equal(JSON.parse(await f.bare("show", "release:package.json")).version, "0.6.2");
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("a partially uploaded draft is not promoted and can be repaired using the same tag", async t => {
  const f = await fixture(t);
  const publish = f.github.publish;
  f.github.publish = async ({ tag }) => {
    f.releases.set(tag, { ...assetRelease(tag), draft: true, assets: [] });
    throw new Error("Upload failed");
  };
  await assert.rejects(f.run(), /Upload failed/);
  assert.equal(f.pull(), undefined);
  assert.doesNotMatch(await f.bare("show", "release:README.md"), /v0\.6\.3/);
  f.github.publish = publish;
  await f.run();
  assert.equal(f.releases.get("v0.6.3").draft, false);
  assert.equal(await f.git("tag", "--list", "v0.6.4"), "");
});

test("published metadata without both uploaded assets cannot advance README or open a PR", async t => {
  const f = await fixture(t);
  const publish = f.github.publish;
  f.github.publish = async data => {
    await publish(data);
    f.releases.get(data.tag).assets.pop();
  };
  await assert.rejects(f.run(), /uploaded asset/);
  assert.equal(f.pull(), undefined);
  assert.doesNotMatch(await f.bare("show", "release:README.md"), /v0\.6\.3/);
});

test("new untagged code on release blocks both old publication retries and promotion", async t => {
  const f = await fixture(t);
  await f.run();
  await f.mergeFeature(10);
  await assert.rejects(f.run(), /changes beyond the tagged package/);
  await assert.rejects(verifyPromotion({ ...f, event: await f.promotionEvent() }), /changes beyond the tagged package/);
});

test("promotion rejects wrong source branches and unpublished or stale README contents", async t => {
  const f = await fixture(t);
  await f.run();
  const event = await f.promotionEvent();
  event.pull_request.head.ref = "feature/wrong";
  await assert.rejects(verifyPromotion({ ...f, event }), /Only a PR/);
  await writeFile(join(f.cwd, "README.md"), template);
  await f.git("commit", "-am", "Stale README");
  await assert.rejects(verifyPromotion({ ...f, event: await f.promotionEvent() }), /README does not point/);
});

test("GitHub promotion creates or updates only a release-to-main PR, with no content or ref writes", async t => {
  const calls = [];
  let existing = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    calls.push({ url, method: options.method, body });
    if (options.method === "GET") return Response.json(existing);
    assert.match(url, /\/pulls(?:\/8)?$/);
    if (options.method === "POST") {
      assert.equal(body.head, "release");
      assert.equal(body.base, "main");
      existing = [{ number: 8, html_url: "https://github.com/example/automation/pull/8" }];
    }
    return Response.json(existing[0]);
  });
  const client = githubClient(repository, "test-token");
  const first = await client.promote({ title: "Release v0.6.3", body: "Notes" });
  const retry = await client.promote({ title: "Release v0.6.4", body: "New notes" });
  assert.equal(first.html_url, retry.html_url);
  assert.deepEqual(calls.map(c => c.method), ["GET", "POST", "GET", "PATCH"]);
});

test("published release merges into ahead devel without losing new work or opening another PR", async t => {
  const f = await fixture(t);
  await f.git("switch", "devel");
  await writeFile(join(f.cwd, "next-feature.txt"), "Keep unreleased work\n");
  await f.git("add", ".");
  await f.git("commit", "-m", "Next development work");
  const work = await f.git("rev-parse", "HEAD");
  await f.git("push", "origin", "devel");
  await f.git("switch", "release");
  await f.run();
  const devel = await f.bare("rev-parse", "devel");
  const release = await f.bare("rev-parse", "release");
  await f.bare("merge-base", "--is-ancestor", work, devel);
  await f.bare("merge-base", "--is-ancestor", release, devel);
  assert.equal(await f.bare("show", "devel:next-feature.txt"), "Keep unreleased work");
  assert.match(await f.bare("show", "devel:README.md"), /v0\.6\.3/);
  assert.equal(JSON.parse(await f.bare("show", "devel:package.json")).version, "0.6.3");
  assert.equal(f.calls.filter(c => c === "promote").length, 1);
  await f.run();
  assert.equal(await f.bare("rev-parse", "devel"), devel);
  assert.equal(await f.bare("rev-parse", "main"), f.main);
});

test("devel merge conflicts preserve remote work and published release; retry does not republish", async t => {
  const f = await fixture(t);
  await f.git("switch", "devel");
  await writeFile(join(f.cwd, "README.md"), "Conflicting development README\n");
  await f.git("commit", "-am", "Concurrent README edit");
  const before = await f.git("rev-parse", "HEAD");
  await f.git("push", "origin", "devel");
  await f.git("switch", "release");
  await assert.rejects(f.run(), /release-to-devel merge conflicted/);
  assert.equal(await f.bare("rev-parse", "devel"), before);
  assert.equal(await f.git("status", "--porcelain"), "");
  assert.equal((await f.git("worktree", "list", "--porcelain")).split("worktree ").length, 2);
  assert.ok(f.pull());
  assert.equal(f.releases.get("v0.6.3").draft, false);
  // A maintainer resolves the conflict on devel, preserving its history.
  await f.git("switch", "devel");
  await writeFile(join(f.cwd, "README.md"), await f.bare("show", "release:README.md") + "\n");
  await f.git("commit", "-am", "Resolve published README conflict");
  await f.git("push", "origin", "devel");
  await f.git("switch", "release");
  await f.run();
  await f.bare("merge-base", "--is-ancestor", "release", "devel");
  assert.equal(f.calls.filter(c => c.startsWith("publish")).length, 1);
  assert.equal(f.calls.filter(c => c.startsWith("build")).length, 1);
});

test("devel protection rejection never bypasses branch rules or rolls back publication", async t => {
  const f = await fixture(t);
  const before = await f.bare("rev-parse", "devel");
  const remote = await f.git("remote", "get-url", "origin");
  await writeFile(join(remote, "hooks/pre-receive"), '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/main" ] || [ "$ref" = "refs/heads/devel" ]; then exit 1; fi\ndone\n', { mode: 0o755 });
  await assert.rejects(f.run(), /devel sync push failed/);
  assert.equal(await f.bare("rev-parse", "devel"), before);
  assert.ok(f.pull());
  assert.equal(await f.bare("rev-parse", "main"), f.main);
});

test("CI rejects a direct feature-to-release PR and permits devel promotion", async t => {
  const f = await fixture(t);
  const event = structuredClone(f.event);
  event.pull_request.head.ref = "feature/test";
  await assert.rejects(verifyFeature(f.cwd, event, repository), /Feature PRs must target devel/);
  assert.match(await verifyFeature(f.cwd, f.event, repository), /ready for patch/);
});

test("a concurrent devel update is merged on retry rather than overwritten", async t => {
  const f = await fixture(t);
  await f.run();
  await f.git("switch", "-c", "release-extra", "release");
  await writeFile(join(f.cwd, "published.txt"), "published\n");
  await f.git("add", ".");
  await f.git("commit", "-m", "Release update for sync test");
  const releaseHead = await f.git("rev-parse", "HEAD");
  await f.git("switch", "-c", "concurrent-devel", "origin/devel");
  await writeFile(join(f.cwd, "concurrent.txt"), "Concurrent development\n");
  await f.git("add", ".");
  await f.git("commit", "-m", "Concurrent work");
  const concurrent = await f.git("rev-parse", "HEAD");
  await f.git("push", "origin", "concurrent-devel");
  await f.git("switch", "release");
  const remote = await f.git("remote", "get-url", "origin");
  const hook = join(f.cwd, ".git/hooks/pre-push");
  // Advance the real remote after sync fetched its tip but before its first push.
  await writeFile(hook, `#!/bin/sh\nrm "$0"\ngit --git-dir='${remote}' update-ref refs/heads/devel ${concurrent}\n`, { mode: 0o755 });
  const result = await syncDevel({ cwd: f.cwd, releaseHead });
  assert.equal(result.changed, true);
  await f.bare("merge-base", "--is-ancestor", concurrent, "devel");
  await f.bare("merge-base", "--is-ancestor", releaseHead, "devel");
  assert.equal(await f.bare("show", "devel:concurrent.txt"), "Concurrent development");
});
