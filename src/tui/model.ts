import { BUCKET_ORDER, type BucketId, type ClassifiedPR } from "../core/types.ts";

export type Row =
  | { kind: "header"; bucket: BucketId; count: number; collapsed: boolean }
  | { kind: "pr"; pr: ClassifiedPR };

export const rowKey = (row: Row): string => (row.kind === "header" ? `h:${row.bucket}` : `pr:${row.pr.id}`);

export const bucketOfRow = (row: Row): BucketId => (row.kind === "header" ? row.bucket : row.pr.bucket);

export function buildRows(items: readonly ClassifiedPR[], collapsed: ReadonlySet<BucketId>): Row[] {
  const rows: Row[] = [];
  for (const bucket of BUCKET_ORDER) {
    const prs = items.filter((pr) => pr.bucket === bucket);
    if (prs.length === 0) continue;
    const isCollapsed = collapsed.has(bucket);
    rows.push({ kind: "header", bucket, count: prs.length, collapsed: isCollapsed });
    if (!isCollapsed) for (const pr of prs) rows.push({ kind: "pr", pr });
  }
  return rows;
}

export function clampCursor(cursor: number, rowCount: number): number {
  return Math.max(0, Math.min(cursor, rowCount - 1));
}

/** Follows the previously selected row after a refresh; if it's gone, stays at the same index. */
export function restoreCursor(prev: { key: string; index: number } | null, rows: readonly Row[]): number {
  if (!prev) return 0;
  const found = rows.findIndex((r) => rowKey(r) === prev.key);
  return found !== -1 ? found : clampCursor(prev.index, rows.length);
}

/** First visible row index such that `cursor` stays inside a window of `height` rows, scrolling as little as possible from `prevStart`. */
export function scrollWindow(cursor: number, rowCount: number, height: number, prevStart: number): number {
  if (height <= 0) return 0;
  let start = Math.min(prevStart, cursor);
  if (cursor >= start + height) start = cursor - height + 1;
  return Math.max(0, Math.min(start, rowCount - height));
}
