import { z } from "zod";
import { mergeDescription, assertDescriptionSize, DescriptionConflict } from "./pr-description.js";
import { Review, DatedComment, approvalAuthors } from "./approval.js";
import type { GithubOptions } from "./config.js";

export const Issue = z.object({
  number: z.number().int().positive(), title: z.string(), body: z.string().nullable(),
  state: z.string(), user: z.object({ login: z.string() }), pull_request: z.unknown().optional(),
});
export type Issue = z.infer<typeof Issue>;
export const Comment = z.object({ id: z.number(), body: z.string(), user: z.object({ login: z.string(), type: z.string().optional() }) });
export type Comment = z.infer<typeof Comment>;
const Pull = z.object({ number: z.number(), html_url: z.string().url(), state: z.string(), merged: z.boolean().optional(), merged_at: z.string().nullable().optional() });
export type Pull = z.infer<typeof Pull>;

export class GithubError extends Error {
  constructor(readonly status: number, readonly retryAt?: number) { super(`GitHub HTTP ${status}`); }
}
export class Github {
  private login?: string;
  constructor(private token: string, private signal: AbortSignal, private fetcher: typeof fetch = fetch, private signature?: string) {}
  private async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    this.signal.throwIfAborted();
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method, redirect: "error",
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]),
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const after = response.headers.get("retry-after");
      const reset = response.headers.get("x-ratelimit-remaining") === "0" ? Number(response.headers.get("x-ratelimit-reset")) * 1000 : undefined;
      const retryAt = after ? (Number.isFinite(Number(after)) ? Date.now() + Number(after) * 1000 : Date.parse(after)) : reset;
      throw new GithubError(response.status, retryAt && Number.isFinite(retryAt) ? retryAt : undefined);
    }
    return response.json();
  }
  private async pages<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const rows = z.array(schema).parse(await this.request(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`));
      all.push(...rows);
      if (rows.length < 100) return all;
    }
  }
  issues(repo: string) { return this.pages(`/repos/${repo}/issues?state=open&sort=created&direction=asc`, Issue); }
  async issue(repo: string, number: number) { return Issue.parse(await this.request(`/repos/${repo}/issues/${number}`)); }
  comments(repo: string, number: number) { return this.pages(`/repos/${repo}/issues/${number}/comments`, Comment); }
  private async signed(body: string) {
    this.login ??= z.object({ login: z.string() }).parse(await this.request("/user")).login;
    return `${body}\n\n${this.signature ?? `${this.login}[OpenCode2]`}`;
  }
  async ensureComment(repo: string, number: number, marker: string, body: string): Promise<number> {
    this.login ??= z.object({ login: z.string() }).parse(await this.request("/user")).login;
    const comments = await this.comments(repo, number);
    const found = comments.find(c => c.user.login === this.login && c.body.includes(marker));
    if (found) return found.id;
    return Comment.parse(await this.request(`/repos/${repo}/issues/${number}/comments`, "POST", { body: await this.signed(`${marker}\n${body}`) })).id;
  }
  async findPull(repo: string, branch: string): Promise<Pull | undefined> {
    const head = encodeURIComponent(`${repo.split("/")[0]}:${branch}`);
    return (await this.pages(`/repos/${repo}/pulls?state=all&head=${head}`, Pull))[0];
  }
  async pull(repo: string, number: number): Promise<Pull> {
    return Pull.parse(await this.request(`/repos/${repo}/pulls/${number}`));
  }
  async ensurePull(repo: string, branch: string, base: string, title: string, body: string): Promise<Pull> {
    const found = await this.findPull(repo, branch);
    if (found) return found;
    const signed = await this.signed(body); assertDescriptionSize(signed);
    return Pull.parse(await this.request(`/repos/${repo}/pulls`, "POST", { head: branch, base, title, body: signed }));
  }
  async updatePullBody(repo: string, number: number, commit: string, key: string, body: string, previous?: string, legacy?: string) {
    const schema = z.object({ state: z.string(), head: z.object({ sha: z.string() }), body: z.string().nullable() });
    const read = async () => schema.parse(await this.request(`/repos/${repo}/pulls/${number}`));
    const current = await read();
    if (current.state !== "open" || current.head.sha !== commit) throw new DescriptionConflict("PR is closed or its head differs from the verified commit. Inspect it before retrying publication.");
    const signedLegacy = legacy === undefined ? undefined : await this.signed(legacy);
    let next = mergeDescription(current.body ?? "", key, body, previous, signedLegacy);
    // Sign a new body or an exact legacy replacement; retain existing signatures elsewhere.
    if (!(current.body ?? "").includes(body) && (!current.body || current.body === signedLegacy)) next = await this.signed(next);
    assertDescriptionSize(next);
    if (next === current.body) return;
    const fresh = await read();
    if (fresh.state !== "open" || fresh.head.sha !== commit || fresh.body !== current.body) throw new DescriptionConflict("PR changed while its description was being prepared. Retry after inspecting concurrent edits.");
    await this.request(`/repos/${repo}/pulls/${number}`, "PATCH", { body: next });
  }
  async mergeApproved(repo: string, number: number, commit: string, since: number, authors: string[], options: GithubOptions["autoMerge"]): Promise<boolean> {
    const detail = z.object({ state: z.string(), merged: z.boolean(), draft: z.boolean(), head: z.object({ sha: z.string() }), mergeable: z.boolean().nullable(), mergeable_state: z.string() });
    const pr = detail.parse(await this.request(`/repos/${repo}/pulls/${number}`));
    if (pr.merged) return true; // Reconcile a lost merge response without merging twice.
    if (pr.state !== "open" || pr.draft || pr.head.sha !== commit) return false;
    const reviews = await this.pages(`/repos/${repo}/pulls/${number}/reviews`, Review);
    const comments = await this.pages(`/repos/${repo}/issues/${number}/comments`, DatedComment);
    const candidates = approvalAuthors(reviews, comments, commit, since, options.comments)
      .filter(login => authors.some(a => a.toLowerCase() === login.toLowerCase()));
    let authorized = false;
    for (const login of candidates) {
      const permission = z.object({ permission: z.string() }).parse(await this.request(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`));
      if (["admin", "maintain", "write"].includes(permission.permission)) { authorized = true; break; }
    }
    if (!authorized) return false;
    if (!pr.mergeable || pr.mergeable_state !== "clean") throw new Error(`Approved PR is not ready to merge (${pr.mergeable_state}); waiting for checks and branch rules`);
    const result = z.object({ merged: z.boolean() }).parse(await this.request(`/repos/${repo}/pulls/${number}/merge`, "PUT", { sha: commit, merge_method: options.method }));
    if (!result.merged) throw new Error("GitHub did not merge the approved PR; waiting for its merge requirements");
    return true;
  }

}
