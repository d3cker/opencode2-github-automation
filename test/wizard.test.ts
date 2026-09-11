import test from "node:test";
import assert from "node:assert/strict";
import { configure } from "../src/wizard.js";

test("Enter accepts displayed defaults based on the authenticated account and detected model", async () => {
  const prompts: string[] = [];
  const result = await configure(async prompt => { prompts.push(prompt); return ""; }, { login: "alice", model: "provider/model", check: ["npm", "test"] }, { capabilities: ["text", "vision"], baseBranch: "main" });
  assert.equal(result.model, "provider/model"); assert.equal(result.trigger, "@opencodebot");
  assert.equal(result.signature, "alice[OpenCode2]"); assert.deepEqual(result.authors, ["alice"]);
  assert.equal(result.everySeconds, 60); assert.equal(result.autoMerge?.enabled, true);
  assert.deepEqual(result.check, ["npm", "test"]); assert.equal(prompts.length, 8);
  assert.ok(prompts.every(p => p.includes("[") && !p.includes("d3cker")));
});
test("users can override every prompted default, including complex test arguments", async () => {
  const answers = ["other/model", "@team-bot", "team[Agent]", "alice, bob", "120", "yes", "rebase", '["node","--test","file with spaces.js"]'];
  const result = await configure(async () => answers.shift()!, { login: "alice", model: "provider/model" }, { capabilities: ["text", "vision"], baseBranch: "main" });
  assert.equal(result.model, "other/model"); assert.equal(result.trigger, "@team-bot");
  assert.equal(result.signature, "team[Agent]"); assert.deepEqual(result.authors, ["alice", "bob"]);
  assert.equal(result.everySeconds, 120); assert.equal(result.autoMerge?.method, "rebase");
  assert.deepEqual(result.check, ["node", "--test", "file with spaces.js"]);
});
test("missing models are required, invalid values retry, and no detected tests defaults to skip", async () => {
  const answers = ["", "invalid", "provider/model", "", "", "", "zero", "", "no", ""];
  const prompts: string[] = [];
  const result = await configure(async prompt => { prompts.push(prompt); assert.ok(answers.length); return answers.shift()!; }, { login: "bob" }, { capabilities: ["text", "vision"], baseBranch: "main" });
  assert.ok(prompts[0]!.includes("required")); assert.ok(prompts.some(p => p.startsWith("Invalid value")));
  assert.equal(result.check, false); assert.equal(result.autoMerge?.enabled, false);
  assert.equal(result.signature, "bob[OpenCode2]");
});
test("explicit setup values skip prompts and preserve custom settings", async () => {
  const result = await configure(async () => { throw new Error("Unexpected prompt"); }, { login: "alice" }, {
    capabilities: ["text", "vision"], baseBranch: "main", model: "provider/model", trigger: "@legacy", signature: "custom", authors: ["bob"], everySeconds: 12,
    autoMerge: { enabled: false, method: "merge" }, check: false,
  });
  assert.equal(result.trigger, "@legacy"); assert.equal(result.signature, "custom");
  assert.deepEqual(result.authors, ["bob"]);
});

test("a text-only main model requires a separate vision helper and accepts a base branch", async () => {
  const answers = ["provider/main", "text", "provider/vision", "text,vision,audio", "develop", "", "", "", "", "", "", ""];
  const result = await configure(async () => { assert.ok(answers.length); return answers.shift()!; }, { login: "alice" });
  assert.deepEqual(result.capabilities, ["text"]);
  assert.deepEqual(result.mediaModel, { model: "provider/vision", capabilities: ["text", "vision", "audio"] });
  assert.equal(result.baseBranch, "develop");
});
