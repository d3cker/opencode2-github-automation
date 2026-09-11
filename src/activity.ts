import { z } from "zod";
import type { Task } from "./dispatcher.js";

export const Activity = z.object({
  key: z.string(), repo: z.string(), issueNumber: z.number(), round: z.number(),
  phase: z.string(), status: z.string(), sessionID: z.string().optional(),
  worktree: z.string().optional(), sessionReady: z.boolean(), error: z.string().optional(),
  prURL: z.string().optional(),
  prState: z.string().optional(), sessionIDs: z.array(z.string()).optional(),
});
export type Activity = z.infer<typeof Activity>;
export function activityOf(task: Task): Activity {
  return { key: task.key, repo: task.repo, issueNumber: task.issue.number, round: task.round ?? 1,
    phase: task.merged ? "merged" : task.pr?.state === "closed" ? "pr_closed" : task.phase, status: task.status,
    sessionIDs: [...new Set([...task.sessionIDs ?? [], ...[task.previousSessionID, task.sessionID].filter((id): id is string => Boolean(id)), ...task.helpers?.map(h => h.id) ?? []])],
    ...(task.sessionID ? { sessionID: task.sessionID } : {}),
    ...(task.worktree ? { worktree: task.worktree } : {}),
    sessionReady: task.sessionReady ?? Boolean(task.promptAttempted),
    ...(task.error || task.mergeError ? { error: task.error ?? task.mergeError } : {}),
    ...(task.pr ? { prURL: task.pr.html_url, prState: task.pr.state } : {}) };
}
