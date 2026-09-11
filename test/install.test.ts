import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installGlobalEntrypoints, openCodeConfig } from "../src/install.js";

const exec = promisify(execFile);
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "oc2-install-"));
  const config = join(base, "config");
  async function pkg(name: string) {
    const root = join(base, name);
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "opencode2-automation", type: "module" }));
    await writeFile(join(root, "dist", "index.js"), 'export default "server";');
    await writeFile(join(root, "dist", "tui.js"), 'export default "tui";');
    return root;
  }
  return { base, config, pkg, root: await pkg("package with spaces #1"), cleanup: () => rm(base, { recursive: true, force: true }) };
}
const loader = (path: string) => `export { default } from ${JSON.stringify(path)};\n`;

test("registration loads server and TUI from a global package without changing config or creating a project", async () => {
  const f = await fixture();
  try {
    await mkdir(f.config);
    const settings = '{"model":"provider/model","plugins":["another-plugin"]}';
    await writeFile(join(f.config, "opencode.json"), settings);
    const directory = await installGlobalEntrypoints(f.root, f.config);
    assert.equal((await import(pathToFileURL(join(directory, "index.js")).href)).default, "server");
    assert.equal((await import(pathToFileURL(join(directory, "tui.js")).href)).default, "tui");
    const original = await readFile(join(directory, "index.js"), "utf8");
    await installGlobalEntrypoints(f.root, f.config);
    assert.equal(await readFile(join(directory, "index.js"), "utf8"), original);
    assert.equal(await readFile(join(f.config, "opencode.json"), "utf8"), settings);
    assert.deepEqual((await readdir(f.config)).sort(), ["opencode.json", "plugins"]);
  } finally { await f.cleanup(); }
});

test("source-to-package migration reuses an older loader directory and upgrades both entrypoints", async () => {
  const f = await fixture();
  try {
    const old = await f.pkg("source-checkout"), directory = join(f.config, "plugins", "previous-name");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "index.js"), loader(join(old, "dist", "index.js")));
    await writeFile(join(directory, "tui.js"), loader(join(old, "dist", "tui.js")));
    await writeFile(join(directory, "notes.txt"), "Keep this file");
    assert.equal(await installGlobalEntrypoints(f.root, f.config), directory);
    const newer = await f.pkg("next-installation");
    await rm(f.root, { recursive: true });
    await installGlobalEntrypoints(newer, f.config);
    assert.ok((await readFile(join(directory, "index.js"), "utf8")).includes(pathToFileURL(join(newer, "dist", "index.js")).href));
    assert.ok((await readFile(join(directory, "tui.js"), "utf8")).includes(pathToFileURL(join(newer, "dist", "tui.js")).href));
    assert.deepEqual(await readdir(join(f.config, "plugins")), ["previous-name"]);
    assert.equal(await readFile(join(directory, "notes.txt"), "utf8"), "Keep this file");
  } finally { await f.cleanup(); }
});

test("registration preserves custom loaders and makes no partial update", async () => {
  const f = await fixture();
  try {
    const directory = await installGlobalEntrypoints(f.root, f.config);
    const index = await readFile(join(directory, "index.js"), "utf8");
    const custom = (await readFile(join(directory, "tui.js"), "utf8")) + "console.log('custom setup');\n";
    await writeFile(join(directory, "tui.js"), custom);
    const newer = await f.pkg("newer");
    await assert.rejects(installGlobalEntrypoints(newer, f.config), /customized automation loader/);
    assert.equal(await readFile(join(directory, "index.js"), "utf8"), index);
    assert.equal(await readFile(join(directory, "tui.js"), "utf8"), custom);
  } finally { await f.cleanup(); }
});

test("registration refuses an unrelated plugin occupying its default directory", async () => {
  const f = await fixture();
  try {
    const directory = join(f.config, "plugins", "opencode-automation");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "index.js"), 'export { default } from "another-plugin";');
    await assert.rejects(installGlobalEntrypoints(f.root, f.config), /customized/);
    assert.deepEqual(await readdir(directory), ["index.js"]);
  } finally { await f.cleanup(); }
});

test("a customized source loader under an older name is not duplicated", async () => {
  const f = await fixture();
  try {
    const source = await f.pkg("custom-source"), directory = join(f.config, "plugins", "old-name");
    await mkdir(directory, { recursive: true });
    const content = loader(join(source, "dist", "index.js")) + "console.log('custom behavior');\n";
    await writeFile(join(directory, "index.js"), content);
    await assert.rejects(installGlobalEntrypoints(f.root, f.config), /customized/);
    assert.deepEqual(await readdir(join(f.config, "plugins")), ["old-name"]);
    assert.equal(await readFile(join(directory, "index.js"), "utf8"), content);
  } finally { await f.cleanup(); }
});

test("registration migrates a legacy single-file loader and does not duplicate TypeScript entrypoints", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.config, "plugins"), { recursive: true });
    await writeFile(join(f.config, "plugins", "automation.js"), loader("opencode2-automation"));
    const directory = await installGlobalEntrypoints(f.root, f.config);
    await assert.rejects(readFile(join(f.config, "plugins", "automation.js")), { code: "ENOENT" });
    await rm(join(directory, "index.js"));
    await writeFile(join(directory, "index.ts"), loader("opencode2-automation"));
    await installGlobalEntrypoints(f.root, f.config);
    assert.deepEqual((await readdir(directory)).sort(), ["index.ts", "tui.js"]);
  } finally { await f.cleanup(); }
});

test("registration rejects duplicate installations and symlinked loaders", async () => {
  const f = await fixture();
  try {
    const directory = await installGlobalEntrypoints(f.root, f.config);
    const other = join(f.config, "plugins", "other-name");
    await mkdir(other);
    await writeFile(join(other, "index.js"), loader("opencode2-automation"));
    await assert.rejects(installGlobalEntrypoints(f.root, f.config), /Multiple automation loaders/);
    await rm(other, { recursive: true });
    const external = join(f.base, "external.js");
    await writeFile(external, loader("opencode2-automation/tui"));
    await rm(join(directory, "tui.js"));
    await symlink(external, join(directory, "tui.js"));
    await assert.rejects(installGlobalEntrypoints(f.root, f.config), /customized/);
    assert.equal(await readFile(external, "utf8"), loader("opencode2-automation/tui"));
  } finally { await f.cleanup(); }
});

test("registration requires built entrypoints and respects OpenCode config overrides", async () => {
  const f = await fixture();
  try {
    assert.equal(openCodeConfig({}, f.base), join(f.base, ".config", "opencode"));
    assert.equal(openCodeConfig({ XDG_CONFIG_HOME: f.config }, f.base), join(f.config, "opencode"));
    assert.equal(openCodeConfig({ OPENCODE_CONFIG_DIR: f.base, XDG_CONFIG_HOME: f.config }), f.base);
    await rm(join(f.root, "dist", "tui.js"));
    await assert.rejects(installGlobalEntrypoints(f.root, f.config), { code: "ENOENT" });
    await assert.rejects(readdir(f.config), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("source npm ci and project-local postinstall do not register global plugins", async () => {
  const f = await fixture();
  try {
    const script = fileURLToPath(new URL("../scripts/postinstall.mjs", import.meta.url));
    await exec(process.execPath, [script], { env: { ...process.env, npm_config_global: "false", OPENCODE_CONFIG_DIR: f.config } });
    await assert.rejects(readdir(f.config), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});
