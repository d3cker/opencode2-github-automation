import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const server = 'export { default } from "opencode2-automation";\n';
const tui = 'export { default } from "opencode2-automation/tui";\n';
async function readOptional(file: string) {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}

export async function installLocalEntrypoints(root: string) {
  await readFile(join(root, ".opencode", "node_modules", "opencode2-automation", "package.json"));
  const parent = join(root, ".opencode", "plugins"), directory = join(parent, "automation");
  const legacy = join(parent, "automation.js");
  const old = await readOptional(legacy);
  if (old !== undefined && old !== server) throw new Error("Nie nadpisuję zmodyfikowanego plugins/automation.js.");
  const entries = [[join(directory, "index.js"), server], [join(directory, "tui.js"), tui]] as const;
  const missing: typeof entries[number][] = [];
  for (const entry of entries) {
    const content = await readOptional(entry[0]);
    if (content !== undefined && content !== entry[1]) throw new Error(`Nie nadpisuję zmodyfikowanego pliku: ${entry[0]}`);
    if (content === undefined) missing.push(entry);
  }
  await mkdir(directory, { recursive: true });
  const created: string[] = [];
  try {
    for (const [file, content] of missing) { await writeFile(file, content, { flag: "wx" }); created.push(file); }
    if (old !== undefined) await rm(legacy);
  } catch (error) {
    for (const file of created) await rm(file, { force: true });
    throw error;
  }
}
