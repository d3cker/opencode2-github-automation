// The dispatcher and its worktree hooks share a server process. This avoids HTTP
// re-entry during plugin activation and also supports standalone OpenCode servers.
export interface RuntimeBridge {
  runtime(input: { sessionID: string }, request?: unknown): Promise<unknown>;
  question(input: { sessionID: string; id: string; text: string; permission?: { action: string; resources: string[] } }, request?: unknown): Promise<{ id: string }>;
  helper(input: { sessionID: string; callID: string; capability: "vision" | "audio" }, request?: unknown): Promise<{ id: string }>;
}
const symbol = Symbol.for("opencode2-automation.runtime-bridge.v1");
const shared = globalThis as typeof globalThis & { [symbol]?: Map<string, RuntimeBridge> };
const owners = shared[symbol] ??= new Map<string, RuntimeBridge>();
export function runtimeBridge(owner: string) { return owners.get(owner); }
export function registerRuntimeBridge(owner: string, bridge: RuntimeBridge) {
  if (owners.has(owner)) throw new Error("A runtime owner is already registered for this repository");
  owners.set(owner, bridge);
  return () => { if (owners.get(owner) === bridge) owners.delete(owner); };
}
