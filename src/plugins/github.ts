import { Plugin } from "@opencode/plugin";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { GithubOptions } from "../config.js";
import { Dispatcher, Queue } from "../dispatcher.js";
import { OpenCodeExecutor } from "../executor.js";
import { Github } from "../github.js";
import { GithubRpc } from "../rpc.js";
import { acquire, JsonStore, redact } from "../state.js";
import { githubToken } from "../easy.js";
import type { Activity } from "../activity.js";

export default Plugin.define({
  id: "automation.github",
  async setup(ctx) {
    const options = GithubOptions.parse(ctx.options);
    if (await realpath(ctx.location.directory) !== await realpath(options.ownerDirectory)) return;
    const token = await githubToken(options.tokenEnv);
    const controller = new AbortController();
    const release = await acquire(options.stateDirectory, "github", error => controller.abort(error));
    const executor = new OpenCodeExecutor(ctx, options, controller.signal);
    let publish: (activity: Activity) => Promise<void> = async () => {};
    const dispatcher = new Dispatcher(options, new JsonStore(join(options.stateDirectory, "queue.json"), Queue, () => ({ version: 1, tasks: [] })), new Github(token, controller.signal), executor, controller.signal, [token], Date.now, activity => publish(activity));
    try {
      await dispatcher.init();
      const registration = await ctx.rpc.register(GithubRpc, {
        diagnose: async ({ sessionID }) => {
          try { await ctx.session.get({ sessionID }); return { exists: true }; }
          catch (error) { return { exists: false, error: redact(error, [token]) }; }
        },
        scan: async () => { controller.signal.throwIfAborted(); return dispatcher.scan(); },
        status: async () => JSON.parse(JSON.stringify(dispatcher.status())),
        activity: async () => dispatcher.activity(),
        retry: async ({ key, restartSession }) => { controller.signal.throwIfAborted(); return { accepted: await dispatcher.retry(key, restartSession) }; },
      });
      publish = activity => registration.events.emit("activity", activity);
      const tick = () => { if (!controller.signal.aborted) void dispatcher.tick().catch(error => { console.error("Dispatcher stopped", redact(error, [token])); controller.abort(error); }); };
      const timer = setInterval(tick, options.workerEverySeconds * 1000);
      tick();
      return async () => { clearInterval(timer); controller.abort(); await registration.dispose(); await dispatcher.settle(); await release(); };
    } catch (error) { controller.abort(); await release(); throw error; }
  },
});
