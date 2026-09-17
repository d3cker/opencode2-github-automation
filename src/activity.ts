import { z } from "zod";
import type { Task } from "./dispatcher.js";

export const Activity = z.object({
  key: z.string(), repo: z.string(), issueNumber: z.number(), round: z.number(),
  phase: z.string(), status: z.string(), sessionID: z.string().optional(),
  worktree: z.string().optional(), sessionReady: z.boolean(), error: z.string().optional(),
  prURL: z.string().optional(),
  prState: z.string().optional(), sessionIDs: z.array(z.string()).optional(),
  controlVersion: z.number().optional(), localBranch: z.string().optional(),
  historicalError: z.string().optional(), cancelledRound: z.number().optional(), cancelledWorktree: z.string().optional(),
  closeRequestedAt: z.number().optional(), closedAt: z.number().optional(),
  branch: z.string().optional(), baseBranch: z.string().optional(), model: z.string().optional(),
  attempts: z.number().optional(), nextAt: z.number().optional(), pendingFeedback: z.number().optional(),
  helpers: z.number().optional(), recovery: z.boolean().optional(),
  question: z.enum(["permission", "analysis", "base", "implementation"]).optional(),
  prNumber: z.number().optional(),
});
export type Activity = z.infer<typeof Activity>;
export function activityOf(task: Task): Activity {
  const historical = task.status === "closed" || task.status === "watching";
  const error = task.cancellation?.error ?? task.closeError ?? task.error ?? task.mergeError;
  return { key: task.key, repo: task.repo, issueNumber: task.issue.number, round: task.round ?? 1,
    phase: task.merged ? "merged" : task.pr?.state === "closed" ? "pr_closed" : task.phase, status: task.status,
    sessionIDs: [...new Set([...task.sessionIDs ?? [], ...[task.previousSessionID, task.sessionID].filter((id): id is string => Boolean(id)), ...task.helpers?.map(h => h.id) ?? []])],
    ...(task.sessionID ? { sessionID: task.sessionID } : {}),
    ...(task.worktree ? { worktree: task.worktree } : {}),
    sessionReady: task.sessionReady ?? Boolean(task.promptAttempted),
    ...(!historical && error ? { error } : task.status === "watching" && task.mergeError ? { error: task.mergeError } : {}),
    ...(historical && (task.error ?? task.cancelledRounds?.at(-1)?.error) ? { historicalError: task.error ?? task.cancelledRounds?.at(-1)?.error } : {}),
    ...(task.controlVersion !== undefined ? { controlVersion: task.controlVersion } : {}),
    ...(task.cancelledRounds?.length ? { cancelledRound: task.cancelledRounds.at(-1)!.round } : {}),
    ...(task.cancelledRounds?.at(-1)?.worktree ? { cancelledWorktree: task.cancelledRounds.at(-1)!.worktree } : {}),
    ...(task.localBranch ? { localBranch: task.localBranch } : {}),
    ...(task.closeRequestedAt !== undefined ? { closeRequestedAt: task.closeRequestedAt } : {}),
    ...(task.closedAt !== undefined ? { closedAt: task.closedAt } : {}),
    ...(task.branch ? { branch: task.branch } : {}),
    ...(task.baseBranch ? { baseBranch: task.baseBranch } : {}),
    ...(task.route ? { model: `${task.route.model.providerID}/${task.route.model.id}` } : {}),
    ...(!historical && task.attempts !== undefined ? { attempts: task.attempts } : {}), ...(task.nextAt !== undefined ? { nextAt: task.nextAt } : {}), pendingFeedback: task.pendingFeedback?.length ?? 0,
    helpers: task.helpers?.filter(h => h.parentID === task.sessionID).length ?? 0, recovery: Boolean(task.recovery),
    ...(task.question && !task.question.delivered ? { question: task.question.permission ? "permission" as const : task.question.purpose ?? "implementation" as const } : {}),
    ...(task.pr ? { prURL: task.pr.html_url, prState: task.pr.state, ...(task.pr.number ? { prNumber: task.pr.number } : {}) } : {}) };
}
