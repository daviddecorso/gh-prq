import type { Config } from "../core/config.ts";
import type { BucketId, ClassifiedPR, QueueResult } from "../core/types.ts";

export interface FilterFlags {
  reviews?: boolean;
  mine?: boolean;
  all?: boolean;
}

const REVIEWER_BUCKETS: ReadonlySet<BucketId> = new Set([
  "NEEDS_REREVIEW",
  "NEEDS_INITIAL_REVIEW",
  "WAITING_ON_AUTHOR",
  "DRAFTS",
]);

export function filterItems(result: QueueResult, flags: FilterFlags, config: Config): ClassifiedPR[] {
  const isMine = (pr: ClassifiedPR) => pr.author === result.viewer;
  let items = result.items;
  if (flags.reviews) items = items.filter((pr) => !isMine(pr) && REVIEWER_BUCKETS.has(pr.bucket));
  if (flags.mine) items = items.filter(isMine);
  if (!flags.all && !config.ui.showDrafts) items = items.filter((pr) => pr.bucket !== "DRAFTS");
  return items;
}
