import { Box, Text } from "ink";
import React from "react";
import { CI_STYLE, relativeTime, truncate } from "../core/format.ts";
import { BUCKET_LABELS } from "../core/types.ts";
import type { Row } from "./model.ts";
import { TONE_COLOR } from "./QueueList.ts";

const h = React.createElement;

const SNIPPET_LINES = 4;

interface DetailPaneProps {
  row: Row | undefined;
  width: number;
  height: number;
  now: number;
}

export function DetailPane({ row, width, height, now }: DetailPaneProps) {
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
  );
}
