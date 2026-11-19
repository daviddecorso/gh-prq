import { Box, Text } from "ink";
import React from "react";
import { CI_STYLE, padEndDisplay, relativeTime, truncate, type Tone } from "../core/format.ts";
import { BUCKET_LABELS, type ClassifiedPR } from "../core/types.ts";
import { rowKey, type Row } from "./model.ts";
import type { ReviewJob } from "./useReviews.ts";

const h = React.createElement;

export const TONE_COLOR: Record<Tone, string | undefined> = { green: "green", yellow: "yellow", red: "red", dim: undefined };

interface QueueListProps {
  rows: readonly Row[];
  cursor: number;
  start: number;
  height: number;
  width: number;
  now: number;
  jobs: ReadonlyMap<string, ReviewJob>;
}

const ref = (pr: ClassifiedPR) => `${pr.repo}#${pr.number}`;
const diff = (pr: ClassifiedPR) => `+${pr.additions}/-${pr.deletions}`;

export function reviewBadge(job: ReviewJob | undefined, pr: ClassifiedPR, now: number): { text: string; color: string } | null {
  switch (job?.status) {
    case undefined:
      return null;
    case "queued":
      return { text: "◌ claude queued", color: "gray" };
    case "running":
      return { text: `◐ claude ${relativeTime(new Date(job.startedAt).toISOString(), now)}`, color: "magenta" };
    case "failed":
      return { text: "✗ claude", color: "red" };
    case "posting":
      return { text: "✎ posting…", color: "magenta" };
    case "ready":
      return job.headOid === pr.headOid ? { text: "✎ draft", color: "magenta" } : { text: "✎ draft (stale)", color: "yellow" };
  }
}

export function QueueList({ rows, cursor, start, height, width, now, jobs }: QueueListProps) {
  const prs = rows.flatMap((r) => (r.kind === "pr" ? [r.pr] : []));
  const refWidth = Math.max(0, ...prs.map((pr) => ref(pr).length));
  const diffWidth = Math.max(0, ...prs.map((pr) => diff(pr).length));
  const titleWidth = Math.max(20, Math.min(50, width - refWidth - diffWidth - 40));

  return h(
    Box,
    { flexDirection: "column", width, height },
    rows.slice(start, start + height).map((row, i) => {
      const selected = start + i === cursor;
      const pointer = h(Text, { color: "cyan" }, selected ? "›" : " ");

      if (row.kind === "header") {
        return h(
          Text,
          { key: rowKey(row), wrap: "truncate-end", inverse: selected, bold: true },
          `${row.collapsed ? "▸" : "▾"} ${BUCKET_LABELS[row.bucket].toUpperCase()} (${row.count})`,
        );
      }

      const { pr } = row;
      const ci = CI_STYLE[pr.ciState];
      const badge = reviewBadge(jobs.get(pr.id), pr, now);
      return h(
        Text,
        { key: rowKey(row), wrap: "truncate-end" },
        pointer,
        " ",
        h(Text, { bold: selected }, ref(pr).padEnd(refWidth)),
        "  ",
        h(Text, { bold: selected }, padEndDisplay(truncate(pr.title, titleWidth), titleWidth)),
        "  ",
        h(Text, { dimColor: true }, diff(pr).padEnd(diffWidth)),
        "  ",
        h(Text, { color: TONE_COLOR[ci.tone], dimColor: ci.tone === "dim" }, ci.glyph),
        "  ",
        badge ? h(Text, { color: badge.color }, `${badge.text}  `) : null,
        pr.reason,
        h(Text, { dimColor: true }, ` · ${relativeTime(pr.actionSince, now)}`),
        ...pr.badges.map((b) => h(Text, { key: b, color: "cyan" }, ` [${b}]`)),
      );
    }),
  );
}
