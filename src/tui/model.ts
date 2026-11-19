import { BUCKET_ORDER, type BucketId, type ClassifiedPR } from "../core/types.ts";
import type { ReviewJob } from "./useReviews.ts";

export type Row =
  | { kind: "header"; bucket: BucketId; count: number; collapsed: boolean }
  | { kind: "pr"; pr: ClassifiedPR };

export const rowKey = (row: Row): string => (row.kind === "header" ? `h:${row.bucket}` : `pr:${row.pr.id}`);

export const bucketOfRow = (row: Row): BucketId => (row.kind === "header" ? row.bucket : row.pr.bucket);

export function matchesFilter(pr: ClassifiedPR, query: string): boolean {
  const haystack = `${pr.repo}#${pr.number} ${pr.title} @${pr.author}`.toLowerCase();
  return haystack.includes(query.trim().toLowerCase());
}

/** A non-empty `query` hides non-matching PRs and expands every bucket so matches are never folded away. */
export function buildRows(items: readonly ClassifiedPR[], collapsed: ReadonlySet<BucketId>, query = ""): Row[] {
  const filtering = query.trim() !== "";
  const rows: Row[] = [];
  for (const bucket of BUCKET_ORDER) {
    const prs = items.filter((pr) => pr.bucket === bucket && (!filtering || matchesFilter(pr, query)));
    if (prs.length === 0) continue;
    const isCollapsed = !filtering && collapsed.has(bucket);
    rows.push({ kind: "header", bucket, count: prs.length, collapsed: isCollapsed });
    if (!isCollapsed) for (const pr of prs) rows.push({ kind: "pr", pr });
  }
  return rows;
}

export function clampCursor(cursor: number, rowCount: number): number {
  return Math.max(0, Math.min(cursor, rowCount - 1));
}

const firstPRIndex = (rows: readonly Row[]) => Math.max(0, rows.findIndex((r) => r.kind === "pr"));

/** Follows the selected row by key; if it's gone, keeps the index, or goes to the first PR when `index` is null. */
export function restoreCursor(prev: { key: string; index: number | null } | null, rows: readonly Row[]): number {
  if (!prev) return firstPRIndex(rows);
  const found = rows.findIndex((r) => rowKey(r) === prev.key);
  if (found !== -1) return found;
  return prev.index === null ? firstPRIndex(rows) : clampCursor(prev.index, rows.length);
}

/** Index of the next (`dir` 1) or previous (`dir` -1) bucket header, or `cursor` if there is none. */
export function adjacentHeader(rows: readonly Row[], cursor: number, dir: 1 | -1): number {
  for (let i = cursor + dir; i >= 0 && i < rows.length; i += dir) {
    if (rows[i]!.kind === "header") return i;
  }
  return cursor;
}

/** First visible row index such that `cursor` stays inside a window of `height` rows, scrolling as little as possible from `prevStart`. */
export function scrollWindow(cursor: number, rowCount: number, height: number, prevStart: number): number {
  if (height <= 0) return 0;
  let start = Math.min(prevStart, cursor);
  if (cursor >= start + height) start = cursor - height + 1;
  return Math.max(0, Math.min(start, rowCount - height));
}

/** Footer hints for the selected row; `? help` leads so truncation never hides it. */
export function keyHints(row: Row | undefined, job: ReviewJob | undefined, filterActive: boolean): string {
  const tail = filterActive ? ["/ filter", "esc clear", "q quit"] : ["/ filter", "q quit"];
  let middle: string[];
  if (!row) middle = ["r refresh"];
  else if (row.kind === "header") middle = filterActive ? ["[/] bucket", "j/k move"] : ["enter fold", "[/] bucket", "j/k move"];
  else if (job?.status === "queued" || job?.status === "running") middle = ["x cancel", "o open", "i info", "d details"];
  else if (job?.status === "ready") middle = ["d read draft", "p post", "x discard", "o open", "i info"];
  else if (job?.status === "failed") middle = ["a retry", "x clear", "o open", "i info"];
  else middle = ["o open", "a review", "v approve", "d details", "i info", "c checkout"];
  return ["? help", ...middle, ...tail].join("  ");
}
