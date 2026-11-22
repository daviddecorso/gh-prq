import { Box, Text } from "ink";
import React from "react";
import { displayWidth, truncate, wrapAnsiLines } from "../core/format.ts";
import type { ClassifiedPR } from "../core/types.ts";
import { formatDraft, type DraftReview } from "./actions.ts";

const h = React.createElement;

export interface DetailsBody {
  loading: boolean;
  text: string | null;
  error: string | null;
}

export interface DetailsViewProps {
  pr: ClassifiedPR;
  lines: readonly string[];
  width: number;
  height: number;
  scroll: number;
}

/** Wraps the static draft and PR body lines (excluding the animated loading line). */
export function buildDetailsViewLines(draft: DraftReview | null, body: DetailsBody, width: number): string[] {
  const parts: string[] = [];
  if (draft) {
    parts.push(formatDraft(draft).trimEnd());
    parts.push(`\x1b[2m${"═".repeat(Math.max(10, Math.min(60, width)))}\x1b[0m`);
  }
  if (!body.loading) {
    if (body.error) {
      parts.push(`\x1b[31mCouldn't load PR details: ${body.error}\x1b[0m`);
    } else if (body.text) {
      parts.push(body.text.trimEnd());
    }
  }
  return parts.length ? wrapAnsiLines(parts.join("\n\n"), Math.max(20, width)) : [];
}

export function DetailsView({ pr, lines, width, height, scroll }: DetailsViewProps) {
  const contentWidth = Math.max(20, width - 2);
  const contentHeight = Math.max(1, height - 2);
  const maxScroll = Math.max(0, lines.length - contentHeight);
  const offset = Math.max(0, Math.min(scroll, maxScroll));
  const visible = lines.slice(offset, offset + contentHeight);

  const ref = `${pr.repo}#${pr.number}`;
  const posText =
    lines.length <= contentHeight
      ? `${lines.length} lines`
      : `${offset + 1}–${Math.min(lines.length, offset + contentHeight)} / ${lines.length}`;
  const titleBudget = Math.max(10, contentWidth - ref.length - posText.length - 4);
  const titleText = truncate(pr.title, titleBudget);
  const gap = Math.max(1, contentWidth - ref.length - 2 - displayWidth(titleText) - posText.length);

  return h(
    Box,
    { flexDirection: "column", width, height, paddingX: 1, overflowY: "hidden" },
    h(
      Text,
      { wrap: "truncate-end" },
      h(Text, { bold: true, color: "cyan" }, ref),
      `  ${titleText}${" ".repeat(gap)}`,
      h(Text, { dimColor: true }, posText),
    ),
    h(Text, { dimColor: true }, "─".repeat(contentWidth)),
    ...visible.map((line, i) => h(Text, { key: `${offset + i}`, wrap: "truncate-end" }, line || " ")),
  );
}
