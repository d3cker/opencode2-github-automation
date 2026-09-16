import { listRepositories, publishRepositoryRuntime, registerRepositories } from "../repositories.js";
import { registerRuntimeBridge } from "../bridge.js";
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
import { abortable, cleanup, heartbeat, touchOwner } from "../lifecycle.js";

export default Plugin.define({
  id: "automation.github",
  async setup(ctx) {
    const options = GithubOptions.parse(ctx.options);
    if (await realpath(ctx.location.directory) !== await realpath(options.ownerDirectory)) return;
    await registerRepositories(options.repositories.map(r => ({ ownerDirectory: options.ownerDirectory, directory: r.directory, repo: r.repo, baseBranch: r.baseBranch, stateDirectory: options.stateDirectory, registeredAt: Date.now() })), true)
      .catch(error => console.error("Repository registration failed", redact(error)));
    const token = await githubToken(options.tokenEnv);
    const controller = new AbortController();
    const release = await acquire(options.stateDirectory, "github", error => controller.abort(error), true);
    const executor = new OpenCodeExecutor(ctx, options, controller.signal);
    let publish: (activity: Activity) => Promise<void> = async () => {};
    const dispatcher = new Dispatcher(options, new JsonStore(join(options.stateDirectory, "queue.json"), Queue, () => ({ version: 1, tasks: [] })), new Github(token, controller.signal, fetch, options.signature), executor, controller.signal, [token], Date.now, activity => publish(activity));
    let releaseBridge: (() => void) | undefined;
    let registration: { dispose(): Promise<void> } | undefined;
    let stopInventory: (() => Promise<void>) | undefined;
    let stopHeartbeat: (() => Promise<void>) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => cleanup(
      () => { clearInterval(timer); controller.abort(); },
      () => stopInventory?.(),
      () => stopHeartbeat?.(),
      () => dispatcher.settle(),
      () => abortable(async () => { await registration?.dispose(); }, AbortSignal.timeout(5_000)),
      () => releaseBridge?.(),
      release,
    );
    try {
      await dispatcher.init();
      releaseBridge = registerRuntimeBridge(options.ownerDirectory, {
        runtime: async ({ sessionID }) => dispatcher.runtime(sessionID),
        question: async ({ sessionID, id, text, permission }) => dispatcher.question(sessionID, id, text, permission),
        helper: async ({ sessionID, callID, capability }) => dispatcher.helper(sessionID, callID, capability),
      });
      const rpc = await ctx.rpc.register(GithubRpc, {
        runtime: async ({ sessionID }) => JSON.parse(JSON.stringify(dispatcher.runtime(sessionID))),
        question: async ({ sessionID, id, text, permission }) => dispatcher.question(sessionID, id, text, permission),
        helper: async ({ sessionID, callID, capability }) => dispatcher.helper(sessionID, callID, capability),
        diagnose: async ({ sessionID }) => {
          try { await ctx.session.get({ sessionID }); return { exists: true }; }
          catch (error) { return { exists: false, error: redact(error, [token]) }; }
        },
        scan: async () => { controller.signal.throwIfAborted(); return dispatcher.scan(); },
        status: async () => JSON.parse(JSON.stringify(dispatcher.status())),
        activity: async () => dispatcher.activity(),
        monitor: async () => dispatcher.monitor(),
        repositories: async () => listRepositories(),
        retry: async ({ key, restartSession }) => { controller.signal.throwIfAborted(); return { accepted: await dispatcher.retry(key, restartSession) }; },
        close: async ({ key }) => ({ accepted: await dispatcher.closeTask(key) }),
        restartworkflow: async ({ key }) => ({ accepted: await dispatcher.restartWorkflow(key) }),
      });
      registration = rpc;
      publish = activity => rpc.events.emit("activity", activity);
      const tick = () => { if (!controller.signal.aborted) void dispatcher.tick().catch(error => { console.error("Dispatcher stopped", redact(error, [token])); controller.abort(error); }); };
      timer = setInterval(tick, options.workerEverySeconds * 1000);
      stopHeartbeat = heartbeat(signal => touchOwner(options.ownerDirectory, signal), error => console.error("Automation owner heartbeat failed", redact(error, [token])));
      stopInventory = publishRepositoryRuntime(options.ownerDirectory, "dispatcher", () => dispatcher.monitor());
      tick();
      return stop;
    } catch (error) {
      await stop().catch(cause => console.error("Automation cleanup failed", redact(cause, [token])));
      throw error;
    }
  },
});
