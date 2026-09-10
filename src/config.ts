import { z } from "zod";
import { isAbsolute } from "node:path";

const absolute = z.string().refine(isAbsolute, "Use an absolute path");
const name = z.string().regex(/^[A-Za-z0-9_.-]+$/);
export const Route = z.object({
  agent: z.string().min(1).default("build"),
  model: z.object({ providerID: z.string().min(1), id: z.string().min(1) }).strict(),
}).strict();
export type Route = z.infer<typeof Route>;
export const Repository = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  directory: absolute,
  baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/).refine(s => !s.includes("..") && !s.endsWith(".lock")),
  allowedAuthors: z.array(name).min(1),
  checks: z.array(z.array(z.string().min(1)).min(1)),
}).strict();
export type Repository = z.infer<typeof Repository>;
export const MergeOptions = z.object({
  enabled: z.boolean().default(true),
  method: z.enum(["merge", "squash", "rebase"]).default("squash"),
  comments: z.array(z.string().trim().min(1)).min(1).default(["/merge", "lgtm, merge", "jest git, możesz mergować", "jest git, można mergować"]),
}).strict();
export const GithubOptions = z.object({
  signature: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/).optional(),
  autoMerge: MergeOptions.default({ enabled: true, method: "squash", comments: ["/merge", "lgtm, merge", "jest git, możesz mergować", "jest git, można mergować"] }),
  ownerDirectory: absolute,
  stateDirectory: absolute,
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default("GITHUB_TOKEN"),
  repositories: z.array(Repository).min(1),
  routes: z.record(z.string().regex(/^@[a-zA-Z0-9_-]+$/), Route).refine(r => Object.keys(r).length > 0),
  workerEverySeconds: z.number().int().min(1).default(5),
  sessionTimeoutSeconds: z.number().int().min(30).default(3600),
  commandTimeoutSeconds: z.number().int().min(1).default(600),
  maxAttempts: z.number().int().min(1).max(20).default(5),
}).strict().superRefine((o, c) => {
  for (const values of [o.repositories.map(r => r.repo.toLowerCase()), Object.keys(o.routes).map(s => s.toLowerCase())]) {
    if (new Set(values).size !== values.length) c.addIssue({ code: "custom", message: "Duplicate repository or route" });
  }
});
export type GithubOptions = z.infer<typeof GithubOptions>;
export const Job = z.object({
  id: name,
  everySeconds: z.number().int().min(1),
  rpcID: name.default("automation.github"),
  method: name.default("scan"),
  input: z.record(z.string(), z.json()).default({}),
}).strict();
export type Job = z.infer<typeof Job>;
export const SchedulerOptions = z.object({
  ownerDirectory: absolute,
  stateDirectory: absolute,
  jobs: z.array(Job).min(1).refine(j => new Set(j.map(x => x.id)).size === j.length, "Duplicate job ID"),
}).strict();

export function matchRoute(body: string, routes: Record<string, Route>): Route | undefined {
  const tags = new Set([...body.matchAll(/(?<![\w@])@[a-z0-9_-]+(?![\w-])/gi)].map(m => m[0].toLowerCase()));
  const matches = Object.entries(routes).filter(([tag]) => tags.has(tag.toLowerCase()));
  if (matches.length > 1) throw new Error("Multiple routing tags; choose one");
  return matches[0]?.[1];
}
