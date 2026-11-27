import { firstErrorLine, type Runner, run } from "./exec.ts";
import type { ClassifiedPR } from "./types.ts";

export type MergeMethod = "squash" | "merge" | "rebase";

const ref = (pr: ClassifiedPR) => `${pr.repo}#${pr.number}`;

/** Merges via `gh pr merge` without `--admin`, so branch protection and required checks still apply. */
export async function mergePR(pr: ClassifiedPR, method: MergeMethod, exec: Runner = run): Promise<string> {
  const res = await exec("gh", ["pr", "merge", pr.url, `--${method}`, "--match-head-commit", pr.headOid]);
  if (res.code !== 0) throw new Error(`Merge failed: ${firstErrorLine(res)}`);
  // Repos with a merge queue enqueue the PR instead of merging immediately, and piped gh prints nothing either way.
  return `Merge requested on ${ref(pr)} (${method})`;
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
