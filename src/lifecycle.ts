import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { createHash } from "node:crypto";

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
  server: { info(options: { signal: AbortSignal }): Promise<{ pid: number }> };
  session: {
    create(input: { id: string; title: string; location: { directory: string }; metadata: Record<string, string> }, options: { signal: AbortSignal }): Promise<{ id: string; location: { directory: string }; metadata?: Record<string, unknown> }>;
    update(input: { sessionID: string; title: string }, options: { signal: AbortSignal }): Promise<unknown>;
  };
}

export async function touchOwner(directory: string, signal: AbortSignal, connect: () => Promise<OwnerClient | undefined> = async () => {
  const endpoint = await Service.discover();
  return endpoint ? OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }) : undefined;
}) {
  const client = await connect();
  if (!client) return false;
  // A standalone server must never activate a second owner in a different
  // background service. The public request must return to this exact process.
  if ((await client.server.info({ signal })).pid !== process.pid) return false;
  // OpenCode's inactivity sweep observes durable session events, NOT HTTP
  // requests or plugin RPC. Reuse one empty maintenance session; never prompt
  // a model, touch a user's session, or create a new session on every tick.
  const id = `ses_${createHash("sha256").update(`opencode2-automation-owner:${directory}`).digest("hex").slice(0, 32)}`;
  const title = "Automation owner keepalive";
  const session = await client.session.create({ id, title, location: { directory }, metadata: { automation: "owner-keepalive" } }, { signal });
  if (session.location.directory !== directory || session.metadata?.automation !== "owner-keepalive") throw new Error("Automation keepalive session identity mismatch");
  // Updating the title emits durable owner activity without prompting a model.
  await client.session.update({ sessionID: session.id, title }, { signal });
  return true;
}

export function heartbeat(touch: (signal: AbortSignal) => Promise<unknown>, report: (error: unknown) => void, everyMs = 10 * 60_000) {
  const controller = new AbortController();
  let active: Promise<void> | undefined;
  const tick = () => {
    if (active || controller.signal.aborted) return;
    active = Promise.resolve().then(() => touch(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])))
      .then(() => {}, error => { if (!controller.signal.aborted) report(error); })
      .finally(() => { active = undefined; });
  };
  const timer = setInterval(tick, everyMs);
  tick();
  return async () => {
    clearInterval(timer);
    controller.abort();
    await active;
  };
}

// Some OpenCode Promise plugin adapters ignore the request's AbortSignal.
// Bound our wait independently. Late SDK results are observed but cannot resume
// the retired dispatcher; durable session identity allows the next owner to
// reconcile work that continues in the server.
export function abortable<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return action();
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return action(); })
      .then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function cancellable<T extends object>(api: T): T {
  return new Proxy(api, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== "function") return method;
      return (input: unknown, request?: { signal?: AbortSignal }) => abortable(() => Reflect.apply(method, target, [input, request]), request?.signal);
    },
  });
}
