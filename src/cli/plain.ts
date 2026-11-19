import {
  ACTIONABLE_BUCKETS,
  BUCKET_LABELS,
  BUCKET_ORDER,
  WAITING_BUCKETS,
  type ClassifiedPR,
  type CiState,
  type QueueResult,
} from "../core/types.ts";
import { CI_STYLE, padEndDisplay, relativeTime, truncate } from "../core/format.ts";

const TITLE_WIDTH = 50;

function makePaint(color: boolean) {
  const wrap = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { bold: wrap(1), dim: wrap(2), red: wrap(31), green: wrap(32), yellow: wrap(33), cyan: wrap(36) };
}

export function renderPlain(result: QueueResult, opts: { color: boolean; now?: number }): string {
  const now = opts.now ?? Date.now();
  const paint = makePaint(opts.color);
  const { items } = result;

  const ciGlyph = (state: CiState) => {
    const { glyph, tone } = CI_STYLE[state];
    return paint[tone](glyph);
  };

  const actionable = items.filter((i) => ACTIONABLE_BUCKETS.has(i.bucket)).length;
  const waiting = items.filter((i) => WAITING_BUCKETS.has(i.bucket)).length;
  const lines = [
    `${paint.bold("gh-prq")}  ${paint.dim(
      `(${actionable} actionable · ${waiting} waiting · updated ${relativeTime(result.fetchedAt, now)} ago)`,
    )}`,
  ];
  if (result.staleReason) lines.push(paint.yellow(`⚠ Offline / stale cache: ${result.staleReason}`));

  if (items.length === 0) {
    lines.push("", "Nothing in your queue.");
    return lines.join("\n");
  }

  const ref = (pr: ClassifiedPR) => `${pr.repo}#${pr.number}`;
  const diff = (pr: ClassifiedPR) => `+${pr.additions}/-${pr.deletions}`;
  const refWidth = Math.max(...items.map((pr) => ref(pr).length));
  const diffWidth = Math.max(...items.map((pr) => diff(pr).length));

  for (const bucket of BUCKET_ORDER) {
    const rows = items.filter((i) => i.bucket === bucket);
    if (rows.length === 0) continue;
    lines.push("", paint.bold(`${BUCKET_LABELS[bucket].toUpperCase()} (${rows.length})`));
    for (const pr of rows) {
      const badges = pr.badges.map((b) => paint.cyan(` [${b}]`)).join("");
      lines.push(
        [
          " ",
          ref(pr).padEnd(refWidth),
          padEndDisplay(truncate(pr.title, TITLE_WIDTH), TITLE_WIDTH),
          paint.dim(diff(pr).padEnd(diffWidth)),
          ciGlyph(pr.ciState),
          `${pr.reason} ${paint.dim(`· ${relativeTime(pr.actionSince, now)}`)}${badges}`,
        ].join("  "),
      );
    }
  }

  return lines.join("\n");
}
