import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalEntrypoints } from "../src/local.js";

test("local upgrade migrates the legacy loader, adds TUI and preserves configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc2-upgrade-"));
  try {
    const folder = join(root, ".opencode");
    await mkdir(join(folder, "node_modules", "opencode2-automation"), { recursive: true });
    await writeFile(join(folder, "node_modules", "opencode2-automation", "package.json"), "{}");
    await mkdir(join(folder, "plugins"));
    await writeFile(join(folder, "automation.json"), '{"model":"provider/model","check":false}');
    await writeFile(join(folder, "plugins", "automation.js"), 'export { default } from "opencode2-automation";\n');
    await installLocalEntrypoints(root); await installLocalEntrypoints(root);
    assert.match(await readFile(join(folder, "plugins", "automation", "tui.js"), "utf8"), /opencode2-automation\/tui/);
    assert.match(await readFile(join(folder, "plugins", "automation", "index.js"), "utf8"), /opencode2-automation/);
    await assert.rejects(readFile(join(folder, "plugins", "automation.js")), { code: "ENOENT" });
    assert.equal(await readFile(join(folder, "automation.json"), "utf8"), '{"model":"provider/model","check":false}');
    await writeFile(join(folder, "plugins", "automation", "tui.js"), "custom content");
    await assert.rejects(installLocalEntrypoints(root), /Refusing to overwrite/);
    assert.equal(await readFile(join(folder, "plugins", "automation", "tui.js"), "utf8"), "custom content");
  } finally { await rm(root, { recursive: true, force: true }); }
});
