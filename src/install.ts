import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const marker = "// Managed by opencode2-automation.";
type Role = "index" | "tui";
type Entry = { file: string; role: Role; content: string };

export function openCodeConfig(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  return resolve(env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode"));
}

async function optional(file: string) {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

// Only replace the simple re-exports made by our installers/documented commands.
// A marker alone is insufficient: a user may have added code to a managed file.
async function owned(content: string, role: Role) {
  const text = content.startsWith(marker + "\n") ? content.slice(marker.length + 1) : content;
  const match = text.match(/^\s*export\s*\{\s*default\s*\}\s*from\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*;?\s*$/);
  if (!match) return false;
  let specifier: string;
  try { specifier = match[1]!.startsWith('"') ? JSON.parse(match[1]!) : match[1]!.slice(1, -1); }
  catch { return false; }
  if (specifier === (role === "index" ? "opencode2-automation" : "opencode2-automation/tui")) return true;
  let file: string;
  try { file = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier; }
  catch { return false; }
  if (!isAbsolute(file) || basename(file) !== `${role}.js` || basename(dirname(file)) !== "dist") return false;
  const root = dirname(dirname(file));
  // Recognize previously generated loaders even after their package was removed.
  if (content.startsWith(marker + "\n")) return true;
  const manifest = await optional(join(root, "package.json"));
  if (manifest) {
    try { return JSON.parse(manifest).name === "opencode2-automation"; }
    catch { return false; }
  }
  return ["opencode2-automation", "opencode2-github-automation"].includes(basename(root));
}

async function entry(file: string, role: Role): Promise<Entry | undefined> {
  const content = await optional(file);
  return content === undefined ? undefined : { file, role, content };
}

async function related(entries: Entry[]) {
  for (const item of entries) {
    if (/opencode2-(?:automation|github-automation)/.test(item.content) || await owned(item.content, item.role)) return true;
    const declaration = item.content.match(/export\s*\{\s*default\s*\}\s*from\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*;?/);
    if (declaration && await owned(declaration[0], item.role)) return true;
  }
  return false;
}

async function replace(file: string, content: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export async function installGlobalEntrypoints(root: string, config = openCodeConfig()) {
  root = resolve(root);
  for (const role of ["index", "tui"]) await readFile(join(root, "dist", `${role}.js`));
  const plugins = join(config, "plugins"), defaultDirectory = join(plugins, "opencode-automation");
  const candidates: { directory: string; entries: Entry[]; legacy?: Entry }[] = [];
  const children = await readdir(plugins, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const child of children) {
    const path = join(plugins, child.name);
    if (child.isDirectory() || child.isSymbolicLink() && (await stat(path)).isDirectory()) {
      const entries: Entry[] = [];
      for (const role of ["index", "tui"] as const) {
        for (const extension of ["js", "ts"]) {
          const item = await entry(join(path, `${role}.${extension}`), role);
          if (item) entries.push(item);
        }
      }
      if (path === defaultDirectory || await related(entries)) {
        if (child.isSymbolicLink()) throw new Error(`Refusing to replace a symlink: ${path}`);
        candidates.push({ directory: path, entries });
      }
    } else if (/\.[jt]s$/.test(child.name)) {
      const item = await entry(path, "index");
      if (item && await related([item])) candidates.push({ directory: defaultDirectory, entries: [], legacy: item });
    }
  }
  if (candidates.length > 1) {
    throw new Error(`Multiple automation loaders found. Remove duplicate registrations before installing: ${candidates.map(item => item.legacy?.file ?? item.directory).join(", ")}`);
  }
  const target = candidates[0] ?? { directory: defaultDirectory, entries: [] };
  for (const item of [...target.entries, ...(target.legacy ? [target.legacy] : [])]) {
    if ((await lstat(item.file)).isSymbolicLink() || !await owned(item.content, item.role)) {
      throw new Error(`Refusing to overwrite a customized automation loader: ${item.file}. Back it up and remove it, then run the install command again.`);
    }
  }
  const changes: { file: string; content: string; before?: string }[] = [];
  for (const role of ["index", "tui"] as const) {
    const existing = target.entries.filter(item => item.role === role);
    if (existing.length > 1) throw new Error(`Duplicate ${role} loaders in ${target.directory}. Keep only one before installing.`);
    const file = existing[0]?.file ?? join(target.directory, `${role}.js`);
    const content = `${marker}\nexport { default } from ${JSON.stringify(pathToFileURL(join(root, "dist", `${role}.js`)).href)};\n`;
    if (existing[0]?.content !== content) changes.push({ file, content, before: existing[0]?.content });
  }
  await mkdir(target.directory, { recursive: true });
  const written: typeof changes = [];
  try {
    for (const change of changes) { await replace(change.file, change.content); written.push(change); }
    if (target.legacy) await rm(target.legacy.file);
  } catch (error) {
    for (const change of written.reverse()) {
      if (change.before === undefined) await rm(change.file, { force: true });
      else await replace(change.file, change.before);
    }
    throw error;
  }
  return target.directory;
}
