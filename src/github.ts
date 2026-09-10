import { z } from "zod";

export const Issue = z.object({
  number: z.number().int().positive(), title: z.string(), body: z.string().nullable(),
  state: z.string(), user: z.object({ login: z.string() }), pull_request: z.unknown().optional(),
});
export type Issue = z.infer<typeof Issue>;
export const Comment = z.object({ id: z.number(), body: z.string(), user: z.object({ login: z.string(), type: z.string().optional() }) });
export type Comment = z.infer<typeof Comment>;
const Pull = z.object({ number: z.number(), html_url: z.string().url(), state: z.string() });
export type Pull = z.infer<typeof Pull>;

export class GithubError extends Error {
  constructor(readonly status: number, readonly retryAt?: number) { super(`GitHub HTTP ${status}`); }
}
export class Github {
  private login?: string;
  constructor(private token: string, private signal: AbortSignal, private fetcher: typeof fetch = fetch) {}
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
  async ensureComment(repo: string, number: number, marker: string, body: string): Promise<number> {
    this.login ??= z.object({ login: z.string() }).parse(await this.request("/user")).login;
    const comments = await this.comments(repo, number);
    const found = comments.find(c => c.user.login === this.login && c.body.includes(marker));
    if (found) return found.id;
    return Comment.parse(await this.request(`/repos/${repo}/issues/${number}/comments`, "POST", { body: `${marker}\n${body}` })).id;
  }
  async findPull(repo: string, branch: string): Promise<Pull | undefined> {
    const head = encodeURIComponent(`${repo.split("/")[0]}:${branch}`);
    return (await this.pages(`/repos/${repo}/pulls?state=all&head=${head}`, Pull))[0];
  }
  async ensurePull(repo: string, branch: string, base: string, title: string, body: string): Promise<Pull> {
    return await this.findPull(repo, branch) ?? Pull.parse(await this.request(`/repos/${repo}/pulls`, "POST", { head: branch, base, title, body }));
  }
}
