import { z } from "zod";
import type { Task } from "./dispatcher.js";

export const Activity = z.object({
  key: z.string(), repo: z.string(), issueNumber: z.number(), round: z.number(),
  phase: z.string(), status: z.string(), sessionID: z.string().optional(),
  worktree: z.string().optional(), sessionReady: z.boolean(), error: z.string().optional(),
  prURL: z.string().optional(),
});
export type Activity = z.infer<typeof Activity>;
export function activityOf(task: Task): Activity {
  return { key: task.key, repo: task.repo, issueNumber: task.issue.number, round: task.round ?? 1,
    phase: task.phase, status: task.status,
    ...(task.sessionID ? { sessionID: task.sessionID } : {}),
    ...(task.worktree ? { worktree: task.worktree } : {}),
    sessionReady: task.sessionReady ?? Boolean(task.promptAttempted),
    ...(task.error ? { error: task.error } : {}),
    ...(task.pr ? { prURL: task.pr.html_url } : {}) };
}
