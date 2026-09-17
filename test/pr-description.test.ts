import test from "node:test";
import assert from "node:assert/strict";
import { finalReport, renderDescription, mergeDescription, descriptionMarkers, assertDescriptionSize, DescriptionConflict } from "../src/pr-description.js";
import { Github } from "../src/github.js";

const key = "owner/repo#1";
const first = { sessionID: "ses_first", round: 1, text: "## Summary\n\nImplemented **controls**.\n\n24/24 tests passed.", commit: "one", checks: ["npm test — passed"] };
const next = { sessionID: "ses_next", round: 2, text: "Fixed a conflict in controller bindings.", commit: "two", checks: [] };
const original = renderDescription(key, 1, first, first);
const updated = renderDescription(key, 1, first, next);

test("completion extraction copies only final public text from a successful session", () => {
  const messages = [
    { type: "assistant", finish: "stop", content: [{ type: "text", text: "Old round" }] },
    { type: "assistant", finish: "stop", content: [
      { type: "reasoning", text: "Private reasoning" }, { type: "tool", text: "Tool output" },
      { type: "text", text: first.text },
    ] },
  ];
  assert.deepEqual(finalReport(messages, "succeeded"), { text: first.text });
  assert.ok(finalReport(messages, "failed").unavailable);
  assert.ok(finalReport([...messages, { type: "assistant", finish: "error", error: { message: "failed" } }], "succeeded").unavailable);
  assert.ok(finalReport([{ type: "assistant", finish: "stop", content: [{ type: "reasoning", text: "hidden" }] }], "succeeded").unavailable);
});

test("PR includes original report and latest round while separating agent tests from dispatcher checks", () => {
  assert.ok(updated.includes(first.text)); assert.ok(updated.includes(next.text));
  assert.match(updated, /Latest update — round 2/); assert.match(updated, /Verified commit: two/);
  assert.match(updated, /No automated test command is configured for the dispatcher/);
  assert.match(updated, /not independently rerun by the dispatcher/);
  assert.equal((updated.match(/Closes #1/g) ?? []).length, 1);
  assert.ok(renderDescription(key, 1, { unavailable: "Session missing" }, next).includes("Summary unavailable: Session missing"));
});

test("updates preserve operator notes and lost-response retries do not duplicate managed sections", () => {
  const body = `Operator introduction\n\n${original}\n\nOperator notes\n\nsignature`;
  const result = mergeDescription(body, key, updated, original);
  assert.equal(result, body.replace(original, updated));
  assert.equal(mergeDescription(result, key, updated, original), result);
  assert.equal(mergeDescription("An existing human description", key, updated), `An existing human description\n\n${updated}`);
  assert.equal(mergeDescription("Exact old signed acknowledgement", key, updated, undefined, "Exact old signed acknowledgement"), updated);
});

test("manual edits inside the managed block, missing markers and ambiguous markers are preserved with a conflict", () => {
  assert.throws(() => mergeDescription(original.replace("controls", "manual correction"), key, updated, original), DescriptionConflict);
  assert.throws(() => mergeDescription("Manually replaced description", key, updated, original), DescriptionConflict);
  assert.throws(() => mergeDescription(original + original, key, updated, original), DescriptionConflict);
  const markers = descriptionMarkers(key);
  assert.throws(() => mergeDescription(markers.end + markers.start, key, updated, original), DescriptionConflict);
});

test("long reports are bounded and marked as truncated without exposing management markers from generated text", () => {
  const text = "🎮".repeat(30000) + descriptionMarkers(key).end;
  const body = renderDescription(key, 1, { ...first, text }, { ...next, text });
  assert.match(body, /Truncated for the PR description/); assertDescriptionSize(body);
  const injected = renderDescription(key, 1, { ...first, text: descriptionMarkers(key).end }, first);
  assert.equal(injected.split(descriptionMarkers(key).end).length - 1, 1);
  assert.throws(() => assertDescriptionSize("🎮".repeat(16000)), DescriptionConflict);
});

function githubFixture() {
  let body = `Notes above\n${original}\nNotes below`, sha = "two", state = "open", lost = false, concurrent = false, reads = 0;
  const patches: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/user")) return Response.json({ login: "bot" });
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body)); patches.push(patch); body = patch.body;
      if (lost) { lost = false; throw new Error("lost response after PATCH"); }
      return Response.json({});
    }
    reads++;
    if (concurrent && reads === 2) body += "\nConcurrent note";
    return Response.json({ body, state, head: { sha } });
  };
  return { github: new Github("token", new AbortController().signal, fetcher), patches, body: () => body,
    lose: () => { lost = true; }, race: () => { concurrent = true; }, head: (value: string) => { sha = value; }, close: () => { state = "closed"; } };
}

test("GitHub description reconciliation retries a lost PATCH response without changing title or manual notes", async () => {
  const f = githubFixture(); f.lose();
  await assert.rejects(f.github.updatePullBody("owner/repo", 2, "two", key, updated, original), /lost response/);
  await f.github.updatePullBody("owner/repo", 2, "two", key, updated, original);
  assert.equal(f.patches.length, 1); assert.deepEqual(Object.keys(f.patches[0]!), ["body"]);
  assert.equal(f.body(), `Notes above\n${updated}\nNotes below`);
});

test("GitHub refuses stale heads, closed PRs and a detected concurrent description edit", async () => {
  for (const scenario of ["head", "closed", "race"]) {
    const f = githubFixture();
    if (scenario === "head") f.head("unexpected"); else if (scenario === "closed") f.close(); else f.race();
    await assert.rejects(f.github.updatePullBody("owner/repo", 2, "two", key, updated, original), DescriptionConflict);
    assert.equal(f.patches.length, 0);
  }
});
