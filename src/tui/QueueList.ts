import { Box, Text } from "ink";
import React from "react";
import { CI_STYLE, relativeTime, truncate, type Tone } from "../core/format.ts";
import { BUCKET_LABELS, type ClassifiedPR } from "../core/types.ts";
import { rowKey, type Row } from "./model.ts";

const h = React.createElement;

export const TONE_COLOR: Record<Tone, string | undefined> = { green: "green", yellow: "yellow", red: "red", dim: undefined };

interface QueueListProps {
  rows: readonly Row[];
  cursor: number;
  start: number;
  height: number;
  width: number;
  now: number;
}

const ref = (pr: ClassifiedPR) => `${pr.repo}#${pr.number}`;
const diff = (pr: ClassifiedPR) => `+${pr.additions}/-${pr.deletions}`;

export function QueueList({ rows, cursor, start, height, width, now }: QueueListProps) {
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
      return h(
        Text,
        { key: rowKey(row), wrap: "truncate-end" },
        pointer,
        " ",
        h(Text, { bold: selected }, ref(pr).padEnd(refWidth)),
        "  ",
        h(Text, { bold: selected }, truncate(pr.title, titleWidth).padEnd(titleWidth)),
        "  ",
        h(Text, { dimColor: true }, diff(pr).padEnd(diffWidth)),
        "  ",
        h(Text, { color: TONE_COLOR[ci.tone], dimColor: ci.tone === "dim" }, ci.glyph),
        "  ",
        pr.reason,
        h(Text, { dimColor: true }, ` · ${relativeTime(pr.actionSince, now)}`),
        ...pr.badges.map((b) => h(Text, { key: b, color: "cyan" }, ` [${b}]`)),
      );
    }),
  );
}
