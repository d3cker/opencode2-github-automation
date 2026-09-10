import { z } from "zod";
import type { Job } from "./config.js";
import { Serial, redact, type Store } from "./state.js";

const State = z.object({
  id: z.string(), paused: z.boolean(), nextAt: z.number(), failures: z.number(),
  lastStarted: z.number().optional(), lastFinished: z.number().optional(), error: z.string().optional(),
});
export const SchedulerState = z.array(State);
type State = z.infer<typeof State>;

export class Scheduler {
  private states: State[] = [];
  private active = new Map<string, Promise<void>>();
  private serial = new Serial();
  constructor(private jobs: Job[], private store: Store<State[]>, private invoke: (job: Job) => Promise<unknown>, private now = Date.now) {}
  async init() {
    const saved = await this.store.load();
    this.states = this.jobs.map(j => saved.find(s => s.id === j.id) ?? { id: j.id, paused: false, nextAt: this.now(), failures: 0 });
  }
  status() { return this.states.map(s => ({ ...s, running: this.active.has(s.id) })); }
  async pause(id: string, paused: boolean) {
    await this.serial.run(async () => { this.state(id).paused = paused; await this.store.save(this.states); });
  }
  private state(id: string) {
    const state = this.states.find(s => s.id === id);
    if (!state) throw new Error(`Unknown job: ${id}`);
    return state;
  }
  async tick() {
    await Promise.all(this.states.filter(s => !s.paused && s.nextAt <= this.now()).map(s => this.run(s.id)));
  }
  async run(id: string): Promise<boolean> {
    const state = this.state(id);
    if (this.active.has(id) || state.paused) return false;
    const job = this.jobs.find(j => j.id === id)!;
    const task = (async () => {
      await this.serial.run(async () => { state.lastStarted = this.now(); await this.store.save(this.states); });
      let error: unknown;
      try { await this.invoke(job); } catch (caught) { error = caught; }
      await this.serial.run(async () => {
        state.lastFinished = this.now();
        state.failures = error === undefined ? 0 : state.failures + 1;
        state.error = error === undefined ? undefined : redact(error);
        state.nextAt = this.now() + (state.failures ? Math.min(3600, 5 * 2 ** Math.min(state.failures - 1, 10)) : job.everySeconds) * 1000;
        await this.store.save(this.states);
      });
    })();
    this.active.set(id, task);
    try { await task; } finally { this.active.delete(id); }
    return true;
  }
  async settle() { await Promise.allSettled(this.active.values()); }
}
