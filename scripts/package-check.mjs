import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), "oc2-package-check-"));
try {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const output = process.argv[2] ? resolve(process.argv[2]) : join(temporary, "artifacts");
  await mkdir(output, { recursive: true });
  // npm run check has already built and tested dist; do not rebuild a different artifact.
  const packed = await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], { timeout: 60_000 });
  const [archive] = JSON.parse(packed.stdout);
  assert.equal(archive.version, pkg.version, "Packed version must match package.json");
  assert.equal(archive.filename, basename(archive.filename), "Archive name must not contain a directory");
  for (const required of ["dist/index.js", "dist/tui.js", "dist/setup.js", "dist/install.js", "scripts/postinstall.mjs", "prompts/bot.md", "CHANGELOG.md"]) {
    assert.ok(archive.files.some(file => file.path === required), `Missing packaged file: ${required}`);
  }
  const file = join(output, archive.filename), prefix = join(temporary, "prefix"), config = join(temporary, "config");
  const env = { ...process.env, OPENCODE_CONFIG_DIR: config, XDG_CONFIG_HOME: join(temporary, "xdg") };
  // Reuse cached downloads, allowing metadata lookups absent from npm ci's cache.
  await exec("npm", ["install", "--global", "--prefix", prefix, "--prefer-offline", "--ignore-scripts=false", "--no-audit", "--no-fund", file], {
    env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  const installed = JSON.parse(await readFile(join(prefix, "lib", "node_modules", pkg.name, "package.json"), "utf8"));
  assert.equal(installed.version, pkg.version, "Installed version must match the release");
  const directory = join(config, "plugins", "opencode-automation");
  assert.equal((await import(pathToFileURL(join(directory, "index.js")).href)).default.id, "automation");
  assert.equal((await import(pathToFileURL(join(directory, "tui.js")).href)).default.id, "automation.ui");
  assert.deepEqual(await readdir(config), ["plugins"], "Installation must not create project configuration");
  const help = await exec(join(prefix, "bin", pkg.name), ["--help"], { env, cwd: temporary, timeout: 15_000 });
  assert.match(help.stdout, /init/);
  const digest = createHash("sha256").update(await readFile(file)).digest("hex");
  await writeFile(`${file}.sha256`, `${digest}  ${archive.filename}\n`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `filename=${archive.filename}\n`);
  console.log(`Package verified: ${archive.filename} (version, contents, postinstall, plugin, TUI, CLI)`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Package verification failed.");
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
