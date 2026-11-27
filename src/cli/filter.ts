import type { Config } from "../core/config.ts";
import { isSnoozed, type Snoozes } from "../core/snooze.ts";
import type { BucketId, ClassifiedPR, QueueResult } from "../core/types.ts";

export interface FilterFlags {
  reviews?: boolean;
  mine?: boolean;
  all?: boolean;
}

const REVIEWER_BUCKETS: ReadonlySet<BucketId> = new Set(["NEEDS_REREVIEW", "NEEDS_INITIAL_REVIEW", "WAITING_ON_AUTHOR", "DRAFTS"]);

/** Snoozed PRs are hidden unless `--all`; the TUI omits `snoozes` because it toggles them itself. */
export function filterItems(result: QueueResult, flags: FilterFlags, config: Config, snoozes?: Snoozes): ClassifiedPR[] {
  const isMine = (pr: ClassifiedPR) => pr.author === result.viewer;
  let items = result.items;
  if (flags.reviews) items = items.filter((pr) => !isMine(pr) && REVIEWER_BUCKETS.has(pr.bucket));
  if (flags.mine) items = items.filter(isMine);
  if (!flags.all && !config.ui.showDrafts) items = items.filter((pr) => pr.bucket !== "DRAFTS");
  if (!flags.all && snoozes) items = items.filter((pr) => !isSnoozed(pr, snoozes));
  return items;
}
