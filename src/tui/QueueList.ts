import { Box, Text } from "ink";
import React from "react";
import { BUCKET_TONE, CI_STYLE, padEndDisplay, relativeTime, type Tone, truncate } from "../core/format.ts";
import { BUCKET_LABELS, type ClassifiedPR } from "../core/types.ts";
import { type Row, rowKey } from "./model.ts";
import type { ReviewJob } from "./useReviews.ts";

const h = React.createElement;

export const TONE_COLOR: Record<Tone, string | undefined> = {
  green: "green",
  yellow: "yellow",
  red: "red",
  cyan: "cyan",
  dim: undefined,
};

const SHOW_DIFF_MIN_WIDTH = 82;
const SHOW_AUTHOR_MIN_WIDTH = 95;
const MAX_AUTHOR_WIDTH = 16;

interface QueueListProps {
  rows: readonly Row[];
  cursor: number;
  start: number;
  height: number;
  width: number;
  now: number;
  jobs: ReadonlyMap<string, ReviewJob>;
  viewer?: string;
  approving?: ReadonlySet<string>;
  spinner?: string;
}

const ref = (pr: ClassifiedPR) => `${pr.repo}#${pr.number}`;
const diff = (pr: ClassifiedPR) => `+${pr.additions}/-${pr.deletions}`;

export function reviewBadge(
  job: ReviewJob | undefined,
  pr: ClassifiedPR,
  now: number,
  spinner = "◐",
): { text: string; color: string } | null {
  switch (job?.status) {
    case undefined:
      return null;
    case "queued":
      return { text: `◌ ${job.agent.id} queued`, color: "gray" };
    case "running":
      return { text: `${spinner} ${job.agent.id} ${relativeTime(new Date(job.startedAt).toISOString(), now)}`, color: "magenta" };
    case "failed":
      return { text: `✗ ${job.agent.id}`, color: "red" };
    case "posting":
      return { text: "✎ posting…", color: "magenta" };
    case "ready":
      return job.headOid === pr.headOid ? { text: "✎ draft", color: "magenta" } : { text: "✎ draft (stale)", color: "yellow" };
  }
}

export function QueueList({ rows, cursor, start, height, width, now, jobs, viewer, approving, spinner = "◐" }: QueueListProps) {
  const prs = rows.flatMap((r) => (r.kind === "pr" ? [r.pr] : []));
  const refWidth = Math.max(0, ...prs.map((pr) => ref(pr).length));
  const showDiff = width >= SHOW_DIFF_MIN_WIDTH;
  const diffWidth = showDiff ? Math.max(0, ...prs.map((pr) => diff(pr).length)) : 0;
  const showAuthor = width >= SHOW_AUTHOR_MIN_WIDTH && prs.some((pr) => pr.author !== viewer);
  const authorWidth = showAuthor
    ? Math.min(MAX_AUTHOR_WIDTH, Math.max(0, ...prs.map((pr) => (pr.author === viewer ? 0 : pr.author.length + 1))))
    : 0;
  const fixedWidth = 2 + refWidth + 2 + (showAuthor ? authorWidth + 2 : 0) + (showDiff ? diffWidth + 2 : 0) + 5;
  const titleWidth = Math.max(18, Math.min(64, width - fixedWidth - 32));

  return h(
    Box,
    { flexDirection: "column", width, height },
    rows.slice(start, start + height).map((row, i) => {
      const selected = start + i === cursor;
      const pointer = h(Text, { color: "cyan" }, selected ? "›" : " ");

      if (row.kind === "header") {
        const tone = BUCKET_TONE[row.bucket];
        return h(
          Text,
          {
            key: rowKey(row),
            wrap: "truncate-end",
            inverse: selected,
            bold: true,
            color: TONE_COLOR[tone],
            dimColor: tone === "dim" && !selected,
          },
          `${row.collapsed ? "▸" : "▾"} ${BUCKET_LABELS[row.bucket].toUpperCase()} (${row.count})`,
        );
      }

      const { pr } = row;
      const ci = CI_STYLE[pr.ciState];
      const isApproving = approving?.has(pr.id) ?? false;
      const badge = isApproving ? { text: `${spinner} approving…`, color: "green" } : reviewBadge(jobs.get(pr.id), pr, now, spinner);
      const authorLabel = pr.author === viewer ? "" : `@${pr.author}`;
      return h(
        Text,
        { key: rowKey(row), wrap: "truncate-end", inverse: selected },
        pointer,
        " ",
        h(Text, { bold: selected }, ref(pr).padEnd(refWidth)),
        "  ",
        h(Text, { bold: selected }, padEndDisplay(truncate(pr.title, titleWidth), titleWidth)),
        "  ",
        showAuthor ? h(Text, { dimColor: true }, `${padEndDisplay(truncate(authorLabel, authorWidth), authorWidth)}  `) : null,
        showDiff ? h(Text, { dimColor: true }, `${diff(pr).padEnd(diffWidth)}  `) : null,
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
