import { createHash } from "node:crypto";
import { z } from "zod";

export const CompletionSummary = z.object({
  sessionID: z.string().optional(), round: z.number().int().positive().optional(),
  text: z.string().optional(), unavailable: z.string().optional(),
  commit: z.string().optional(), checks: z.array(z.string()).optional(),
});
export type CompletionSummary = z.infer<typeof CompletionSummary>;
export class DescriptionConflict extends Error {}

export function finalReport(messages: unknown[], outcome: unknown): Pick<CompletionSummary, "text" | "unavailable"> {
  const last = messages.filter((m): m is Record<string, unknown> => Boolean(m && typeof m === "object" && "type" in m && m.type === "assistant")).at(-1);
  if (outcome !== "succeeded" || !last || last.error || last.finish !== "stop") return { unavailable: "The saved session has no successfully completed final response." };
  const text = Array.isArray(last.content) ? last.content.filter(p => p?.type === "text" && typeof p.text === "string").map(p => p.text).join("\n\n").trim() : "";
  return text ? { text } : { unavailable: "The completed final response contains no text summary." };
}
function bounded(text: string, bytes: number) {
  if (Buffer.byteLength(text) <= bytes) return text;
  return Buffer.from(text).subarray(0, bytes).toString("utf8").replace(/\uFFFD$/, "") + "\n\n[Truncated for the PR description. The full report remains in the OpenCode session.]";
}
export function descriptionMarkers(key: string) {
  const id = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return { start: `<!-- opencode2:pr-body:${id}:start -->`, end: `<!-- opencode2:pr-body:${id}:end -->` };
}
function summaryText(summary: CompletionSummary) {
  return bounded(summary.text ?? `Summary unavailable: ${summary.unavailable ?? "No saved completion report."}`, 22000)
    .replaceAll("<!-- opencode2:pr-body:", "&lt;!-- opencode2:pr-body:");
}
export function renderDescription(key: string, issue: number, initial: CompletionSummary, current: CompletionSummary) {
  const { start, end } = descriptionMarkers(key);
  const parts = [start, "Agent-reported completion summary. Dispatcher verification is recorded separately below.",
    summaryText(initial), `Initial report session: ${initial.sessionID ?? "unavailable"}`];
  if (initial.sessionID !== current.sessionID || initial.round !== current.round) parts.push(
    `## Latest update${current.round ? ` — round ${current.round}` : ""}`, summaryText(current));
  parts.push("## Dispatcher verification", current.checks?.length
    ? bounded(current.checks.map(c => `- ${c}`).join("\n"), 8000)
    : "No automated test command is configured for the dispatcher. It performed Git consistency checks only. Tests described above are reported by the agent and were not independently rerun by the dispatcher.",
  `Closes #${issue}`, `OpenCode session: ${current.sessionID ?? "unavailable"}\nRound: ${current.round ?? "unknown"}\nVerified commit: ${current.commit ?? "unavailable"}`, end);
  return parts.join("\n\n");
}

// Only the last acknowledged managed block may be replaced. Everything outside
// it is retained byte-for-byte, including the signature and operator notes.
export function mergeDescription(existing: string, key: string, desired: string, previous?: string, legacy?: string) {
  const { start, end } = descriptionMarkers(key);
  const startCount = existing.split(start).length - 1, endCount = existing.split(end).length - 1;
  if (!startCount && !endCount) {
    if (previous) throw new DescriptionConflict("PR description markers were removed. Restore the last bot-managed section before retrying publication.");
    return !existing || existing === legacy ? desired : `${existing}\n\n${desired}`;
  }
  const a = existing.indexOf(start), b = existing.indexOf(end) + end.length;
  if (startCount !== 1 || endCount !== 1 || b <= a) throw new DescriptionConflict("PR description has ambiguous bot markers. Resolve them before retrying publication.");
  const current = existing.slice(a, b);
  if (current === desired) return existing; // Includes a successful PATCH whose response was lost.
  if (!previous || current !== previous) throw new DescriptionConflict("The bot-managed PR description was edited. Preserve your notes outside its markers and restore the section before retrying publication.");
  return existing.slice(0, a) + desired + existing.slice(b);
}
export function assertDescriptionSize(body: string) {
  if (Buffer.byteLength(body) > 60000) throw new DescriptionConflict("PR description exceeds the 60 KB automation limit. Shorten retained notes before retrying; no text was overwritten.");
}
