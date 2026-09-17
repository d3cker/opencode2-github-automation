import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
};

// Writes can target a new file or directory. Resolve its existing ancestor,
// without treating a dangling symlink as a missing ordinary path.
async function canonicalTarget(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const exists = await lstat(path).then(() => true, error => {
      if (error.code !== "ENOENT") throw error;
      return false;
    });
    if (exists || dirname(path) === path) throw error;
    return resolve(await canonicalTarget(dirname(path)), basename(path));
  }
}

/** Approve only file/directory resources wholly inside the selected repository. */
export async function repositoryFileAccess(action: string, resources: string[], directory: string, roots: string[]): Promise<boolean> {
  if (!["external_directory", "read", "edit"].includes(action) || !resources.length) return false;
  try {
    const canonicalRoots = await Promise.all(roots.map(root => realpath(root)));
    if (canonicalRoots.some(root => dirname(root) === root)) return false;
    for (const resource of resources) {
      const path = action === "external_directory" && resource.endsWith("/*") ? resource.slice(0, -2) : resource;
      // OpenCode supplies concrete file paths and a single trailing directory
      // wildcard. Unknown patterns and parent traversal keep ordinary approval.
      if (!path || /[\0*?[\]{}]/.test(path) || path.split("/").includes("..")) return false;
      if (action === "external_directory" && !isAbsolute(path)) return false;
      const target = await canonicalTarget(resolve(directory, path));
      if (!canonicalRoots.some(root => inside(root, target))) return false;
    }
    return true;
  } catch { return false; } // An unverifiable boundary never grants access.
}
