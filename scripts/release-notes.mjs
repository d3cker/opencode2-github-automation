import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";

export function releaseVersion(tag) {
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!/^[0-9]/.test(version) || version.trim() !== version || !semver.valid(version)) {
    throw new Error("Expected a SemVer release tag.");
  }
  return version;
}

export function releaseNotes(changelog, tag) {
  const version = releaseVersion(tag);
  const sections = [...changelog.matchAll(/^## (.+)\r?$/gm)];
  const matches = sections.filter(section => section[1].trim() === version);
  if (matches.length !== 1) {
    throw new Error(`CHANGELOG.md must contain exactly one "## ${version}" section.`);
  }
  const section = matches[0];
  const next = sections[sections.indexOf(section) + 1];
  const notes = changelog.slice(section.index + section[0].length, next?.index).trim();
  if (!notes || !/^[-*] \S/m.test(notes)) {
    throw new Error(`CHANGELOG.md section ${version} must contain release notes as bullet points.`);
  }
  return `${notes}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: node scripts/release-notes.mjs TAG OUTPUT_FILE");
    const notes = releaseNotes(await readFile("CHANGELOG.md", "utf8"), process.argv[2]);
    await mkdir(dirname(process.argv[3]), { recursive: true });
    await writeFile(process.argv[3], notes);
    console.log(`Prepared release notes for ${process.argv[2]}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
