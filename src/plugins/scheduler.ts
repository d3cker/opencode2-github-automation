import { Plugin } from "@opencode/plugin";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { SchedulerOptions } from "../config.js";
import { Scheduler, SchedulerState } from "../scheduler.js";
import { SchedulerRpc, handlerRpc } from "../rpc.js";
import { acquire, JsonStore } from "../state.js";

export default Plugin.define({
  id: "automation.scheduler",
  async setup(ctx) {
    const options = SchedulerOptions.parse(ctx.options);
    if (await realpath(ctx.location.directory) !== await realpath(options.ownerDirectory)) return;
    const controller = new AbortController();
    const release = await acquire(options.stateDirectory, "scheduler", error => controller.abort(error));
    const scheduler = new Scheduler(options.jobs, new JsonStore(join(options.stateDirectory, "scheduler.json"), SchedulerState, () => []), async job => {
      controller.signal.throwIfAborted();
      const method = ctx.rpc(handlerRpc(job.rpcID, job.method))[job.method]!;
      return method(job.input, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]) });
    });
    try {
      await scheduler.init();
      const registration = await ctx.rpc.register(SchedulerRpc, {
        status: async () => JSON.parse(JSON.stringify(scheduler.status())),
        run: async ({ id }) => { controller.signal.throwIfAborted(); return { started: await scheduler.run(id) }; },
        pause: async ({ id, paused }) => { controller.signal.throwIfAborted(); await scheduler.pause(id, paused); return { ok: true }; },
      });
      const tick = () => { if (!controller.signal.aborted) void scheduler.tick().catch(error => { console.error("Scheduler stopped", error); controller.abort(error); }); };
      const timer = setInterval(tick, 1000);
      tick();
      return async () => { clearInterval(timer); controller.abort(); await registration.dispose(); await scheduler.settle(); await release(); };
    } catch (error) { controller.abort(); await release(); throw error; }
  },
});
