import type { BucketId, ClassifiedPR, QueueResult } from "../src/core/types.ts";

export const NOW = Date.UTC(2026, 0, 2);

export function item(id: string, bucket: BucketId, overrides: Partial<ClassifiedPR> = {}): ClassifiedPR {
  const number = Number(id.replace(/\D/g, "")) || 1;
  return {
    id,
    repo: "acme/api",
    number,
    title: `PR ${id}`,
    url: `https://github.com/acme/api/pull/${number}`,
    author: "alice",
    bucket,
    reason: `reason ${id}`,
    allReasons: [`reason ${id}`],
    ciState: "SUCCESS",
    failedChecks: [],
    additions: 1,
    deletions: 1,
    headOid: "c1",
    lastReviewedCommitOid: null,
    commits: [],
    commitCount: 0,
    viewerThreads: [],
    badges: [],
    updatedAt: new Date(NOW).toISOString(),
    actionSince: new Date(NOW).toISOString(),
    ...overrides,
  };
}

export function result(items: ClassifiedPR[], overrides: Partial<QueueResult> = {}): QueueResult {
  return { viewer: "me", fetchedAt: new Date(NOW).toISOString(), fromCache: false, warnings: [], items, ...overrides };
}
