import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryFileAccess } from "../src/repository-permissions.js";

test("repository file boundaries include the primary checkout and external task worktree, but not neighboring paths or symlink escapes", async () => {
  const temp = await mkdtemp(join(tmpdir(), "oc2-permissions-"));
  const repo = join(temp, "repo"), worktree = join(temp, "worktree"), other = join(temp, "repo-other");
  try {
    for (const path of [repo, worktree, other]) await mkdir(path);
    await writeFile(join(repo, "file.txt"), "fixture");
    await symlink(other, join(repo, "escape"));
    await symlink(join(other, "missing"), join(repo, "dangling"));
    await symlink(repo, join(temp, "alias"));
    const check = (action: string, resources: string[]) => repositoryFileAccess(action, resources, worktree, [repo, worktree]);
    for (const path of [repo, worktree, join(repo, "new/subdir"), join(temp, "alias")]) {
      assert.equal(await check("external_directory", [path + "/*"]), true, path);
    }
    assert.equal(await check("read", [join(repo, "file.txt")]), true);
    assert.equal(await check("edit", ["new/subdir/file.txt", join(repo, "another.txt")]), true);
    for (const resources of [[other + "/*"], [temp + "/*"], [repo + "-other/*"], [repo + "/**"], [repo + "/escape/*"], [repo + "/dangling/*"], [repo + "/*", other + "/*"], [], ["*"], ["relative/*"]]) {
      assert.equal(await check("external_directory", resources), false, JSON.stringify(resources));
    }
    for (const path of ["../repo-other/file", join(repo, "escape/new/file"), join(repo, "dangling/file"), "**/*.ts", "bad\0path"]) {
      assert.equal(await check("edit", [path]), false, path);
    }
    for (const action of ["shell", "glob", "grep", "subagent", "execute", "question"]) {
      assert.equal(await check(action, [repo + "/*"]), false, action);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
