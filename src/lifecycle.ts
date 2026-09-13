import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

// Cleanup must reach the lock release even when an evicted SDK scope can no
// longer dispose its RPC registration. Keep the lock until work has settled.
export async function cleanup(...steps: (() => void | Promise<void>)[]) {
  const errors: unknown[] = [];
  for (const step of steps) {
    try { await step(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Automation cleanup failed");
}

export interface OwnerClient {
  health: { get(options: { signal: AbortSignal }): Promise<{ pid: number }> };
  plugin: { list(input: { location: { directory: string } }, options: { signal: AbortSignal }): Promise<unknown> };
}

export async function touchOwner(directory: string, signal: AbortSignal, connect: () => Promise<OwnerClient | undefined> = async () => {
  const endpoint = await Service.discover();
  return endpoint ? OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }) : undefined;
}) {
  const client = await connect();
  if (!client) return false;
  // A standalone server must never activate a second owner in a different
  // background service. The public request must return to this exact process.
  if ((await client.health.get({ signal })).pid !== process.pid) return false;
  await client.plugin.list({ location: { directory } }, { signal });
  return true;
}

export function heartbeat(touch: (signal: AbortSignal) => Promise<unknown>, report: (error: unknown) => void, everyMs = 30_000) {
  const controller = new AbortController();
  let active: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (active || controller.signal.aborted) return;
    active = Promise.resolve().then(() => touch(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])))
      .then(() => {}, error => { if (!controller.signal.aborted) report(error); })
      .finally(() => { active = undefined; });
  }, everyMs);
  return async () => {
    clearInterval(timer);
    controller.abort();
    await active;
  };
}
