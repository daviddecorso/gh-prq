import { firstErrorLine, run, type Runner } from "../exec.ts";
import type { ClassifiedPR } from "../types.ts";
import type { DraftComment, FollowUpStatus, ReviewDraft } from "./schema.ts";

export interface ReviewPayload {
  commit_id: string;
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

/** Omits `event` so GitHub keeps the review pending until the user submits it in the browser. */
export function toReviewPayload(
  draft: ReviewDraft,
  pr: ClassifiedPR,
  { foldComments = false, commitId = pr.headOid } = {},
): ReviewPayload {
  return {
    commit_id: commitId,
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
): Promise<string> {
  const post = (payload: ReviewPayload) =>
    exec("gh", ["api", "--method", "POST", `repos/${pr.repo}/pulls/${pr.number}/reviews`, "--input", "-"], {
      input: JSON.stringify(payload),
    });

  let res = await post(toReviewPayload(draft, pr, { commitId }));
  let folded = false;
  const output = () => `${res.stderr}\n${res.stdout}`;
  if (res.code !== 0 && PENDING_EXISTS_RE.test(output())) {
    throw new Error(`You already have a pending review on ${pr.repo}#${pr.number}. Submit or discard it first.`);
  }
  if (res.code !== 0 && UNPROCESSABLE_RE.test(output()) && draft.comments.length > 0) {
    res = await post(toReviewPayload(draft, pr, { foldComments: true, commitId }));
    folded = true;
  }
  if (res.code !== 0) throw new Error(`Posting failed: ${firstErrorLine(res)}`);

  return `Pending review on ${pr.repo}#${pr.number}${folded ? " (comments moved into the body)" : ""}. Submit it in the browser.`;
}
