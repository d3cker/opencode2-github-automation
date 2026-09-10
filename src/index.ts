import { Plugin } from "@opencode/plugin";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import github from "./plugins/github.js";
import scheduler from "./plugins/scheduler.js";
import { checkout, resolveEasy } from "./easy.js";

export default Plugin.define({
  id: "automation",
  async setup(ctx) {
    let location;
    try { location = await checkout(ctx.location.directory); }
    catch { return; } // A global installation remains inactive outside Git repositories.
    if (!location.primary || location.root !== await realpath(ctx.location.directory)) return;
    let options: unknown = ctx.options;
    if (!Object.keys(ctx.options).length) {
      try { options = JSON.parse(await readFile(join(location.root, ".opencode", "automation.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    }
    const resolved = await resolveEasy(location.root, options);
    const stopGithub = await github.setup({ ...ctx, options: resolved.github });
    try {
      const stopScheduler = await scheduler.setup({ ...ctx, options: resolved.scheduler });
      return async () => {
        try { await stopScheduler?.(); } finally { await stopGithub?.(); }
      };
    } catch (error) { await stopGithub?.(); throw error; }
  },
});
