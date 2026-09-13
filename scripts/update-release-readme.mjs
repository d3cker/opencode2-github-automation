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
