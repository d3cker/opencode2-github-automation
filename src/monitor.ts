import { z } from "zod";
import { Activity } from "./activity.js";

export const DispatcherMonitor = z.object({
  ownerDirectory: z.string(),
  worker: z.enum(["idle", "reconciling", "executing", "merging", "maintenance", "stopped"]),
  activeTask: z.string().optional(),
  scanning: z.boolean(),
  lastScanStarted: z.number().optional(), lastScanFinished: z.number().optional(),
  scanError: z.string().optional(),
  tasks: z.array(Activity),
});
export type DispatcherMonitor = z.infer<typeof DispatcherMonitor>;
export const SchedulerMonitor = z.array(z.object({
  id: z.string(), paused: z.boolean(), running: z.boolean(), nextAt: z.number(), failures: z.number(),
  lastStarted: z.number().optional(), lastFinished: z.number().optional(), error: z.string().optional(),
}));
export type SchedulerMonitor = z.infer<typeof SchedulerMonitor>;
