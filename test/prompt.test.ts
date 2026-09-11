import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botPrompt } from "../src/prompt.js";
import { baseChoice, branchText } from "../src/branch.js";

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
test("branch selection requires literal evidence and never accepts an invented ref", () => {
  const inputs = [{ text: "Please use branch release/next." }];
  const selection = { kind: "branch", branch: "release/next", source: 0, quote: inputs[0]!.text };
  assert.deepEqual(baseChoice(JSON.stringify(selection), inputs, "main"), { kind: "branch", branch: "release/next" });
  for (const patch of [{ branch: "release" }, { source: 8 }, { quote: "use master" }]) {
    assert.throws(() => baseChoice(JSON.stringify({ ...selection, ...patch }), inputs, "main"), /not supported/);
  }
  assert.deepEqual(baseChoice('{"kind":"default"}', inputs, "main"), { kind: "branch", branch: "main" });
  assert.throws(() => baseChoice("use develop", inputs, "main"));
  const invalid = [{ text: "Use branch ref.lock" }];
  assert.equal(baseChoice(JSON.stringify({ kind: "branch", branch: "ref.lock", source: 0, quote: invalid[0]!.text }), invalid, "main").kind, "question");
});

test("branch requests retain prose and optional directives but ignore quoted and fenced examples", () => {
  assert.equal(branchText("Please use branch `develop`."), "Please use branch `develop`.");
  assert.equal(branchText("Base branch: release/next\n/base develop"), "Base branch: release/next\n/base develop");
  assert.equal(branchText("> /base quoted\n```text\n/base example\n```\n~~~\nuse branch another-example\n~~~\nUse branch develop instead."), "Use branch develop instead.");
});
