import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { type GithubOptions, type Repository, Route, matchRoute } from "./config.js";
import { GithubError, Issue, Comment, type Pull } from "./github.js";
import { Serial, redact, type Store } from "./state.js";
import { branchText, type BranchInput, type BaseChoice } from "./branch.js";
import { activityOf, type Activity } from "./activity.js";
import type { DispatcherMonitor } from "./monitor.js";
import { CompletionSummary, DescriptionConflict, renderDescription } from "./pr-description.js";
import { AnalysisDecision } from "./analysis.js";

export const PendingQuestion = z.object({ id: z.string(), text: z.string(), sessionID: z.string().optional(), purpose: z.enum(["base", "analysis"]).optional(), commentID: z.number().optional(),
  permission: z.object({ action: z.string(), resources: z.array(z.string()) }).optional(),
  answer: Comment.optional(), delivered: z.boolean().optional(), answerSent: z.boolean().optional() });
const Phase = z.enum(["queued", "analyzing", "commented", "running", "verifying", "publishing", "pr_opened"]);
export const Task = z.object({
  key: z.string(), repo: z.string(), issue: Issue, route: Route.optional(),
  phase: Phase, status: z.enum(["ready", "retry_wait", "blocked", "failed", "done", "waiting", "closing", "closed"]),
  attempts: z.number(), nextAt: z.number(), createdAt: z.number(),
  closeRequestedAt: z.number().optional(), closedAt: z.number().optional(), closeError: z.string().optional(),
  analysis: z.string().optional(), commentID: z.number().optional(),
  analysisDecision: AnalysisDecision.optional(),
  analysisDialogue: z.array(z.object({ question: z.string(), answer: Comment })).optional(),
  baseBranch: z.string().optional(), question: PendingQuestion.optional(),
  baseDialogue: z.array(z.object({ question: z.string(), answer: Comment })).optional(),
  permissions: z.array(z.object({ sessionID: z.string(), action: z.string(), resources: z.array(z.string()), allow: z.boolean() })).optional(),
  helpers: z.array(z.object({ id: z.string(), parentID: z.string(), capability: z.enum(["vision", "audio"]) })).optional(),
  branch: z.string(), worktree: z.string().optional(), baseSha: z.string().optional(),
  sessionID: z.string().optional(), promptAttempted: z.boolean().optional(),
  sessionStopped: z.boolean().optional(),
  recovery: z.object({ id: z.string(), attempted: z.boolean().optional() }).optional(),
  sessionIDs: z.array(z.string()).optional(),
  sessionReady: z.boolean().optional(), round: z.number().int().positive().optional(),
  source: z.enum(["issue", "comment"]).optional(),
  feedback: z.array(Comment).optional(), pendingFeedback: z.array(Comment).optional(), commentCursor: z.number().optional(),
  previousSessionID: z.string().optional(),
  checks: z.array(z.string()).optional(), commit: z.string().optional(),
  publishedAt: z.number().optional(), merged: z.boolean().optional(), mergeError: z.string().optional(), mergeNextAt: z.number().optional(),
  completion: CompletionSummary.optional(), initialCompletion: CompletionSummary.optional(),
  publishedBody: z.string().optional(),
  prTitle: z.string().min(1).max(240).optional(),
  pr: z.object({ number: z.number(), html_url: z.string(), state: z.string() }).optional(), error: z.string().optional(),
});
export type Task = z.infer<typeof Task>;
export const Queue = z.object({ version: z.literal(1), tasks: z.array(Task) });
export type Queue = z.infer<typeof Queue>;
export class Blocked extends Error {}
export class SessionStopped extends Blocked {}
export class WaitingForAnswer extends Error {}
class TaskClosed extends Error {}
const closing = (task: Task) => task.status === "closing" || task.status === "closed";
function requireTracked(task: Task) { if (closing(task)) throw new TaskClosed("Task tracking has been closed"); }

function stoppedSession(task: Task) {
  // Recognize checkpoints from releases before sessionStopped was persisted.
  return task.sessionStopped || [
    "Error: Session timed out and was interrupted; inspect it before retrying",
    "Error: Session did not complete successfully; inspect its outcome and permissions",
  ].includes(task.error ?? "");
}

export interface GithubPort {
  mergeApproved?(repo: string, number: number, commit: string, since: number, authors: string[], options: GithubOptions["autoMerge"]): Promise<boolean>;
  issues(repo: string): Promise<Issue[]>;
  issue(repo: string, number: number): Promise<Issue>;
  comments(repo: string, number: number): Promise<Comment[]>;
  ensureComment(repo: string, number: number, marker: string, body: string): Promise<number>;
  findPull(repo: string, branch: string): Promise<Pull | undefined>;
  pull(repo: string, number: number): Promise<Pull>;
  updatePullBody(repo: string, number: number, commit: string, key: string, body: string, previous?: string, legacy?: string): Promise<void>;
  ensurePull(repo: string, branch: string, base: string, title: string, body: string): Promise<Pull>;
}
export interface Executor {
  selectBase(task: Task, repo: Repository, inputs: BranchInput[]): Promise<BaseChoice>;
  hasBranch(repo: Repository, branch: string): Promise<boolean>;
  analyze(task: Task): Promise<AnalysisDecision>;
  summary(task: Task): Promise<CompletionSummary>;
  title(task: Task): Promise<string>;
  prepare(task: Task, repo: Repository): Promise<{ worktree: string; baseSha: string }>;
  run(task: Task, checkpoint: (patch: Partial<Task>) => Promise<void>): Promise<void>;
  verify(task: Task, repo: Repository): Promise<{ checks: string[]; commit: string }>;
  push(task: Task, repo: Repository): Promise<void>;
  cancel(task: Task, related?: boolean): Promise<void>;
  completed?(task: Task): Promise<boolean>;
}

export class Dispatcher {
  private queue: Queue = { version: 1, tasks: [] };
  private serial = new Serial();
  private scanning?: Promise<{ queued: number; ignored: number }>;
  private working?: Promise<void>;
  private maintenance?: Promise<boolean>;
  private workerState: DispatcherMonitor["worker"] = "idle";
  private activeTask?: string;
  private lastScanStarted?: number;
  private lastScanFinished?: number;
  private scanError?: string;
  private closures = new Map<string, Promise<void>>();
  private publishing = new Set<string>();
  private questionPosts = new Map<string, Promise<number>>();
  constructor(private options: GithubOptions, private store: Store<Queue>, private github: GithubPort, private executor: Executor, private signal: AbortSignal, private secrets: string[] = [], private now = Date.now, private notify: (activity: Activity) => Promise<void> = async () => {}) {}
  async init() { this.queue = await this.store.load(); }
  status() { return structuredClone(this.queue.tasks); }
  activity() { return this.queue.tasks.map(activityOf); }
  monitor(): DispatcherMonitor {
    return { ownerDirectory: this.options.ownerDirectory,
      worker: this.signal.aborted ? "stopped" : this.maintenance || this.queue.tasks.some(t => t.status === "closing") ? "maintenance" : this.workerState,
      scanning: Boolean(this.scanning), tasks: this.activity(),
      ...(this.activeTask ? { activeTask: this.activeTask } : {}),
      ...(this.lastScanStarted !== undefined ? { lastScanStarted: this.lastScanStarted } : {}),
      ...(this.lastScanFinished !== undefined ? { lastScanFinished: this.lastScanFinished } : {}),
      ...(this.scanError ? { scanError: this.scanError } : {}),
    };
  }
  private async update(task: Task, patch: Partial<Task>) {
    this.signal.throwIfAborted();
    let announce = false;
    await this.serial.run(async () => {
      this.signal.throwIfAborted();
      requireTracked(task);
      announce = Boolean(patch.sessionReady && !task.sessionReady) || Boolean(patch.status && patch.status !== task.status && ["done", "blocked", "failed", "waiting"].includes(patch.status));
      announce ||= patch.pr?.state === "closed" && task.pr?.state !== "closed";
      if (patch.sessionID) task.sessionIDs = [...new Set([...task.sessionIDs ?? [], ...[task.previousSessionID, task.sessionID, patch.sessionID].filter((id): id is string => Boolean(id))])];
      Object.assign(task, patch);
      await this.store.save(this.queue);
    });
    if (announce) await this.notify(activityOf(task)).catch(error => console.error("Activity notification failed", redact(error, this.secrets)));
  }
  scan() {
    if (this.scanning) return this.scanning;
    this.lastScanStarted = this.now();
    this.scanning = this.scanOnce().then(result => { this.scanError = undefined; return result; }, error => {
      this.scanError = redact(error, this.secrets); throw error;
    }).finally(() => { this.lastScanFinished = this.now(); this.scanning = undefined; });
    return this.scanning;
  }
  private async scanOnce() {
    let queued = 0, ignored = 0;
    for (const repo of this.options.repositories) {
      // Watch PR state independently of automatic merging, issue state, and
      // worker progress so manual closure/merge also reaches attached TUIs.
      for (const task of this.queue.tasks.filter(t => t.repo === repo.repo && !closing(t) && t.pr && !t.merged)) {
        if (closing(task)) continue;
        try {
          const pr = await this.github.pull(repo.repo, task.pr!.number);
          const merged = pr.merged === true || Boolean(pr.merged_at);
          if (pr.state !== task.pr!.state || merged) await this.update(task, { pr, ...(merged ? { merged: true } : {}) });
        } catch (error) { if (!closing(task)) throw error; }
      }
      const issues = await this.github.issues(repo.repo);
      for (const tracked of this.queue.tasks.filter(t => t.repo === repo.repo && !closing(t))) {
        if (!issues.some(i => i.number === tracked.issue.number)) issues.push(await this.github.issue(repo.repo, tracked.issue.number));
      }
      for (const issue of issues) {
        this.signal.throwIfAborted();
        if (issue.pull_request) { ignored++; continue; }
        const key = `${repo.repo.toLowerCase()}#${issue.number}`;
        const existing = this.queue.tasks.find(t => t.key === key);
        if (existing && closing(existing)) { ignored++; continue; }
        if (!existing && issue.state !== "open") { ignored++; continue; }
        const comments = await this.github.comments(repo.repo, issue.number);
        // A person may share the posting account with the bot. Exclude marked
        // automation messages, never the authenticated account's login itself.
        const authorized = comments.filter(c => this.authorized(c.user.login, repo.allowedAuthors) && c.user.type !== "Bot" && c.body.trim() && !c.body.includes("<!-- opencode2:"));
        const cursor = Math.max(0, ...comments.map(c => c.id));
        if (existing) {
          // For queues from older versions, comments after the bot's acknowledgement are new feedback.
          await this.serial.run(async () => {
            if (closing(existing)) return;
            const previousCursor = existing.commentCursor ?? existing.commentID ?? 0;
            const fresh = authorized.filter(c => c.id > previousCursor);
            let remaining = fresh;
            const q = existing.question;
            if (q && !q.answer && q.commentID && issue.state === "open") {
              // Search all comments after the published question, including a reply seen during POST reconciliation.
              const reply = authorized.find(c => c.id > q.commentID! && (!q.permission || [`/allow ${q.id}`, `/deny ${q.id}`].includes(c.body.trim())));
              if (reply) {
                q.answer = reply;
                if (q.permission && q.sessionID) existing.permissions = [...existing.permissions ?? [], { sessionID: q.sessionID, ...q.permission, allow: reply.body.trim().startsWith("/allow ") }];
                if (existing.status === "waiting") existing.status = "ready";
                remaining = remaining.filter(c => c.id !== reply.id);
                existing.pendingFeedback = (existing.pendingFeedback ?? []).filter(c => c.id !== reply.id);
              }
            }
            Object.assign(existing, { pendingFeedback: [...existing.pendingFeedback ?? [], ...remaining], commentCursor: Math.max(cursor, previousCursor) });
            await this.store.save(this.queue);
            if (fresh.length) queued++; else ignored++;
          });
          continue;
        }
        let route: Route | undefined, error: string | undefined;
        let source: "issue" | "comment" = "issue";
        try {
          if (this.authorized(issue.user.login, repo.allowedAuthors)) route = matchRoute(issue.body ?? "", this.options.routes);
          if (!route) {
            for (const comment of authorized) {
              const selected = matchRoute(comment.body, this.options.routes);
              if (selected) { route = selected; source = "comment"; }
            }
          }
        }
        catch (caught) { error = redact(caught); }
        if (!route && !error) { ignored++; continue; }
        await this.serial.run(async () => {
          const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
          this.queue.tasks.push({ key, repo: repo.repo, issue, route, error, source, feedback: authorized, pendingFeedback: [], commentCursor: cursor, round: 1, phase: "queued", status: error ? "blocked" : "ready", attempts: 0, nextAt: this.now(), createdAt: this.now(), branch: `automation/issue-${issue.number}-${digest}` });
          await this.store.save(this.queue);
        });
        queued++;
      }
    }
    return { queued, ignored };
  }
  private authorized(login: string, authors: string[]) { return authors.some(a => a.toLowerCase() === login.toLowerCase()); }
  tick(): Promise<void> {
    for (const task of this.queue.tasks.filter(t => t.status === "closing" && t.nextAt <= this.now())) this.startClosing(task);
    if (this.maintenance) return Promise.resolve();
    if (this.working) return this.working;
    if (this.queue.tasks.some(t => t.status === "closing")) return Promise.resolve();
    this.workerState = "reconciling";
    this.working = this.workOnce().catch(error => { if (!(error instanceof TaskClosed)) throw error; }).finally(() => { this.working = undefined; this.workerState = "idle"; this.activeTask = undefined; });
    return this.working;
  }
  private async workOnce() {
    // A person can finish a stopped session in the TUI while the durable task
    // still says blocked. Rejoin normal verification/publication, never infer
    // completion from Git changes or discard pending issue feedback.
    for (const task of this.queue.tasks.filter(t => t.phase === "running" && t.sessionID && stoppedSession(t) && ["blocked", "failed"].includes(t.status) && t.nextAt <= this.now() && (!t.question || t.question.delivered))) {
      try {
        const completed = await this.executor.completed?.(structuredClone(task));
        await this.serial.run(async () => {
          this.signal.throwIfAborted();
          if (!["blocked", "failed"].includes(task.status)) return;
          Object.assign(task, completed
            ? { status: "ready", attempts: 0, nextAt: this.now(), error: undefined }
            : { nextAt: this.now() + 30_000 });
          await this.store.save(this.queue);
        });
      } catch { if (this.signal.aborted) return; await this.update(task, { nextAt: this.now() + 30_000 }); }
    }
    // A lost comment response must not strand a waiting question after a restart.
    for (const pending of this.queue.tasks.filter(t => t.status === "waiting" && t.question && !t.question.commentID && t.nextAt <= this.now())) {
      const q = pending.question!;
      try { await this.publishQuestion(pending, q); }
      catch (error) { if (this.signal.aborted) return; await this.update(pending, { error: redact(error, this.secrets), nextAt: this.now() + 60_000 }); }
    }
    await this.serial.run(async () => {
      const finished = this.queue.tasks.find(t => t.status === "done" && t.pendingFeedback?.length);
      if (!finished) return;
      Object.assign(finished, { round: (finished.round ?? 1) + 1, feedback: finished.pendingFeedback, pendingFeedback: [], previousSessionID: finished.sessionID,
        phase: "queued", status: "ready", attempts: 0, nextAt: this.now(), analysis: undefined, commentID: undefined,
        analysisDecision: undefined, analysisDialogue: undefined, question: undefined,
        sessionID: undefined, sessionReady: false, promptAttempted: false, sessionStopped: undefined, recovery: undefined, completion: undefined, checks: undefined, commit: undefined, error: undefined });
      await this.store.save(this.queue);
    });
    const resumable = this.queue.tasks.filter(t => ["ready", "retry_wait"].includes(t.status));
    // A transport timeout may leave a server session running. Reconcile it before starting another issue.
    const activeSession = resumable.find(t => t.phase === "running" && t.sessionID);
    const task = activeSession ?? resumable.find(t => t.nextAt <= this.now());
    if (task && task.nextAt > this.now()) return;
    if (!task) { this.workerState = "merging"; await this.mergeOnce(); return; }
    this.workerState = "executing";
    this.activeTask = task.key;
    const configuredRepo = this.options.repositories.find(r => r.repo === task.repo);
    let repo = configuredRepo ? { ...configuredRepo, baseBranch: task.baseBranch ?? configuredRepo.baseBranch } : undefined;
    try {
      if (!repo) throw new Blocked("Repository removed from configuration");
      if (!task.route) throw new Blocked("No unambiguous execution route");
      await this.update(task, { status: "ready", error: undefined });
      const followup = (task.round ?? 1) > 1;
      if (["queued", "analyzing", "commented"].includes(task.phase)) {
        const latest = await this.github.issue(task.repo, task.issue.number);
        if (latest.state !== "open") throw new Blocked("Issue is closed; reopen it before continuing");
        if (followup) {
          const pr = await this.github.findPull(task.repo, task.branch);
          if (!pr || pr.state !== "open") throw new Blocked("The original PR is closed or merged; reopen it or create a new issue");
          if (!task.feedback?.every(c => this.authorized(c.user.login, configuredRepo!.allowedAuthors))) throw new Blocked("Feedback author no longer authorized");
        } else if (task.source !== "comment" && !this.authorized(latest.user.login, repo.allowedAuthors)) throw new Blocked("Issue author no longer authorized");
        if (!followup && task.source === "comment" && !task.feedback?.some(c => this.authorized(c.user.login, configuredRepo!.allowedAuthors) && matchRoute(c.body, this.options.routes))) throw new Blocked("No authorized routing comment remains in the task");
        const route = followup || task.source === "comment" ? task.route : matchRoute(latest.body ?? "", this.options.routes);
        if (!route) throw new Blocked("Routing tag removed");
        if (task.analysis && (latest.body !== task.issue.body || latest.title !== task.issue.title || JSON.stringify(route) !== JSON.stringify(task.route))) throw new Blocked("Issue or route changed after analysis; review before restarting");
        await this.update(task, { issue: latest, route });
      }
      if (task.phase === "queued" || task.phase === "analyzing") {
        await this.resolveAnalysis(task, repo);
      }
      if (task.phase === "commented") {
        requireTracked(task);
        // Saved pre-upgrade analyses had no decision. Reassess them before any
        // implementation, preserving an already-pending base question first.
        if (task.question?.purpose === "base") await this.resolveBase(task, repo);
        if (!task.analysisDecision) await this.resolveAnalysis(task, repo);
        if (task.analysisDecision?.kind !== "proceed") throw new WaitingForAnswer("Waiting for clarification before implementation");
        if (!task.commentID) throw new Blocked("Missing confirmed analysis comment");
        if (!task.baseBranch) await this.resolveBase(task, repo);
        repo = { ...repo, baseBranch: task.baseBranch! };
        requireTracked(task);
        const workspace = await this.executor.prepare(task, repo);
        await this.update(task, { ...workspace, phase: "running", attempts: 0 });
      }
      if (task.phase === "running") {
        requireTracked(task);
        await this.executor.run(task, patch => this.update(task, patch));
        if (task.question && !task.question.delivered) throw new WaitingForAnswer("Waiting for a reply in the GitHub issue");
        await this.captureCompletion(task);
        await this.update(task, { phase: "verifying", attempts: 0, sessionStopped: undefined, recovery: undefined });
      }
      if (task.phase === "verifying") {
        requireTracked(task);
        await this.captureCompletion(task);
        const result = await this.executor.verify(task, repo);
        await this.update(task, { ...result, completion: { ...task.completion!, ...result }, phase: "publishing", attempts: 0 });
      }
      if (task.phase === "publishing") {
        requireTracked(task);
        this.publishing.add(task.key);
        await this.captureCompletion(task);
        if (task.completion?.commit !== task.commit) await this.update(task, { completion: { ...task.completion!, commit: task.commit, checks: task.checks ?? [] } });
        if (!task.initialCompletion) {
          const earlier = task.sessionIDs?.find(id => id !== task.sessionID) ?? task.previousSessionID;
          const initial = !followup ? task.completion! : earlier
            ? await this.executor.summary({ ...task, sessionID: earlier, round: undefined })
            : { unavailable: "The original completion session is not recorded." };
          await this.update(task, { initialCompletion: initial });
        }
        const body = renderDescription(task.key, task.issue.number, task.initialCompletion!, task.completion!);
        let pr = await this.github.findPull(task.repo, task.branch);
        if (followup && (!pr || pr.state !== "open")) throw new Blocked("The original PR is no longer open; changes remain in the worktree");
        if (followup && pr) await this.executor.push(task, repo);
        if (!pr) {
          if (!task.prTitle) await this.update(task, { prTitle: await this.executor.title(task) });
          if ((await this.github.issue(task.repo, task.issue.number)).state !== "open") throw new Blocked("Issue closed before PR publication");
          await this.executor.push(task, repo);
          pr = await this.github.ensurePull(task.repo, task.branch, repo.baseBranch, task.prTitle!, body);
        }
        if (pr.state === "open") {
          const legacy = `${task.analysis}\n\nCloses #${task.issue.number}\n\nChecks:\n${task.checks?.length ? task.checks.map(c => `- ${c}`).join("\n") : "- Automated tests were not run: no test command configured. Only Git consistency checks were performed."}\n\nOpenCode session: ${task.sessionID}\nCommit: ${task.commit}`;
          await this.github.updatePullBody(task.repo, pr.number, task.commit!, task.key, body, task.publishedBody, legacy);
        }
        await this.update(task, { publishedBody: pr.state === "open" ? body : task.publishedBody, pr, publishedAt: this.now(), phase: "pr_opened", status: "done", attempts: 0 });
      }
    } catch (error) {
      if (this.signal.aborted || closing(task) || error instanceof TaskClosed) return;
      if (error instanceof WaitingForAnswer) { await this.update(task, { status: task.question?.answer ? "ready" : "waiting", error: undefined }); return; }
      const attempts = task.attempts + 1;
      const blocked = error instanceof Blocked || error instanceof DescriptionConflict || error instanceof GithubError && [401, 404, 422].includes(error.status);
      await this.update(task, { attempts, sessionStopped: error instanceof SessionStopped, error: redact(error, this.secrets), status: blocked ? "blocked" : attempts >= this.options.maxAttempts ? "failed" : "retry_wait", nextAt: Math.max(this.now() + Math.min(3600, 5 * 2 ** attempts) * 1000, error instanceof GithubError ? error.retryAt ?? 0 : 0) });
    } finally { this.publishing.delete(task.key); }
  }
  private async captureCompletion(task: Task) {
    if (task.completion?.sessionID === task.sessionID && task.completion?.round === (task.round ?? 1)) return;
    const completion = await this.executor.summary(task);
    await this.update(task, { completion: { ...completion, ...(task.sessionID ? { sessionID: task.sessionID } : {}), round: task.round ?? 1 } });
  }
  private async resolveAnalysis(task: Task, repo: Repository) {
    await this.update(task, { phase: "analyzing" });
    if (task.analysisDialogue?.some(d => !this.authorized(d.answer.user.login, repo.allowedAuthors))) throw new Blocked("A clarification reply author is no longer authorized");
    const q = task.question;
    if (q?.purpose === "analysis" && !q.delivered) {
      if (!q.answer) { await this.publishQuestion(task, q); throw new WaitingForAnswer("Waiting for the issue reply before implementation"); }
      if (!this.authorized(q.answer.user.login, repo.allowedAuthors)) throw new Blocked("The clarification reply author is no longer authorized");
      // Save the answer and invalidate the previous decision in one checkpoint.
      // An unclear reply is assessed again and can produce another question.
      await this.update(task, {
        analysisDialogue: [...task.analysisDialogue ?? [], { question: q.text, answer: q.answer }],
        question: { ...q, delivered: true }, analysisDecision: undefined,
      });
    }
    if (!task.analysisDecision) {
      const decision = AnalysisDecision.parse(await this.executor.analyze(task));
      await this.update(task, { analysisDecision: decision, analysis: decision.comment });
    }
    const decision = task.analysisDecision!;
    if (decision.kind === "question") {
      const id = `analysis_${createHash("sha256").update(JSON.stringify({ key: task.key, round: task.round ?? 1, dialogue: task.analysisDialogue ?? [], decision })).digest("hex").slice(0, 24)}`;
      await this.askTask(task, { id, text: `${decision.comment}\n\n${decision.question}`, purpose: "analysis" });
      throw new WaitingForAnswer("Waiting for the issue reply before implementation");
    }
    const lastAnswer = task.analysisDialogue?.at(-1)?.answer.id;
    const marker = `<!-- opencode2:${task.key}:analysis:v${task.round ?? 1}${lastAnswer === undefined ? "" : `:reply:${lastAnswer}`} -->`;
    requireTracked(task);
    const commentID = await this.github.ensureComment(task.repo, task.issue.number, marker, decision.comment);
    await this.update(task, { commentID, phase: "commented", attempts: 0, ...(task.question?.purpose === "analysis" ? { question: undefined } : {}) });
  }
  private async resolveBase(task: Task, repo: Repository) {
    const q = task.question;
    if (q?.purpose === "base" && !q.delivered) {
      if (!q.answer) { await this.publishQuestion(task, q); throw new WaitingForAnswer("Waiting for a base branch reply"); }
      if (!this.authorized(q.answer.user.login, repo.allowedAuthors)) throw new Blocked("The branch reply author is no longer authorized");
      await this.update(task, { baseDialogue: [...task.baseDialogue ?? [], { question: q.text, answer: q.answer }], question: { ...q, delivered: true, answerSent: true } });
    }
    const inputs: BranchInput[] = [
      ...(this.authorized(task.issue.user.login, repo.allowedAuthors) ? [task.issue.title, task.issue.body ?? ""].map(text => ({ text })) : []),
      ...(task.feedback ?? []).filter(c => this.authorized(c.user.login, repo.allowedAuthors)).map(c => ({ text: c.body })),
      ...(task.analysisDialogue ?? []).filter(d => this.authorized(d.answer.user.login, repo.allowedAuthors)).map(d => ({ text: d.answer.body, question: d.question })),
      ...(task.baseDialogue ?? []).filter(d => this.authorized(d.answer.user.login, repo.allowedAuthors)).map(d => ({ text: d.answer.body, question: d.question })),
    ].map(input => ({ ...input, text: branchText(input.text) })).filter(input => input.text);
    let choice = await this.executor.selectBase(task, repo, inputs);
    if (choice.kind === "branch" && !await this.executor.hasBranch(repo, choice.branch)) {
      choice = { kind: "question", question: `Branch ${JSON.stringify(choice.branch)} does not exist on origin. Which existing branch should I use as the base? You can reply in your own words.` };
    }
    if (choice.kind === "question") {
      const id = `base_${createHash("sha256").update(JSON.stringify({ key: task.key, inputs, question: choice.question })).digest("hex").slice(0, 24)}`;
      await this.askTask(task, { id, text: choice.question, purpose: "base" });
      throw new WaitingForAnswer("Waiting for a base branch reply");
    }
    await this.update(task, { baseBranch: choice.branch, ...(task.question?.purpose === "base" ? { question: undefined } : {}) });
  }
  private async mergeOnce() {
    if (!this.options.autoMerge.enabled || !this.github.mergeApproved) return;
    for (const task of this.queue.tasks) {
      if (task.status !== "done" || !task.pr || task.pr.state === "closed" || !task.commit || task.merged || task.pendingFeedback?.length || (task.mergeNextAt ?? 0) > this.now()) continue;
      const repo = this.options.repositories.find(r => r.repo === task.repo);
      if (!repo) continue;
      // Older queues start watching now; historical approvals must not trigger an unexpected merge.
      if (!task.publishedAt) { await this.update(task, { publishedAt: this.now() }); continue; }
      try {
        await this.scan(); // Pick up issue feedback before considering a completed task for merge.
        if (closing(task) || task.pendingFeedback?.length || task.pr.state === "closed") continue;
        this.publishing.add(task.key);
        const merged = await this.github.mergeApproved(task.repo, task.pr.number, task.commit, task.publishedAt, repo.allowedAuthors, this.options.autoMerge);
        if (merged) {
          await this.github.ensureComment(task.repo, task.pr.number, `<!-- opencode2:${task.key}:merged -->`, "Pull request merged.");
          await this.update(task, { merged: true, pr: { ...task.pr, state: "closed" }, mergeError: undefined });
        } else await this.update(task, { mergeError: undefined, mergeNextAt: this.now() + 60_000 });
      } catch (error) {
        if (this.signal.aborted) return;
        await this.update(task, { mergeError: redact(error, this.secrets), mergeNextAt: Math.max(this.now() + 60_000, error instanceof GithubError ? error.retryAt ?? 0 : 0) });
      }
      finally { this.publishing.delete(task.key); }
    }
  }
  runtime(sessionID: string) {
    const task = this.queue.tasks.find(t => t.sessionID === sessionID || t.helpers?.some(h => h.id === sessionID && h.parentID === t.sessionID));
    if (!task || closing(task)) return null;
    const result = JSON.parse(JSON.stringify(task)) as Task;
    const matching = Object.values(this.options.routes).filter(r => r.agent === task.route?.agent && r.model.id === task.route?.model.id && r.model.providerID === task.route?.model.providerID);
    const configured = matching.length === 1 ? matching[0] : undefined;
    if (result.route && configured) result.route = { ...result.route, capabilities: configured.capabilities, mediaModel: configured.mediaModel };
    return result;
  }
  async question(sessionID: string, id: string, text: string, permission?: { action: string; resources: string[] }) {
    const task = this.queue.tasks.find(t => t.sessionID === sessionID);
    if (!task || task.phase !== "running" || !["ready", "retry_wait", "waiting"].includes(task.status)) throw new Error("No active bot task for this session");
    return this.askTask(task, { id, text, sessionID, ...(permission ? { permission } : {}) });
  }
  private async askTask(task: Task, input: z.infer<typeof PendingQuestion>) {
    let question!: z.infer<typeof PendingQuestion>;
    await this.serial.run(async () => {
      requireTracked(task);
      if (!task.question || task.question.delivered) task.question = input;
      question = task.question; await this.store.save(this.queue);
    });
    await this.publishQuestion(task, question);
    return { id: question.id };
  }
  private async publishQuestion(task: Task, question: z.infer<typeof PendingQuestion>) {
    requireTracked(task);
    if (!question.commentID) {
      const body = `Question (${question.id})\n\n${question.text}\n\n${question.permission ? `Reply with /allow ${question.id} or /deny ${question.id}.` : "Reply in this issue to continue. Only configured authors can answer."}`;
      const marker = `<!-- opencode2:${task.key}:question:${question.id} -->`;
      const post = this.questionPosts.get(marker) ?? this.github.ensureComment(task.repo, task.issue.number, marker, body);
      this.questionPosts.set(marker, post);
      try {
        const commentID = await post;
        await this.serial.run(async () => {
          if (task.question?.id === question.id) task.question.commentID = commentID;
          await this.store.save(this.queue);
        });
      } finally { if (this.questionPosts.get(marker) === post) this.questionPosts.delete(marker); }
    }
  }
  async helper(sessionID: string, callID: string, capability: "vision" | "audio") {
    const task = this.queue.tasks.find(t => t.sessionID === sessionID);
    if (!task || closing(task) || task.phase !== "running" || task.question && !task.question.delivered) throw new Error("No active main bot session available for delegation");
    const id = `ses_${createHash("sha256").update(`${sessionID}:${callID}`).digest("hex").slice(0, 32)}`;
    await this.serial.run(async () => {
      requireTracked(task);
      if (!task.helpers?.some(h => h.id === id)) task.helpers = [...task.helpers ?? [], { id, parentID: sessionID, capability }];
      await this.store.save(this.queue);
    });
    return { id };
  }
  async retry(key: string, restartSession: boolean) {
    if (this.working || this.maintenance) throw new Error("Worker is busy; retry after it finishes");
    this.maintenance = this.retryOnce(key, restartSession);
    try { return await this.maintenance; }
    finally { this.maintenance = undefined; }
  }
  async restartWorkflow(key: string) {
    return this.serial.run(async () => {
      this.signal.throwIfAborted();
      const task = this.queue.tasks.find(t => t.key === key);
      if (!task) throw new Error("Task not found in this project");
      if (closing(task)) throw new Error("Task tracking is closed; inspect its saved session or create a new issue");
      if (task.question && !task.question.delivered) throw new Error("Answer the pending question or permission request in the GitHub issue first");
      if (task.merged || task.pr?.state === "closed") throw new Error("The original PR is closed or merged; reopen it or create a new issue");
      if (!["blocked", "failed"].includes(task.status)) return false;
      if (task.phase === "running" && !stoppedSession(task)) throw new Error("Inspect the session error before retrying; workflow restart cannot bypass uncertain prompt delivery or execution configuration errors");
      if (!task.route) throw new Error("Fix the execution route and use retry before restarting the workflow");
      Object.assign(task, {
        status: "ready", attempts: 0, nextAt: this.now(), error: undefined,
        ...(task.phase === "running" ? { recovery: { id: randomUUID() } } : {}),
      });
      await this.store.save(this.queue);
      return true;
    });
  }
  private async retryOnce(key: string, restartSession: boolean) {
    const task = this.queue.tasks.find(t => t.key === key);
    if (!task || !["blocked", "failed"].includes(task.status)) return false;
    if (restartSession) {
      await this.executor.cancel(task);
      await this.update(task, { sessionID: undefined, completion: undefined, promptAttempted: undefined, phase: task.commentID ? "commented" : "queued", analysis: task.commentID ? task.analysis : undefined });
    }
    if (!task.route) {
      const latest = await this.github.issue(task.repo, task.issue.number);
      await this.update(task, { issue: latest, route: matchRoute(latest.body ?? "", this.options.routes) });
    }
    await this.update(task, { status: "ready", attempts: 0, nextAt: this.now(), error: undefined });
    return true;
  }
  async closeTask(key: string) {
    const task = await this.serial.run(async () => {
      this.signal.throwIfAborted();
      const task = this.queue.tasks.find(t => t.key === key);
      if (!task) throw new Error("Task not found in this project");
      if (task.status === "closed") return undefined;
      if (this.publishing.has(key)) throw new Error("Publication or merge is already in flight. Wait for it to finish, then close the task.");
      Object.assign(task, { status: "closing", closeRequestedAt: task.closeRequestedAt ?? this.now(), closeError: undefined, nextAt: this.now() });
      await this.store.save(this.queue);
      return task;
    });
    if (!task) return false;
    await this.notify(activityOf(task)).catch(() => {});
    this.startClosing(task);
    return true;
  }
  private startClosing(task: Task) {
    if (this.closures.has(task.key) || this.signal.aborted) return;
    const work = this.activeTask === task.key ? this.working : undefined;
    const operation = (async () => {
      try {
        // The durable status is saved before interruption. A replacement owner
        // resumes this operation and never retries implementation/publication.
        await this.executor.cancel(task, true);
        await work;
        await Promise.allSettled([...this.questionPosts].filter(([key]) => key.startsWith(`<!-- opencode2:${task.key}:`)).map(([, post]) => post));
        // Session creation may have been in flight before the first interrupt.
        await this.executor.cancel(task, true);
        await this.serial.run(async () => {
          this.signal.throwIfAborted();
          Object.assign(task, { status: "closed", closedAt: this.now(), closeError: undefined });
          await this.store.save(this.queue);
        });
      } catch (error) {
        if (this.signal.aborted) return;
        await this.serial.run(async () => {
          Object.assign(task, { status: "closing", closedAt: undefined, closeError: redact(error, this.secrets), nextAt: this.now() + 30_000 });
          await this.store.save(this.queue);
        });
      }
      await this.notify(activityOf(task)).catch(() => {});
    })().catch(error => console.error("Task closure failed", redact(error, this.secrets))).finally(() => this.closures.delete(task.key));
    this.closures.set(task.key, operation);
  }
  async settle() { await Promise.allSettled([this.scanning, this.working, this.maintenance, ...this.closures.values()]); }
}
