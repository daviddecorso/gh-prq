import { Box, Text } from "ink";
import React from "react";
import { CI_STYLE, relativeTime, stripControlChars, truncate } from "../core/format.ts";
import type { FollowUpStatus } from "../core/review/schema.ts";
import { BUCKET_LABELS, type ClassifiedPR } from "../core/types.ts";
import type { Row } from "./model.ts";
import { reviewBadge, TONE_COLOR } from "./QueueList.ts";
import type { ReviewJob } from "./useReviews.ts";

const h = React.createElement;

const SNIPPET_LINES = 4;
const COMMIT_LINES = 5;
/** Border plus horizontal padding. */
const PANE_CHROME_WIDTH = 4;
/** Top and bottom border rows. */
const PANE_CHROME_HEIGHT = 2;

interface DetailPaneProps {
  row: Row | undefined;
  width: number;
  height: number;
  now: number;
  job: ReviewJob | undefined;
  scroll?: number;
  spinner?: string;
}

const FOLLOW_UP_GLYPH: Record<FollowUpStatus, { glyph: string; color: string }> = {
  addressed: { glyph: "✓", color: "green" },
  partial: { glyph: "◐", color: "yellow" },
  not_addressed: { glyph: "✗", color: "red" },
};

const firstLine = (text: string) => stripControlChars(text).split("\n", 1)[0]!.replace(/\t/g, " ");

function reviewLines(job: ReviewJob | undefined, pr: ClassifiedPR, now: number, spinner: string): React.ReactNode[] {
  const badge = reviewBadge(job, pr, now, spinner);
  if (!job || !badge) return [];
  const title = h(Text, { color: badge.color, bold: true }, badge.text);

  if (job.status === "failed") {
    return [
      h(Text, { key: "rev-sp" }, " "),
      h(Text, { key: "rev-t", wrap: "truncate-end" }, title),
      h(Text, { key: "rev-err", color: "red", wrap: "truncate-end" }, firstLine(job.error)),
      h(Text, { key: "rev-h", dimColor: true, wrap: "truncate-end" }, "a retry · x clear"),
    ];
  }
  if (job.status !== "ready" && job.status !== "posting") {
    return [h(Text, { key: "rev-sp" }, " "), h(Text, { key: "rev-t", wrap: "truncate-end" }, title)];
  }

  const { draft } = job;
  const lines: React.ReactNode[] = [
    h(Text, { key: "rev-sp" }, " "),
    h(
      Text,
      { key: "rev-hdr", wrap: "truncate-end" },
      title,
      h(Text, { dimColor: true }, ` · ${job.agent.id} · ${draft.comments.length} inline · suggests ${draft.suggestedVerdict.replace("_", " ")} · p post · x discard`),
    ),
    ...stripControlChars(draft.summary)
      .split("\n")
      .filter((line) => line.trim())
      .slice(0, SNIPPET_LINES)
      .map((line, i) => h(Text, { key: `sum-${i}`, wrap: "truncate-end" }, line.replace(/\t/g, " "))),
    ...draft.threadFollowUps.map((f, i) => {
      const { glyph, color } = FOLLOW_UP_GLYPH[f.status];
      return h(Text, { key: `fu-${i}`, wrap: "truncate-end" }, h(Text, { color }, glyph), ` ${firstLine(f.path)}: ${firstLine(f.note)}`);
    }),
    ...draft.comments.map((c, i) =>
      h(Text, { key: `c-${i}`, wrap: "truncate-end" }, h(Text, { dimColor: true }, `${firstLine(c.path)}:${c.line} `), firstLine(c.body)),
    ),
  ];
  return lines;
}

/** Newest first; commits up to the viewer's last-reviewed one are dimmed and later ones get a yellow oid. */
function commitLines(pr: ClassifiedPR, width: number, now: number): React.ReactNode[] {
  if (!pr.commits.length) return [];
  const reviewedIdx = pr.lastReviewedCommitOid ? pr.commits.findIndex((c) => c.oid === pr.lastReviewedCommitOid) : -1;
  const recent = pr.commits
    .map((c, i) => ({ c, reviewed: reviewedIdx >= 0 && i <= reviewedIdx, isNew: reviewedIdx >= 0 && i > reviewedIdx }))
    .slice(-COMMIT_LINES)
    .reverse();
  const inner = Math.max(20, width - PANE_CHROME_WIDTH);

  return [
    h(Text, { key: "c-sp" }, " "),
    h(Text, { key: "c-hdr", dimColor: true, wrap: "truncate-end" }, `Commits (${pr.commitCount})`),
    ...recent.map(({ c, reviewed, isNew }) => {
      const oid = c.oid.slice(0, 7);
      const age = ` · ${relativeTime(c.committedAt, now)}`;
      const headline = truncate(c.headline, Math.max(inner - oid.length - 1 - age.length, 8));
      return h(
        Text,
        { key: `cm-${c.oid}`, dimColor: reviewed, wrap: "truncate-end" },
        h(Text, { color: isNew ? "yellow" : undefined, dimColor: !isNew }, oid),
        ` ${headline}`,
        h(Text, { dimColor: true }, age),
      );
    }),
  ];
}

export function buildDetailLines(
  row: Row | undefined,
  width: number,
  now: number,
  job: ReviewJob | undefined,
  spinner = "◐",
): React.ReactNode[] {
  if (!row) return [h(Text, { key: "empty", dimColor: true }, "Nothing selected")];
  if (row.kind === "header") {
    return [
      h(Text, { key: "bh", bold: true, wrap: "truncate-end" }, BUCKET_LABELS[row.bucket]),
      h(
        Text,
        { key: "bc", dimColor: true, wrap: "truncate-end" },
        `${row.count} PR${row.count === 1 ? "" : "s"} · space to ${row.collapsed ? "expand" : "collapse"}`,
      ),
    ];
  }

  const { pr } = row;
  const ci = CI_STYLE[pr.ciState];
  const snippet = pr.latestReplySnippet;
  const shortOid = (oid: string) => oid.slice(0, 7);

  const lines: React.ReactNode[] = [
    h(Text, { key: "title", wrap: "truncate-end" }, h(Text, { bold: true }, `${pr.repo}#${pr.number}`), `  ${pr.title}`),
    h(
      Text,
      { key: "meta", dimColor: true, wrap: "truncate-end" },
      `@${pr.author} · ${BUCKET_LABELS[pr.bucket]} · ${relativeTime(pr.actionSince, now)} · +${pr.additions}/-${pr.deletions}`,
    ),
    ...pr.allReasons.map((r, i) => h(Text, { key: `reason-${i}`, wrap: "truncate-end" }, `• ${r}`)),
    h(
      Text,
      { key: "ci", wrap: "truncate-end" },
      "CI ",
      h(Text, { color: TONE_COLOR[ci.tone], dimColor: ci.tone === "dim" }, `${ci.glyph} ${pr.ciState.toLowerCase()}`),
      pr.failedChecks.length ? h(Text, { color: "red" }, `  ${pr.failedChecks.join(", ")}`) : null,
      pr.badges.length ? h(Text, { color: "cyan" }, `  ${pr.badges.map((b) => `[${b}]`).join(" ")}`) : null,
    ),
  ];

  if (pr.lastReviewedCommitOid && pr.lastReviewedCommitOid !== pr.headOid) {
    lines.push(
      h(
        Text,
        { key: "rev-oid", dimColor: true, wrap: "truncate-end" },
        `You reviewed ${shortOid(pr.lastReviewedCommitOid)}, head is ${shortOid(pr.headOid)}`,
      ),
    );
  }

  lines.push(...reviewLines(job, pr, now, spinner));

  if (snippet) {
    lines.push(
      h(Text, { key: "sn-sp" }, " "),
      h(
        Text,
        { key: "sn-hdr", dimColor: true, wrap: "truncate-end" },
        `@${snippet.author}${snippet.path ? ` on ${snippet.path}` : ""} · ${relativeTime(snippet.createdAt, now)}`,
      ),
      ...stripControlChars(snippet.body)
        .split("\n")
        .filter((line) => line.trim())
        .slice(0, SNIPPET_LINES)
        .map((line, i) => h(Text, { key: `snip-${i}`, wrap: "truncate-end" }, truncate(line.replace(/\t/g, " "), 200))),
    );
  }

  lines.push(...commitLines(pr, width, now));
  lines.push(h(Text, { key: "url-sp" }, " "), h(Text, { key: "url", dimColor: true, wrap: "truncate-end" }, pr.url));
  return lines;
}

export function maxDetailScroll(lineCount: number, height: number): number {
  const innerHeight = Math.max(1, height - PANE_CHROME_HEIGHT);
  if (lineCount <= innerHeight) return 0;
  // Reserve 1 line for the overflow indicator when content exceeds the pane height.
  const visible = Math.max(1, innerHeight - 1);
  return Math.max(0, lineCount - visible);
}

export function DetailPane({ row, width, height, now, job, scroll = 0, spinner = "◐" }: DetailPaneProps) {
  const lines = buildDetailLines(row, width, now, job, spinner);
  const innerHeight = Math.max(1, height - PANE_CHROME_HEIGHT);
  const overflows = lines.length > innerHeight;
  const visibleCount = overflows ? Math.max(1, innerHeight - 1) : innerHeight;
  const maxScroll = Math.max(0, lines.length - visibleCount);
  const offset = Math.max(0, Math.min(scroll, maxScroll));
  const slice = lines.slice(offset, offset + visibleCount);

  const below = Math.max(0, lines.length - (offset + visibleCount));
  const scrollHint = overflows
    ? [
        offset > 0 ? `↑ ${offset}` : null,
        below > 0 ? `↓ ${below} more` : null,
        "J/K scroll · d full",
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  return h(
    Box,
    { flexDirection: "column", width, height, borderStyle: "single", borderColor: "gray", paddingX: 1, overflow: "hidden" },
    ...slice,
    scrollHint ? h(Text, { key: "scroll-hint", dimColor: true, wrap: "truncate-end" }, scrollHint) : null,
  );
}
