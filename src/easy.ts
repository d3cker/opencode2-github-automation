import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { GithubOptions, SchedulerOptions, MergeOptions, Capabilities, BranchName } from "./config.js";

export const EasyOptions = z.object({
  autoApproveRepositoryFiles: z.boolean().optional(),
  baseBranch: BranchName.optional(),
  capabilities: Capabilities.optional(),
  mediaModel: z.object({ model: z.string().regex(/^[^/\s]+\/\S+$/), capabilities: Capabilities }).strict().optional(),
  systemPromptFile: z.string().min(1).optional(),
  signature: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/).optional(),
  autoMerge: MergeOptions.optional(),
  model: z.string().regex(/^[^/\s]+\/\S+$/, "Model must have the form provider/model"),
  trigger: z.string().regex(/^@[A-Za-z0-9_-]+$/).default("@opencodebot"),
  everySeconds: z.number().int().min(1).default(60),
  check: z.union([z.literal(false), z.array(z.string().min(1)).min(1)]).optional(),
  authors: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/)).min(1).optional(),
}).strict();
export type EasyOptions = z.infer<typeof EasyOptions>;
export type Run = (cwd: string, argv: string[]) => Promise<string>;
export const run: Run = (cwd, [file, ...args]) => new Promise((resolve, reject) => {
  if (!file) return reject(new Error("Empty command"));
  execFile(file, args, { cwd, timeout: 15_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout) => {
    if (error) reject(new Error(`Could not run ${file}. Check that it is installed and configured.`));
    else resolve(stdout.trim());
  });
});

export async function githubToken(tokenEnv = "GITHUB_TOKEN", execute = run): Promise<string> {
  const token = process.env[tokenEnv] || (tokenEnv === "GITHUB_TOKEN" ? process.env.GH_TOKEN : undefined);
  if (token) return token;
  try {
    const value = await execute(process.cwd(), ["gh", "auth", "token", "--hostname", "github.com"]);
    if (value) return value;
  } catch { /* Present an actionable message without exposing command output. */ }
  throw new Error("Sign in with gh auth login, or set GITHUB_TOKEN in the OpenCode 2 service environment.");
}

export async function checkout(directory: string, execute = run) {
  const root = await realpath(await execute(directory, ["git", "rev-parse", "--show-toplevel"]));
  const common = await realpath(await execute(root, ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const git = await realpath(await execute(root, ["git", "rev-parse", "--absolute-git-dir"]));
  return { root, common, primary: git === common };
}

export async function detectCheck(directory: string): Promise<string[] | undefined> {
  let pkg;
  try { pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (typeof pkg.scripts?.test !== "string" || !pkg.scripts.test.trim()) return;
  for (const [lock, manager] of [["pnpm-lock.yaml", "pnpm"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["yarn.lock", "yarn"]]) {
    try { await readFile(join(directory, lock!)); return [manager!, "test"]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return ["npm", "test"];
}

export async function resolveEasy(directory: string, raw: unknown, execute = run, fetcher: typeof fetch = fetch) {
  const options = EasyOptions.parse(raw);
  const { root, common, primary } = await checkout(directory, execute);
  if (!primary) throw new Error("Run setup in the primary checkout, not a worktree.");
  const remote = await execute(root, ["git", "remote", "get-url", "origin"]);
  const repo = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^\s]+?)(?:\.git)?$/.exec(remote)?.[1];
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("origin must point to a GitHub.com repository.");
  const token = await githubToken("GITHUB_TOKEN", execute);
  const get = async (path: string) => {
    const response = await fetcher(`https://api.github.com${path}`, {
      redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" },
    });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}. Check your account and repository access.`);
    return response.json();
  };
  const [user, metadata] = await Promise.all([get("/user"), get(`/repos/${repo}`)]);
  const login = z.object({ login: z.string() }).parse(user).login;
  const baseBranch = options.baseBranch ?? z.object({ default_branch: z.string() }).parse(metadata).default_branch;
  const check = options.check ?? await detectCheck(root);
  if (check === undefined) throw new Error("No tests detected. Run init and accept skip, or pass --skip-tests.");
  const slash = options.model.indexOf("/");
  const stateDirectory = join(common, "opencode2-automation");
  const github = GithubOptions.parse({ systemPromptFile: options.systemPromptFile, signature: options.signature ?? `${login}[OpenCode2]`, autoMerge: options.autoMerge, ownerDirectory: root, stateDirectory,
    repositories: [{ repo, directory: root, autoApproveRepositoryFiles: options.autoApproveRepositoryFiles, baseBranch, allowedAuthors: options.authors ?? [login], checks: check === false ? [] : [check] }],
    routes: { [options.trigger]: { agent: "build", capabilities: options.capabilities, mediaModel: options.mediaModel ? { capabilities: options.mediaModel.capabilities, model: { providerID: options.mediaModel.model.split("/")[0], id: options.mediaModel.model.slice(options.mediaModel.model.indexOf("/") + 1) } } : undefined, model: { providerID: options.model.slice(0, slash), id: options.model.slice(slash + 1) } } },
  });
  const scheduler = SchedulerOptions.parse({ ownerDirectory: root, stateDirectory, jobs: [{ id: "github-issues", everySeconds: options.everySeconds }] });
  return { github, scheduler, repo, login, check };
}
