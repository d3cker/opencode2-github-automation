import { appendFile, readFile } from "node:fs/promises";
import semver from "semver";

try {
  const tag = process.argv[2] ?? "";
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (process.argv.length !== 3 || !/^[0-9]/.test(version) || version.trim() !== version || !semver.valid(version)) {
    throw new Error("Expected a SemVer tag such as v1.2.3, 1.2.3, or v1.2.3-beta.1.");
  }
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  if (lock.name !== pkg.name || lock.packages?.[""]?.name !== pkg.name) {
    throw new Error("package.json and package-lock.json must describe the same root package.");
  }
  if (pkg.version !== version || lock.version !== version || lock.packages[""].version !== version) {
    throw new Error(`Release tag ${tag} must match the version in package.json and both root versions in package-lock.json. Use npm version to commit the version and create its tag before pushing.`);
  }
  const prerelease = semver.prerelease(version) !== null;
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\nprerelease=${prerelease}\n`);
  }
  console.log(`Release version: ${version}${prerelease ? " (prerelease)" : ""}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not prepare the release version.");
  process.exitCode = 1;
}
