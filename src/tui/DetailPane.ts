import { Box, Text } from "ink";
import React from "react";
import { CI_STYLE, relativeTime, truncate } from "../core/format.ts";
import type { FollowUpStatus } from "../core/review/schema.ts";
import { BUCKET_LABELS, type ClassifiedPR } from "../core/types.ts";
import type { Row } from "./model.ts";
import { reviewBadge, TONE_COLOR } from "./QueueList.ts";
import type { ReviewJob } from "./useReviews.ts";

const h = React.createElement;

const SNIPPET_LINES = 4;

interface DetailPaneProps {
  row: Row | undefined;
  width: number;
  height: number;
  now: number;
  job: ReviewJob | undefined;
}

const FOLLOW_UP_GLYPH: Record<FollowUpStatus, { glyph: string; color: string }> = {
  addressed: { glyph: "✓", color: "green" },
  partial: { glyph: "◐", color: "yellow" },
  not_addressed: { glyph: "✗", color: "red" },
};

function reviewSection(job: ReviewJob | undefined, pr: ClassifiedPR, now: number): React.ReactNode {
  const badge = reviewBadge(job, pr, now);
  if (!job || !badge) return null;
  const title = h(Text, { color: badge.color, bold: true }, badge.text);

  if (job.status === "failed") {
    return h(Box, { flexDirection: "column", marginTop: 1 }, title, h(Text, { color: "red", wrap: "truncate-end" }, job.error), h(Text, { dimColor: true }, "a retry · x clear"));
  }
  if (job.status !== "ready" && job.status !== "posting") return h(Box, { marginTop: 1 }, title);

  const { draft } = job;
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(
      Text,
      { wrap: "truncate-end" },
      title,
      h(Text, { dimColor: true }, ` · ${draft.comments.length} inline · suggests ${draft.suggestedVerdict.replace("_", " ")} · p post · x discard`),
    ),
    ...draft.summary
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(0, SNIPPET_LINES)
      .map((line, i) => h(Text, { key: `sum-${i}`, wrap: "truncate-end" }, line)),
    ...draft.threadFollowUps.map((f, i) => {
      const { glyph, color } = FOLLOW_UP_GLYPH[f.status];
      return h(Text, { key: `fu-${i}`, wrap: "truncate-end" }, h(Text, { color }, glyph), ` ${f.path}: ${f.note}`);
    }),
    ...draft.comments.map((c, i) =>
      h(Text, { key: `c-${i}`, wrap: "truncate-end" }, h(Text, { dimColor: true }, `${c.path}:${c.line} `), firstLine(c.body)),
    ),
  );
}

const firstLine = (text: string) => text.split(/\r?\n/, 1)[0]!;

const COMMIT_LINES = 5;
/** Border plus horizontal padding. */
const PANE_CHROME_WIDTH = 4;

/** Newest first; commits up to the viewer's last-reviewed one are dimmed and later ones get a yellow oid. */
function commitsSection(pr: ClassifiedPR, width: number, now: number): React.ReactNode {
  if (!pr.commits.length) return null;
  const reviewedIdx = pr.lastReviewedCommitOid ? pr.commits.findIndex((c) => c.oid === pr.lastReviewedCommitOid) : -1;
  const recent = pr.commits
    .map((c, i) => ({ c, reviewed: reviewedIdx >= 0 && i <= reviewedIdx, isNew: reviewedIdx >= 0 && i > reviewedIdx }))
    .slice(-COMMIT_LINES)
    .reverse();
  const inner = width - PANE_CHROME_WIDTH;

  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(Text, { dimColor: true }, `Commits (${pr.commitCount})`),
    ...recent.map(({ c, reviewed, isNew }) => {
      const oid = c.oid.slice(0, 7);
      const age = ` · ${relativeTime(c.committedAt, now)}`;
      const headline = truncate(c.headline, Math.max(inner - oid.length - 1 - age.length, 8));
      return h(
        Text,
        { key: c.oid, dimColor: reviewed, wrap: "truncate-end" },
        h(Text, { color: isNew ? "yellow" : undefined, dimColor: !isNew }, oid),
        ` ${headline}`,
        h(Text, { dimColor: true }, age),
      );
    }),
  );
}

export function DetailPane({ row, width, height, now, job }: DetailPaneProps) {
  const frame = (...children: React.ReactNode[]) =>
    h(
      Box,
      { flexDirection: "column", width, height, borderStyle: "single", borderColor: "gray", paddingX: 1, overflow: "hidden" },
      ...children,
    );

  if (!row) return frame(h(Text, { dimColor: true }, "Nothing selected"));
  if (row.kind === "header") {
    return frame(
      h(Text, { bold: true }, BUCKET_LABELS[row.bucket]),
      h(Text, { dimColor: true }, `${row.count} PR${row.count === 1 ? "" : "s"} · space to ${row.collapsed ? "expand" : "collapse"}`),
    );
  }

  const { pr } = row;
  const ci = CI_STYLE[pr.ciState];
  const snippet = pr.latestReplySnippet;
  const shortOid = (oid: string) => oid.slice(0, 7);

  return frame(
    h(Text, { wrap: "truncate-end" }, h(Text, { bold: true }, `${pr.repo}#${pr.number}`), `  ${pr.title}`),
    h(Text, { dimColor: true, wrap: "truncate-end" }, pr.url),
    h(
      Text,
      { wrap: "truncate-end" },
      `@${pr.author} · ${BUCKET_LABELS[pr.bucket]} · ${relativeTime(pr.actionSince, now)} · +${pr.additions}/-${pr.deletions}`,
    ),
    h(Text, null, " "),
    ...pr.allReasons.map((r, i) => h(Text, { key: `reason-${i}`, wrap: "truncate-end" }, `• ${r}`)),
    h(
      Text,
      { wrap: "truncate-end" },
      "CI ",
      h(Text, { color: TONE_COLOR[ci.tone], dimColor: ci.tone === "dim" }, `${ci.glyph} ${pr.ciState.toLowerCase()}`),
      pr.failedChecks.length ? h(Text, { color: "red" }, `  ${pr.failedChecks.join(", ")}`) : null,
    ),
    pr.lastReviewedCommitOid && pr.lastReviewedCommitOid !== pr.headOid
      ? h(Text, { dimColor: true, wrap: "truncate-end" }, `You reviewed ${shortOid(pr.lastReviewedCommitOid)}, head is ${shortOid(pr.headOid)}`)
      : null,
    pr.badges.length ? h(Text, { color: "cyan", wrap: "truncate-end" }, pr.badges.map((b) => `[${b}]`).join(" ")) : null,
    reviewSection(job, pr, now),
    snippet
      ? h(
          Box,
          { flexDirection: "column", marginTop: 1 },
          h(
            Text,
            { dimColor: true, wrap: "truncate-end" },
            `@${snippet.author}${snippet.path ? ` on ${snippet.path}` : ""} · ${relativeTime(snippet.createdAt, now)}`,
          ),
          ...snippet.body
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .slice(0, SNIPPET_LINES)
            .map((line, i) => h(Text, { key: `snip-${i}`, wrap: "truncate-end" }, truncate(line, 200))),
        )
      : null,
    commitsSection(pr, width, now),
  );
}
