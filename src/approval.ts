import { z } from "zod";

export const Review = z.object({ id: z.number(), user: z.object({ login: z.string() }), state: z.string(), commit_id: z.string(), submitted_at: z.string().nullable(), body: z.string().nullable().optional() });
export type Review = z.infer<typeof Review>;
export const DatedComment = z.object({ id: z.number(), body: z.string(), user: z.object({ login: z.string(), type: z.string().optional() }), created_at: z.string(), updated_at: z.string() });
export type DatedComment = z.infer<typeof DatedComment>;
const normalize = (text: string) => text.trim().toLowerCase().replace(/[.!]+$/, "").replace(/\s+/g, " ");
export function approvalAuthors(reviews: Review[], comments: DatedComment[], head: string, since: number, phrases: string[]): string[] {
  const latest = new Map<string, Review>();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) latest.set(review.user.login.toLowerCase(), review);
  }
  // An outstanding request for changes takes precedence over a merge comment.
  if ([...latest.values()].some(r => r.state === "CHANGES_REQUESTED")) return [];
  const authors = [...latest.values()].filter(r => r.state === "APPROVED" && r.commit_id === head && Date.parse(r.submitted_at ?? "") > since).map(r => r.user.login);
  for (const comment of comments) {
    if (comment.user.type === "Bot" || comment.body.includes("<!-- opencode2:") || Date.parse(comment.created_at) <= since) continue;
    // Exact full-message matching avoids interpreting negations, quotes, or embedded instructions as approval.
    if (phrases.some(p => normalize(p) === normalize(comment.body))) authors.push(comment.user.login);
  }
  return [...new Set(authors)];
}
