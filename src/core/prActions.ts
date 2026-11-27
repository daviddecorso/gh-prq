import { firstErrorLine, type Runner, run } from "./exec.ts";
import type { ClassifiedPR } from "./types.ts";

export type MergeMethod = "squash" | "merge" | "rebase";

const ref = (pr: ClassifiedPR) => `${pr.repo}#${pr.number}`;

/** `--auto` defers to branch protection: it merges now if allowed, otherwise once required checks and reviews pass. */
export async function mergePR(pr: ClassifiedPR, method: MergeMethod, exec: Runner = run): Promise<string> {
  const res = await exec("gh", ["pr", "merge", pr.url, "--auto", `--${method}`, "--match-head-commit", pr.headOid]);
  if (res.code !== 0) throw new Error(`Merge failed: ${firstErrorLine(res)}`);
  // Piped, gh prints nothing either way, so we can't tell an immediate merge from an armed auto-merge.
  return `Merge requested on ${ref(pr)} (${method}; waits for required checks if any)`;
}

export async function markReady(pr: ClassifiedPR, exec: Runner = run): Promise<string> {
  const res = await exec("gh", ["pr", "ready", pr.url]);
  if (res.code !== 0) throw new Error(`Couldn't mark ready: ${firstErrorLine(res)}`);
  return `${ref(pr)} is ready for review`;
}

export async function rerequestReviews(pr: ClassifiedPR, exec: Runner = run): Promise<string> {
  if (pr.pastReviewers.length === 0) throw new Error(`No past reviewers to re-request on ${ref(pr)}`);
  const res = await exec("gh", ["api", "--method", "POST", `repos/${pr.repo}/pulls/${pr.number}/requested_reviewers`, "--input", "-"], {
    input: JSON.stringify({ reviewers: pr.pastReviewers }),
  });
  if (res.code !== 0) throw new Error(`Re-request failed: ${firstErrorLine(res)}`);
  return `Re-requested ${pr.pastReviewers.map((r) => `@${r}`).join(", ")} on ${ref(pr)}`;
}
