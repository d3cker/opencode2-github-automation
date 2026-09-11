import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botPrompt } from "../src/prompt.js";
import { requestedBase } from "../src/branch.js";

test("the bundled bot instructions are always loaded and custom Markdown is re-read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc2-prompt-"));
  try {
    const options = { ownerDirectory: dir, systemPromptFile: "bot.md" };
    await writeFile(join(dir, "bot.md"), "First policy");
    let prompt = await botPrompt(options); assert.match(prompt, /ask_issue/); assert.match(prompt, /First policy/);
    await writeFile(join(dir, "bot.md"), "Updated policy");
    prompt = await botPrompt(options); assert.match(prompt, /Updated policy/); assert.doesNotMatch(prompt, /First policy/);
    await rm(join(dir, "bot.md")); await assert.rejects(botPrompt(options), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("base branch directives reject option injection and malformed refs", () => {
  assert.equal(requestedBase(["hello", "/base feature/one"], "main"), "feature/one");
  assert.equal(requestedBase(["Base branch: develop", "/base release/next"], "main"), "release/next");
  for (const bad of ["--upload-pack=evil", "../../main", "bad//ref", "ref.lock"]) assert.throws(() => requestedBase([`/base ${bad}`], "main"));
  assert.equal(requestedBase(["> /base injected"], "main"), "main");
});

test("branch directives accept inline code but ignore quoted and fenced examples", () => {
  assert.equal(requestedBase(["Base branch: `release/next`"], "main"), "release/next");
  assert.equal(requestedBase(["> /base quoted\n```text\n/base example\n```\n~~~\n/base another-example\n~~~"], "main"), "main");
});
