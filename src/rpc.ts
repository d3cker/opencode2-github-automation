import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import { Activity } from "./activity.js";

export const GithubRpc = Rpc.define({
  id: "automation.github",
  events: { activity: { schema: Activity } },
  methods: {
    diagnose: { input: z.object({ sessionID: z.string() }), output: z.object({ exists: z.boolean(), error: z.string().optional() }) },
    scan: { input: z.object({}).strict(), output: z.object({ queued: z.number(), ignored: z.number() }) },
    status: { input: z.object({}).strict(), output: z.array(z.json()) },
    activity: { input: z.object({}).strict(), output: z.array(Activity) },
    retry: { input: z.object({ key: z.string(), restartSession: z.boolean().default(false) }), output: z.object({ accepted: z.boolean() }) },
  },
});
export const SchedulerRpc = Rpc.define({
  id: "automation.scheduler",
  events: {},
  methods: {
    status: { input: z.object({}).strict(), output: z.array(z.json()) },
    run: { input: z.object({ id: z.string() }), output: z.object({ started: z.boolean() }) },
    pause: { input: z.object({ id: z.string(), paused: z.boolean() }), output: z.object({ ok: z.boolean() }) },
  },
});

// A portable generic contract lets the scheduler invoke any compatible RPC handler.
export function handlerRpc(id: string, method: string) {
  return Rpc.define({ id, events: {}, methods: { [method]: { input: z.json(), output: z.json() } } });
}
