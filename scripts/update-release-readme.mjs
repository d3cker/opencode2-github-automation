import { pathToFileURL } from "node:url";
import semver from "semver";
import { releaseVersion } from "./release-notes.mjs";

const start = "<!-- latest-release:start -->";
const end = "<!-- latest-release:end -->";

function repositoryPath(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Expected a GitHub repository in OWNER/REPO format.");
  }
  return `/repos/${repository}`;
}

export function updateReadme(readme, release, repository) {
  repositoryPath(repository);
  const version = releaseVersion(release.tag_name);
  if (release.draft !== false || release.prerelease !== false || semver.prerelease(version)) {
    throw new Error("The README download must point to a published stable release.");
  }
  const base = `https://github.com/${repository}/releases`;
  const assetURL = name => {
    const matches = release.assets.filter(asset => asset.name === name && asset.state === "uploaded");
    const expected = `${base}/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name)}`;
    if (matches.length !== 1 || matches[0].browser_download_url !== expected) {
      throw new Error(`Latest release must contain the uploaded asset ${name} at ${expected}.`);
    }
    return expected;
  };
  const archive = assetURL(`opencode2-automation-${version}.tgz`);
  const checksum = assetURL(`opencode2-automation-${version}.tgz.sha256`);
  if (readme.split(start).length !== 2 || readme.split(end).length !== 2 || readme.indexOf(end) < readme.indexOf(start)) {
    throw new Error("README.md must contain exactly one ordered latest-release marker pair.");
  }
  const block = [
    start,
    `Latest stable release: **[${release.tag_name}](${base}/tag/${encodeURIComponent(release.tag_name)})**.`,
    "",
    `[Download the .tgz package](${archive}) · [SHA-256 checksum](${checksum})`,
    "",
    "```bash",
    `npm install --global --prefix "$HOME/.local" "${archive}"`,
    "```",
    end,
  ].join("\n");
  return readme.slice(0, readme.indexOf(start)) + block + readme.slice(readme.indexOf(end) + end.length);
}

// Read the current default-branch file and its SHA; never replace it with the tag's README.
export async function syncReadme(repository, request) {
  const base = repositoryPath(repository);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { default_branch: branch } = await request("GET", base);
    if (!branch) throw new Error("GitHub did not return the repository's default branch.");
    const file = await request("GET", `${base}/contents/README.md?ref=${encodeURIComponent(branch)}`);
    if (file.encoding !== "base64" || !file.sha || typeof file.content !== "string") {
      throw new Error("GitHub did not return README.md content and its blob SHA.");
    }
    // Fetch latest at execution time, including retries, so an older queued run cannot restore its own tag.
    const release = await request("GET", `${base}/releases/latest`);
    const previous = Buffer.from(file.content, "base64").toString("utf8");
    const updated = updateReadme(previous, release, repository);
    if (updated === previous) return `README already points to ${release.tag_name}.`;
    try {
      await request("PUT", `${base}/contents/README.md`, {
        branch,
        sha: file.sha,
        message: `docs: update README download to ${release.tag_name}`,
        content: Buffer.from(updated).toString("base64"),
      });
      return `Updated README on ${branch} to ${release.tag_name}.`;
    } catch (error) {
      if (error.status !== 409 || attempt === 2) throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const token = process.env.GH_TOKEN;
    if (!token) throw new Error("GH_TOKEN is required to update the README.");
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/update-release-readme.mjs OWNER/REPO");
    const request = async (method, path, body) => {
      const response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const error = new Error(`GitHub ${method} ${path} failed (HTTP ${response.status}). Check Actions contents:write permission and default-branch rules before retrying.`);
        error.status = response.status;
        throw error;
      }
      return response.json();
    };
    console.log(await syncReadme(process.argv[2], request));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
