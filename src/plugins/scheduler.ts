import { publishRepositoryRuntime } from "../repositories.js";
import { Plugin } from "@opencode/plugin";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { SchedulerOptions } from "../config.js";
import { Scheduler, SchedulerState } from "../scheduler.js";
import { SchedulerRpc, handlerRpc } from "../rpc.js";
import { acquire, JsonStore, redact } from "../state.js";
import { abortable, cleanup, heartbeat, touchOwner } from "../lifecycle.js";

export default Plugin.define({
  id: "automation.scheduler",
  async setup(ctx) {
    const options = SchedulerOptions.parse(ctx.options);
    if (await realpath(ctx.location.directory) !== await realpath(options.ownerDirectory)) return;
    const controller = new AbortController();
    const release = await acquire(options.stateDirectory, "scheduler", error => controller.abort(error), true);
    const scheduler = new Scheduler(options.jobs, new JsonStore(join(options.stateDirectory, "scheduler.json"), SchedulerState, () => []), async job => {
      controller.signal.throwIfAborted();
      const method = ctx.rpc(handlerRpc(job.rpcID, job.method))[job.method]!;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
      return abortable(() => method(job.input, { signal }), signal);
    });
    let registration: { dispose(): Promise<void> } | undefined;
    let stopInventory: (() => Promise<void>) | undefined;
    let stopHeartbeat: (() => Promise<void>) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => cleanup(
      () => { clearInterval(timer); controller.abort(); },
      () => stopInventory?.(),
      () => stopHeartbeat?.(),
      () => scheduler.settle(),
      () => abortable(async () => { await registration?.dispose(); }, AbortSignal.timeout(5_000)),
      release,
    );
    try {
      await scheduler.init();
      registration = await ctx.rpc.register(SchedulerRpc, {
        status: async () => JSON.parse(JSON.stringify(scheduler.status())),
        run: async ({ id }) => { controller.signal.throwIfAborted(); return { started: await scheduler.run(id) }; },
        pause: async ({ id, paused }) => { controller.signal.throwIfAborted(); await scheduler.pause(id, paused); return { ok: true }; },
      });
      const tick = () => { if (!controller.signal.aborted) void scheduler.tick().catch(error => { console.error("Scheduler stopped", error); controller.abort(error); }); };
      timer = setInterval(tick, 1000);
      stopHeartbeat = heartbeat(signal => touchOwner(options.ownerDirectory, signal), error => console.error("Scheduler owner heartbeat failed", redact(error)));
      stopInventory = publishRepositoryRuntime(options.ownerDirectory, "scheduler", () => scheduler.status(), () => controller.signal.aborted);
      tick();
      return stop;
    } catch (error) {
      await stop().catch(cause => console.error("Scheduler cleanup failed", redact(cause)));
      throw error;
    }
  },
});
