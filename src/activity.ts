import { z } from "zod";
import type { Task } from "./dispatcher.js";

export const Activity = z.object({
  key: z.string(), repo: z.string(), issueNumber: z.number(), round: z.number(),
  phase: z.string(), status: z.string(), sessionID: z.string().optional(),
  worktree: z.string().optional(), sessionReady: z.boolean(), error: z.string().optional(),
  prURL: z.string().optional(),
  prState: z.string().optional(), sessionIDs: z.array(z.string()).optional(),
  branch: z.string().optional(), baseBranch: z.string().optional(), model: z.string().optional(),
  attempts: z.number().optional(), nextAt: z.number().optional(), pendingFeedback: z.number().optional(),
  helpers: z.number().optional(), recovery: z.boolean().optional(),
  question: z.enum(["permission", "analysis", "base", "implementation"]).optional(),
  prNumber: z.number().optional(),
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
    ...(task.branch ? { branch: task.branch } : {}),
    ...(task.baseBranch ? { baseBranch: task.baseBranch } : {}),
    ...(task.route ? { model: `${task.route.model.providerID}/${task.route.model.id}` } : {}),
    ...(task.attempts !== undefined ? { attempts: task.attempts } : {}), ...(task.nextAt !== undefined ? { nextAt: task.nextAt } : {}), pendingFeedback: task.pendingFeedback?.length ?? 0,
    helpers: task.helpers?.filter(h => h.parentID === task.sessionID).length ?? 0, recovery: Boolean(task.recovery),
    ...(task.question && !task.question.delivered ? { question: task.question.permission ? "permission" as const : task.question.purpose ?? "implementation" as const } : {}),
    ...(task.pr ? { prURL: task.pr.html_url, prState: task.pr.state, ...(task.pr.number ? { prNumber: task.pr.number } : {}) } : {}) };
}
