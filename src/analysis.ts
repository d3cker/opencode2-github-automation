import { z } from "zod";

// Keep the decision separate from the prose: publishing a plan is not approval
// to implement it, and questions must enter the dispatcher's durable wait state.
const comment = z.string().trim().min(1).max(12000);
export const AnalysisDecision = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("proceed"), comment }).strict(),
  z.object({ kind: z.literal("question"), comment, question: z.string().trim().min(1).max(4000) }).strict(),
]);
export type AnalysisDecision = z.infer<typeof AnalysisDecision>;

export function analysisDecision(raw: string): AnalysisDecision {
  const json = raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  return AnalysisDecision.parse(JSON.parse(json));
}
