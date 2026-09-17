import test from "node:test";
import assert from "node:assert/strict";
import { approvalAuthors, type Review, type DatedComment } from "../src/approval.js";
import { Github } from "../src/github.js";

const since = Date.parse("2026-09-10T10:00:00Z");
const review: Review = { id: 1, user: { login: "alice" }, state: "APPROVED", commit_id: "head", submitted_at: "2026-09-10T11:00:00Z" };
const comment: DatedComment = { id: 2, user: { login: "alice" }, body: "/merge", created_at: "2026-09-10T11:00:00Z", updated_at: "2026-09-10T11:00:00Z" };
const policy = { enabled: true, method: "squash" as const, comments: ["/merge", "jest git, możesz mergować"] };
test("reviews must reference the published head and must not be superseded or unsubmitted", () => {
  assert.deepEqual(approvalAuthors([review], [], "head", since, policy.comments), ["alice"]);
  assert.deepEqual(approvalAuthors([review], [], "new-head", since, policy.comments), []);
  assert.deepEqual(approvalAuthors([review], [], "head", since + 9_000_000, policy.comments), ["alice"]);
  assert.deepEqual(approvalAuthors([{ ...review, submitted_at: null }], [], "head", since, policy.comments), []);
  for (const state of ["CHANGES_REQUESTED", "DISMISSED"]) {
    assert.deepEqual(approvalAuthors([review, { ...review, id: 3, state }], [], "head", since, policy.comments), []);
  }
  assert.deepEqual(approvalAuthors([{ ...review, state: "CHANGES_REQUESTED" }], [comment], "head", since, policy.comments), []);
});
test("merge comments use exact configurable phrases and reject negations, quotes, bot replies and old messages", () => {
  for (const body of ["/merge", "Jest git, możesz mergować!"]) assert.deepEqual(approvalAuthors([], [{ ...comment, body }], "head", since, policy.comments), ["alice"]);
  for (const body of ["do not /merge", "> /merge", "not approved", "looks good", "<!-- opencode2:test -->\n/merge"]) assert.deepEqual(approvalAuthors([], [{ ...comment, body }], "head", since, policy.comments), []);
  assert.deepEqual(approvalAuthors([], [{ ...comment, user: { login: "alice", type: "Bot" } }], "head", since, policy.comments), []);
  assert.deepEqual(approvalAuthors([], [{ ...comment, created_at: "2026-09-09T00:00:00Z" }], "head", since, policy.comments), []);
});
function api(overrides: { head?: string; permission?: string; mergeable_state?: string; merged?: boolean; mergeResult?: boolean } = {}) {
  const writes: { path: string; body: any }[] = [];
  const fetcher = async (url: any, init: any) => {
    const path = new URL(String(url)).pathname;
    if (init.method === "PUT") { writes.push({ path, body: JSON.parse(init.body) }); return Response.json({ merged: overrides.mergeResult ?? true }); }
    if (path.endsWith("/reviews")) return Response.json([review]);
    if (path.endsWith("/comments")) return Response.json([]);
    if (path.endsWith("/permission")) return Response.json({ permission: overrides.permission ?? "write" });
    return Response.json({ state: "open", draft: false, merged: overrides.merged ?? false, head: { sha: overrides.head ?? "head" }, mergeable: true, mergeable_state: overrides.mergeable_state ?? "clean" });
  };
  return { writes, github: new Github("fake", new AbortController().signal, fetcher as typeof fetch) };
}
test("merge API requires an allowed writer and pins the verified SHA", async () => {
  const f = api(); assert.equal(await f.github.mergeApproved("o/r", 2, "head", since, ["alice"], policy), true);
  assert.deepEqual(f.writes[0], { path: "/repos/o/r/pulls/2/merge", body: { sha: "head", merge_method: "squash" } });
  for (const overrides of [{ head: "other" }, { permission: "read" }]) {
    const f = api(overrides); assert.equal(await f.github.mergeApproved("o/r", 2, "head", since, ["alice"], policy), false); assert.equal(f.writes.length, 0);
  }
  const stranger = api(); assert.equal(await stranger.github.mergeApproved("o/r", 2, "head", since, ["bob"], policy), false); assert.equal(stranger.writes.length, 0);
});
test("approval of the same SHA survives delayed publication, but an old merge comment cannot authorize it", async () => {
  const publishedLater = since + 9_000_000;
  const f = api();
  assert.equal(await f.github.mergeApproved("o/r", 2, "head", publishedLater, ["alice"], policy), true);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0]!.body.sha, "head");
  assert.deepEqual(approvalAuthors([], [comment], "head", publishedLater, policy.comments), []);
  assert.deepEqual(approvalAuthors([review], [], "different-head", publishedLater, policy.comments), []);
  for (const state of ["DISMISSED", "CHANGES_REQUESTED"]) {
    assert.deepEqual(approvalAuthors([review, { ...review, id: 3, state }], [comment], "head", publishedLater, policy.comments), []);
  }
});
test("unready checks defer merging and an already merged PR reconciles without another PUT", async () => {
  const f = api({ mergeable_state: "unstable" }); await assert.rejects(f.github.mergeApproved("o/r", 2, "head", since, ["alice"], policy), /not ready/); assert.equal(f.writes.length, 0);
  const failed = api({ mergeResult: false }); await assert.rejects(failed.github.mergeApproved("o/r", 2, "head", since, ["alice"], policy), /did not merge/);
  const done = api({ merged: true }); assert.equal(await done.github.mergeApproved("o/r", 2, "head", since, ["alice"], policy), true); assert.equal(done.writes.length, 0);
});
test("comments and PR descriptions carry the configurable signature; default uses authenticated login", async () => {
  for (const signature of [undefined, "d3cker[OpenCode2]"]) {
    const bodies: string[] = [];
    const fetcher = async (url: any, init: any) => {
      const path = new URL(String(url)).pathname;
      if (path === "/user") return Response.json({ login: "alice" });
      if (init.method === "POST") {
        const body = JSON.parse(init.body); bodies.push(body.body);
        return Response.json(path.endsWith("/comments") ? { id: 1, body: body.body, user: { login: "alice" } } : { number: 2, html_url: "https://github.com/o/r/pull/2", state: "open" });
      }
      return Response.json([]);
    };
    const g = new Github("fake", new AbortController().signal, fetcher as typeof fetch, signature);
    await g.ensureComment("o/r", 1, "<!-- opencode2:test -->", "Plan");
    await g.ensurePull("o/r", "branch", "main", "Add feature", "Description");
    assert.ok(bodies.every(b => b.endsWith(signature ?? "alice[OpenCode2]")));
    assert.ok(bodies[0]!.startsWith("<!-- opencode2:test -->"));
  }
});
