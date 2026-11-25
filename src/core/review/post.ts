import { firstErrorLine, type Runner, run } from "../exec.ts";
import type { ClassifiedPR } from "../types.ts";
import type { DraftComment, FollowUpStatus, ReviewDraft } from "./schema.ts";

/** `PENDING` leaves the review unsubmitted so the user finishes it in the browser. */
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES" | "PENDING";

export const EVENT_FOR_VERDICT: Record<ReviewDraft["suggestedVerdict"], ReviewEvent> = {
  approve: "APPROVE",
  comment: "COMMENT",
  request_changes: "REQUEST_CHANGES",
};

export interface ReviewPayload {
  commit_id: string;
  event?: Exclude<ReviewEvent, "PENDING">;
  body: string;
  comments: { path: string; line: number; side: "RIGHT" | "LEFT"; body: string }[];
}

const FOLLOW_UP_MARK: Record<FollowUpStatus, string> = {
  addressed: "[x]",
  partial: "[ ] (partly)",
  not_addressed: "[ ]",
};

function bodyFor(draft: ReviewDraft, folded: DraftComment[]): string {
  const parts = [draft.summary.trim()];
  if (draft.threadFollowUps.length) {
    parts.push(
      ["Earlier threads:", ...draft.threadFollowUps.map((f) => `- ${FOLLOW_UP_MARK[f.status]} \`${f.path}\`: ${f.note}`)].join("\n"),
    );
  }
  if (folded.length) {
    parts.push(folded.map((c) => `- \`${c.path}:${c.line}\`: ${c.body}`).join("\n"));
  }
  return parts.filter(Boolean).join("\n\n");
}

export function toReviewPayload(
  draft: ReviewDraft,
  pr: ClassifiedPR,
  { foldComments = false, commitId = pr.headOid, event = "PENDING" as ReviewEvent } = {},
): ReviewPayload {
  return {
    commit_id: commitId,
    ...(event !== "PENDING" && { event }),
    body: bodyFor(draft, foldComments ? draft.comments : []),
    comments: foldComments ? [] : draft.comments.map(({ path, line, side, body }) => ({ path, line, side, body })),
  };
}

const PENDING_EXISTS_RE = /one pending review/i;
const UNPROCESSABLE_RE = /HTTP 422/;

/** Approves the head the queue last saw, so a push made after the fetch isn't approved blind. */
export async function approvePR(pr: ClassifiedPR, exec: Runner = run): Promise<string> {
  const res = await exec("gh", ["api", "--method", "POST", `repos/${pr.repo}/pulls/${pr.number}/reviews`, "--input", "-"], {
    input: JSON.stringify({ commit_id: pr.headOid, event: "APPROVE" }),
  });
  if (res.code !== 0 && PENDING_EXISTS_RE.test(`${res.stderr}\n${res.stdout}`)) {
    throw new Error(`You have a pending review on ${pr.repo}#${pr.number}. Submit or discard it first.`);
  }
  if (res.code !== 0) throw new Error(`Approve failed: ${firstErrorLine(res)}`);
  return `Approved ${pr.repo}#${pr.number}`;
}

/** Resolves with a footer status message; rejects with a user-facing error. */
export async function postDraft(
  pr: ClassifiedPR,
  draft: ReviewDraft,
  exec: Runner = run,
  commitId = pr.headOid,
  event: ReviewEvent = "PENDING",
): Promise<string> {
  const post = (payload: ReviewPayload) =>
    exec("gh", ["api", "--method", "POST", `repos/${pr.repo}/pulls/${pr.number}/reviews`, "--input", "-"], {
      input: JSON.stringify(payload),
    });

  let res = await post(toReviewPayload(draft, pr, { commitId, event }));
  let folded = false;
  const output = () => `${res.stderr}\n${res.stdout}`;
  if (res.code !== 0 && PENDING_EXISTS_RE.test(output())) {
    throw new Error(`You already have a pending review on ${pr.repo}#${pr.number}. Submit or discard it first.`);
  }
  if (res.code !== 0 && UNPROCESSABLE_RE.test(output()) && draft.comments.length > 0) {
    res = await post(toReviewPayload(draft, pr, { foldComments: true, commitId, event }));
    folded = true;
  }
  if (res.code !== 0) throw new Error(`Posting failed: ${firstErrorLine(res)}`);

  const ref = `${pr.repo}#${pr.number}`;
  const note = folded ? " (comments moved into the body)" : "";
  switch (event) {
    case "PENDING":
      return `Pending review on ${ref}${note}. Submit it in the browser.`;
    case "COMMENT":
      return `Commented on ${ref}${note}`;
    case "APPROVE":
      return `Approved ${ref}${note}`;
    case "REQUEST_CHANGES":
      return `Requested changes on ${ref}${note}`;
  }
}
