import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import semver from "semver";
import { releaseNotes, releaseVersion } from "./release-notes.mjs";
import { updateReadme } from "./update-release-readme.mjs";

const execute = promisify(execFile);
const statePath = ".github/release-state.json";
const releaseRef = "refs/remotes/origin/release";
const identity = ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com"];
const gitAt = cwd => async (...args) => (await execute("git", args, { cwd })).stdout.trim();

export function releaseRequest(event, repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Expected a GitHub OWNER/REPO.");
  if (event.repository?.full_name !== repository) throw new Error("Release event belongs to another repository.");
  if (event.action === "closed" && event.pull_request?.merged === true && event.pull_request.base?.ref === "release") {
    const pr = event.pull_request;
    if (pr.head?.ref !== "devel" || pr.head.repo?.full_name !== repository) {
      throw new Error("Automatic publication requires a same-repository devel-to-release PR.");
    }
    if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || !/^[a-f0-9]{40}$/.test(pr.merge_commit_sha)) {
      throw new Error("Merged PR must provide its number and merge commit.");
    }
    return { pullRequest: pr.number, sourceSHA: pr.merge_commit_sha };
  }
  if (event.ref?.startsWith("refs/tags/") && !event.deleted) {
    const tag = event.ref.slice("refs/tags/".length);
    releaseVersion(tag);
    if (!/^[a-f0-9]{40}$/.test(event.after)) throw new Error("Tag event must provide its object SHA.");
    return { tag, tagObject: event.after };
  }
  throw new Error("Release requires a merged PR into release or a pushed version tag.");
}

export function prepareChangelog(changelog, version) {
  if ([...changelog.matchAll(/^## Unreleased\r?$/gm)].length !== 1) throw new Error("CHANGELOG.md needs exactly one Unreleased section.");
  if ([...changelog.matchAll(/^## (.+)\r?$/gm)].some(match => match[1].trim() === version)) {
    throw new Error(`CHANGELOG.md already contains ${version}.`);
  }
  const updated = changelog.replace(/^## Unreleased\r?$/m, `## Unreleased\n\n## ${version}`);
  releaseNotes(updated, version);
  return updated;
}

async function manifest(git, ref) {
  const pkg = JSON.parse(await git("show", `${ref}:package.json`));
  const lock = JSON.parse(await git("show", `${ref}:package-lock.json`));
  if (pkg.name !== "opencode2-automation" || lock.name !== pkg.name || lock.packages?.[""]?.name !== pkg.name ||
      pkg.version !== lock.version || pkg.version !== lock.packages[""].version) {
    throw new Error("Package and lockfile names and root versions must match.");
  }
  releaseVersion(pkg.version);
  return pkg;
}

async function clean(git) {
  if (await git("status", "--porcelain")) throw new Error("Release automation requires a clean checkout.");
}

async function fetchRelease(git) {
  await git("fetch", "--tags", "origin", "refs/heads/release:refs/remotes/origin/release");
  return git("rev-parse", releaseRef);
}

// main is never a Git write target. Post-tag changes may only update README.
export async function assertPublishedTree(git, tag, head) {
  await git("merge-base", "--is-ancestor", `refs/tags/${tag}`, head);
  if (await git("diff", "--name-only", `refs/tags/${tag}`, head, "--", ".", ":(exclude)README.md")) {
    throw new Error("release contains changes beyond the tagged package. Finish one release before merging the next PR.");
  }
}

async function prepareAutomatic(request, git, cwd) {
  const head = await fetchRelease(git);
  if (head !== request.sourceSHA) {
    // A retry resumes the version already committed by this merged PR.
    let saved;
    try { saved = JSON.parse(await git("show", `${releaseRef}:${statePath}`)); } catch {}
    if (saved?.pullRequest !== request.pullRequest || saved.sourceSHA !== request.sourceSHA) {
      throw new Error("release advanced past this PR. Finish/retry the current release before merging another PR.");
    }
    const tag = `v${releaseVersion(saved.version)}`;
    if (await git("rev-parse", `refs/tags/${tag}^`) !== request.sourceSHA) throw new Error("Saved release tag does not belong to this PR.");
    const taggedState = JSON.parse(await git("show", `refs/tags/${tag}:${statePath}`));
    if (JSON.stringify(taggedState) !== JSON.stringify(saved)) throw new Error("Saved release state differs from the tag.");
    await assertPublishedTree(git, tag, head);
    return tag;
  }
  const pkg = await manifest(git, releaseRef);
  const version = semver.inc(pkg.version, "patch");
  const tag = `v${version}`;
  for (const candidate of [tag, version]) {
    if (await git("tag", "--list", candidate)) throw new Error(`Version tag ${candidate} already exists.`);
  }
  const changelog = prepareChangelog(await git("show", `${releaseRef}:CHANGELOG.md`), version);
  await git("switch", "-C", "release", releaseRef);
  await execute("npm", ["version", version, "--no-git-tag-version", "--ignore-scripts"], { cwd });
  await writeFile(join(cwd, "CHANGELOG.md"), changelog);
  await mkdir(join(cwd, ".github"), { recursive: true });
  await writeFile(join(cwd, statePath), JSON.stringify({ ...request, version }, null, 2) + "\n");
  await git("add", "--", "package.json", "package-lock.json", "CHANGELOG.md", statePath);
  await git(...identity, "commit", "-m", `Release ${tag} from PR #${request.pullRequest}`);
  await git(...identity, "tag", "-a", tag, "-m", `Release ${tag} from PR #${request.pullRequest}`);
  // Both refs land together, or neither does. Never force-push a branch or move a tag.
  await git("push", "--atomic", "origin", "HEAD:refs/heads/release", `refs/tags/${tag}`);
  return tag;
}

export async function buildPackage({ cwd, directory, version }) {
  await execute("npm", ["ci", "--ignore-scripts"], { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  await execute("npm", ["run", "build"], { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  await execute("npm", ["run", "package:check", "--", directory], { cwd, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  const archive = join(directory, `opencode2-automation-${version}.tgz`);
  const checksum = `${archive}.sha256`;
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  if ((await readFile(checksum, "utf8")).trim() !== `${digest}  opencode2-automation-${version}.tgz`) {
    throw new Error("Built package checksum does not match.");
  }
  return { archive, checksum };
}

// Merge the exact published release head, never copy files over newer development.
// Isolate merge attempts from the publisher checkout; a normal push protects races.
export async function syncDevel({ cwd, releaseHead }) {
  const git = gitAt(cwd);
  const ref = "refs/remotes/origin/devel";
  for (let attempt = 0; attempt < 3; attempt++) {
    await git("fetch", "origin", "refs/heads/devel:refs/remotes/origin/devel");
    const before = await git("rev-parse", ref);
    try {
      await git("merge-base", "--is-ancestor", releaseHead, before);
      return { head: before, changed: false };
    } catch {}
    const temporary = await mkdtemp(join(tmpdir(), "oc2-sync-devel-"));
    const checkout = join(temporary, "checkout");
    let added = false;
    try {
      await git("worktree", "add", "--detach", checkout, before);
      added = true;
      const merge = gitAt(checkout);
      try {
        await merge(...identity, "merge", "--no-edit", releaseHead);
      } catch {
        throw new Error("Automatic release-to-devel merge conflicted. Remote devel was not changed. Resolve the conflict on devel, then rerun this Release job; no sync PR is created.");
      }
      const head = await merge("rev-parse", "HEAD");
      try {
        await merge("push", "origin", "HEAD:refs/heads/devel");
        return { head, changed: true };
      } catch (error) {
        await git("fetch", "origin", "refs/heads/devel:refs/remotes/origin/devel");
        if (await git("rev-parse", ref) === before) {
          throw new Error("Automatic devel sync push failed. Check publisher write permission and devel branch rules, then rerun this Release job.", { cause: error });
        }
        // A concurrent feature merge won the race. Re-merge its new tip, never force.
      }
    } finally {
      if (added) await git("worktree", "remove", "--force", checkout);
      await rm(temporary, { recursive: true, force: true });
    }
  }
  throw new Error("devel kept changing during synchronization. Rerun this Release job to retry without rebuilding or bumping the version.");
}

export async function runRelease({ cwd, repository, event, github, directory, build = buildPackage }) {
  const request = releaseRequest(event, repository);
  const git = gitAt(cwd);
  await clean(git);
  const tag = request.tag ?? await prepareAutomatic(request, git, cwd);
  const head = await fetchRelease(git);
  if (request.tagObject && await git("rev-parse", `${request.tagObject}^{commit}`) !== await git("rev-parse", `refs/tags/${tag}^{commit}`)) {
    throw new Error("The pushed tag has moved since this workflow started.");
  }
  await assertPublishedTree(git, tag, head);
  const pkg = await manifest(git, `refs/tags/${tag}`);
  if (pkg.version !== releaseVersion(tag)) throw new Error("Tag must match the committed package version.");
  const notes = releaseNotes(await git("show", `refs/tags/${tag}:CHANGELOG.md`), tag);
  const prerelease = semver.prerelease(pkg.version) !== null;
  let published = await github.release(tag);
  if (!published || published.draft) {
    const latest = await github.latest();
    if (latest && !semver.gt(pkg.version, releaseVersion(latest.tag_name))) {
      throw new Error("A new release must be newer than the latest published stable version.");
    }
    await git("switch", "--detach", `refs/tags/${tag}`);
    await mkdir(directory, { recursive: true });
    const files = await build({ cwd, directory, version: pkg.version });
    await writeFile(join(directory, "release-notes.md"), notes);
    await github.publish({ tag, ...files, notesFile: join(directory, "release-notes.md"), prerelease, draft: published });
    published = await github.release(tag);
  }
  if (!published || published.draft || published.tag_name !== tag || published.prerelease !== prerelease) {
    throw new Error("GitHub has not confirmed the expected published release.");
  }
  if (prerelease) return { tag, prerelease: true };
  // Validate the actual uploaded assets even on retries that skip building.
  updateReadme(await git("show", `refs/tags/${tag}:README.md`), published, repository);
  const latest = await github.latest();
  if (latest?.tag_name !== tag) throw new Error("A newer release is already published. Refusing to restore an older README link.");
  const current = await fetchRelease(git);
  await assertPublishedTree(git, tag, current);
  await clean(git);
  await git("switch", "-C", "release", releaseRef);
  const readme = await readFile(join(cwd, "README.md"), "utf8");
  const updated = updateReadme(readme, published, repository);
  if (updated !== readme) {
    await writeFile(join(cwd, "README.md"), updated);
    await git("add", "--", "README.md");
    await git(...identity, "commit", "-m", `docs: update README download to ${tag}`);
    await git("push", "origin", "HEAD:refs/heads/release");
  }
  // A concurrent feature merge must not be silently included in the promotion.
  if (await fetchRelease(git) !== await git("rev-parse", "HEAD")) throw new Error("release changed before PR creation. Retry after publication catches up.");
  const pull = await github.promote({
    title: `Release ${tag}`,
    body: `Publish ${tag} to main with all released changes and the updated package download.\n\nRelease: ${published.html_url}\n\n${notes}\nMerge this PR with a merge commit to preserve the long-lived release branch.`,
  });
  const devel = await syncDevel({ cwd, releaseHead: await git("rev-parse", "HEAD") });
  return { tag, pullRequest: pull.html_url, devel };
}

export async function verifyPromotion({ cwd, repository, event, github }) {
  const pr = event.pull_request;
  if (pr?.base?.ref !== "main" || pr.head?.ref !== "release" || pr.head.repo?.full_name !== repository) {
    throw new Error("Only a PR from this repository's release branch can promote a package to main.");
  }
  const git = gitAt(cwd);
  if (await git("rev-parse", "HEAD") !== pr.head.sha) throw new Error("Checkout must match the proposed PR head.");
  const pkg = await manifest(git, "HEAD");
  const published = await github.latest();
  if (!published || releaseVersion(published.tag_name) !== pkg.version) throw new Error("PR version is not the latest published stable release.");
  await assertPublishedTree(git, published.tag_name, "HEAD");
  const readme = await readFile(join(cwd, "README.md"), "utf8");
  if (updateReadme(readme, published, repository) !== readme) throw new Error("PR README does not point to the published assets.");
  return `Release ${published.tag_name} and README are ready for review.`;
}

export async function verifyFeature(cwd, event, repository) {
  if (event?.pull_request?.base?.ref === "release" &&
      (event.pull_request.head?.ref !== "devel" || event.pull_request.head.repo?.full_name !== repository)) {
    throw new Error("Feature PRs must target devel. Only same-repository devel can target release.");
  }
  const git = gitAt(cwd);
  const pkg = await manifest(git, "HEAD");
  const version = semver.inc(pkg.version, "patch");
  prepareChangelog(await git("show", "HEAD:CHANGELOG.md"), version);
  return `Manifests and unreleased notes are ready for patch ${version}.`;
}

export function githubClient(repository, token) {
  const base = `/repos/${repository}`;
  const api = async (method, path, body) => {
    const response = await fetch(`https://api.github.com${base}${path}`, {
      method,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404 && method === "GET" && path.startsWith("/releases/")) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (HTTP ${response.status}). For PR creation, check Actions permissions and the repository's allow-create-PR setting.`);
    return response.json();
  };
  const gh = args => execute("gh", [...args, "--repo", repository], { env: { ...process.env, GH_TOKEN: token }, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  return {
    release: tag => api("GET", `/releases/tags/${encodeURIComponent(tag)}`),
    latest: () => api("GET", "/releases/latest"),
    publish: async ({ tag, archive, checksum, notesFile, prerelease, draft }) => {
      if (!draft) await gh(["release", "create", tag, "--verify-tag", "--draft", "--title", tag, "--notes-file", notesFile]);
      // A retry can replace incomplete draft assets, but never overwrite a published package.
      await gh(["release", "upload", tag, archive, checksum, "--clobber"]);
      await gh(["release", "edit", tag, "--draft=false", `--prerelease=${prerelease}`, `--latest=${!prerelease}`, "--notes-file", notesFile]);
    },
    promote: async ({ title, body }) => {
      const pulls = await api("GET", `/pulls?state=open&base=main&head=${encodeURIComponent(repository.split("/")[0] + ":release")}`);
      if (pulls.length > 1) throw new Error("Multiple release promotion PRs exist.");
      if (pulls.length) return api("PATCH", `/pulls/${pulls[0].number}`, { title, body });
      return api("POST", "/pulls", { base: "main", head: "release", title, body });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "verify-feature") {
      const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")) : undefined;
      console.log(await verifyFeature(process.cwd(), event, process.env.GITHUB_REPOSITORY));
    } else {
      const repository = process.env.GITHUB_REPOSITORY;
      if (!repository || !process.env.GH_TOKEN || !process.env.GITHUB_EVENT_PATH) throw new Error("Run this script through GitHub Actions with its repository, token, and event file.");
      const options = {
        cwd: process.cwd(), repository,
        event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")),
        github: githubClient(repository, process.env.GH_TOKEN),
        directory: join(process.env.RUNNER_TEMP ?? "/tmp", "release"),
      };
      console.log(process.argv[2] === "verify-promotion" ? await verifyPromotion(options) : await runRelease(options));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
