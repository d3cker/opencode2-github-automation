import { z } from "zod";
import { BranchName } from "./config.js";

export type BranchInput = { text: string; question?: string };
export type BaseChoice = { kind: "branch"; branch: string } | { kind: "question"; question: string };
const Decision = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }).strict(),
  z.object({ kind: z.literal("branch"), branch: z.string().min(1).max(250), source: z.number().int().nonnegative(), quote: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("question"), question: z.string().min(1).max(4000) }).strict(),
]);

// Quoted messages and code examples are context, not branch-selection requests.
export function branchText(text: string): string {
  let fence: string | undefined;
  return text.split(/\r?\n/).filter(line => {
    const delimiter = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
      return false;
    }
    return !fence && !/^\s*>/.test(line);
  }).join("\n").trim();
}

export function baseChoice(raw: string, inputs: BranchInput[], fallback: string): BaseChoice {
  const json = raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  const decision = Decision.parse(JSON.parse(json));
  if (decision.kind === "question") return decision;
  if (decision.kind === "default") return { kind: "branch", branch: BranchName.parse(fallback) };
  const source = inputs[decision.source]?.text;
  // Require a literal branch name in the authorized user's text. The model may
  // interpret intent, negation, and corrections, but cannot invent another ref.
  const tokens = decision.quote.match(/[A-Za-z0-9_/.-]+/g) ?? [];
  if (!source?.includes(decision.quote) || !tokens.some(t => [decision.branch, `origin/${decision.branch}`].includes(t.replace(/[.,]+$/, "")))) {
    throw new Error("Base branch selection was not supported by the user's text; selection will retry");
  }
  if (!BranchName.safeParse(decision.branch).success) return { kind: "question", question: `The requested branch name ${JSON.stringify(decision.branch)} is not valid. Which existing branch on origin should I use as the base?` };
  return { kind: "branch", branch: decision.branch };
}
