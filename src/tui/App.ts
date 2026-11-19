import { Box, Text, useApp, useInput, useStdout } from "ink";
import React from "react";
import { relativeTime } from "../core/format.ts";
import { ACTIONABLE_BUCKETS, WAITING_BUCKETS, type BucketId, type ClassifiedPR, type QueueResult } from "../core/types.ts";
import type { Actions } from "./actions.ts";
import { DetailPane } from "./DetailPane.ts";
import { bucketOfRow, buildRows, clampCursor, restoreCursor, rowKey, scrollWindow } from "./model.ts";
import { QueueList } from "./QueueList.ts";
import { useQueue, type QueueLoader } from "./useQueue.ts";

const h = React.createElement;

const SIDE_DETAIL_MIN_COLUMNS = 120;
const BOTTOM_DETAIL_HEIGHT = 12;
/** Header, footer rule, footer text, and one spare line so Ink never renders taller than the terminal. */
const CHROME_LINES = 4;
const STATUS_MS = 3000;
const CLOCK_MS = 30_000;
const MAX_WARNINGS = 2;
const NO_ITEMS: ClassifiedPR[] = [];

const firstLine = (text: string) => text.split(/\r?\n/, 1)[0]!;

const KEY_HINTS = "j/k move  space fold  o open  c checkout  y copy  d details  r refresh  ? help  q quit";

const HELP_LINES: [string, string][] = [
  ["j / k / ↓ / ↑", "move"],
  ["g / G", "top / bottom"],
  ["space / tab", "fold or unfold the bucket"],
  ["enter / o", "open in browser"],
  ["c", "check out (exits)"],
  ["y", "copy URL"],
  ["d", "toggle details"],
  ["r", "refresh"],
  ["q / esc", "quit"],
];

export interface AppProps {
  load: QueueLoader;
  initial?: QueueResult | null;
  actions: Actions;
  collapseWaitingByDefault: boolean;
  autoRefreshSeconds: number;
  onCheckout: (pr: ClassifiedPR) => void;
}

function useTerminalSize() {
  const { stdout } = useStdout();
  const read = () => ({ columns: stdout.columns || 100, rows: stdout.rows || 24 });
  const [size, setSize] = React.useState(read);
  React.useEffect(() => {
    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout]);
  return size;
}

function useNow() {
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function useStatus() {
  const [status, setStatus] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);
  return [status, setStatus] as const;
}

export function App({ load, initial, actions, collapseWaitingByDefault, autoRefreshSeconds, onCheckout }: AppProps) {
  const { exit } = useApp();
  const { columns, rows: termRows } = useTerminalSize();
  const now = useNow();
  const queue = useQueue(load, autoRefreshSeconds, initial);
  const [status, setStatus] = useStatus();

  const [collapsed, setCollapsed] = React.useState<ReadonlySet<BucketId>>(
    () => new Set(collapseWaitingByDefault ? WAITING_BUCKETS : []),
  );
  // Selection is tracked by row key so it follows the same PR when a refresh reorders rows.
  const [selection, setSelection] = React.useState<{ key: string; index: number } | null>(null);
  const [scrollStart, setScrollStart] = React.useState(0);
  const [showDetail, setShowDetail] = React.useState(false);
  const [showHelp, setShowHelp] = React.useState(false);

  const items = queue.result?.items ?? NO_ITEMS;
  const rows = React.useMemo(() => buildRows(items, collapsed), [items, collapsed]);
  const cursor = restoreCursor(selection, rows);
  const current = rows[cursor];

  const select = (index: number) => {
    const next = clampCursor(index, rows.length);
    const row = rows[next];
    if (row) setSelection({ key: rowKey(row), index: next });
  };

  const sideDetail = showDetail && columns >= SIDE_DETAIL_MIN_COLUMNS;
  const showBottomDetail = showDetail && !sideDetail && Boolean(queue.result) && !showHelp;
  const warnings = queue.result?.warnings ?? [];
  const bannerLines =
    (queue.result?.staleReason ? 1 : 0) + Math.min(warnings.length, MAX_WARNINGS + 1) + (queue.error ? 1 : 0);
  const listHeight = Math.max(
    3,
    termRows - CHROME_LINES - bannerLines - (showBottomDetail ? BOTTOM_DETAIL_HEIGHT : 0),
  );
  const listWidth = sideDetail ? Math.floor(columns * 0.58) : columns;

  const start = scrollWindow(cursor, rows.length, listHeight, scrollStart);
  React.useEffect(() => setScrollStart(start), [start]);

  const toggleFold = () => {
    if (!current) return;
    const bucket = bucketOfRow(current);
    const next = new Set(collapsed);
    if (next.has(bucket)) next.delete(bucket);
    else next.add(bucket);
    setSelection({ key: `h:${bucket}`, index: cursor });
    setCollapsed(next);
  };

  const withPR = (fn: (pr: ClassifiedPR) => void) => {
    if (current?.kind === "pr") fn(current.pr);
    else setStatus("Select a PR first");
  };

  useInput((input, key) => {
    if (showHelp) {
      setShowHelp(false);
      return;
    }
    if (input === "q" || key.escape) return exit();
    if (key.downArrow) return select(cursor + 1);
    if (key.upArrow) return select(cursor - 1);
    // Ink hands over key-repeat bursts as one string ("jjjk"), so net them out.
    if (/^[jk]+$/.test(input)) {
      const moves = [...input].reduce((n, ch) => n + (ch === "j" ? 1 : -1), 0);
      return select(cursor + moves);
    }
    if (input === "g") return select(0);
    if (input === "G") return select(rows.length - 1);
    if (input === " " || key.tab) return toggleFold();
    if (input === "d") return setShowDetail((v) => !v);
    if (input === "?") return setShowHelp(true);
    if (input === "r") return queue.refresh();
    if (input === "o" || key.return) return withPR((pr) => setStatus(actions.open(pr)));
    if (input === "y") return withPR((pr) => setStatus(actions.copy(pr)));
    if (input === "c") {
      return withPR((pr) => {
        const blocker = actions.checkoutBlocker(pr);
        if (blocker) return setStatus(blocker);
        onCheckout(pr);
        exit();
      });
    }
  });

  const result = queue.result;
  const actionable = items.filter((i) => ACTIONABLE_BUCKETS.has(i.bucket)).length;
  const waiting = items.filter((i) => WAITING_BUCKETS.has(i.bucket)).length;

  const header = h(
    Text,
    { wrap: "truncate-end" },
    h(Text, { bold: true }, "gh-prq"),
    "  ",
    result
      ? h(
          Text,
          { dimColor: true },
          `${actionable} actionable · ${waiting} waiting · updated ${relativeTime(result.fetchedAt, now)} ago`,
        )
      : null,
    queue.refreshing ? h(Text, { color: "yellow" }, "  refreshing…") : null,
  );

  const banners = [
    result?.staleReason ? h(Text, { key: "stale", color: "yellow", wrap: "truncate-end" }, `⚠ Offline / stale cache: ${firstLine(result.staleReason)}`) : null,
    ...warnings
      .slice(0, MAX_WARNINGS)
      .map((w, i) => h(Text, { key: `warn-${i}`, color: "yellow", wrap: "truncate-end" }, `⚠ ${firstLine(w)}`)),
    warnings.length > MAX_WARNINGS
      ? h(Text, { key: "warn-more", color: "yellow" }, `⚠ +${warnings.length - MAX_WARNINGS} more warnings`)
      : null,
    queue.error ? h(Text, { key: "error", color: "red", wrap: "truncate-end" }, `✗ ${firstLine(queue.error)}`) : null,
  ];

  let body: React.ReactNode;
  if (showHelp) {
    body = h(
      Box,
      { flexDirection: "column", height: listHeight, paddingX: 2 },
      ...HELP_LINES.map(([keys, what]) => h(Text, { key: keys }, h(Text, { color: "cyan" }, keys.padEnd(16)), what)),
      h(Text, { dimColor: true }, "\nany key to close"),
    );
  } else if (queue.loading) {
    body = h(Box, { height: listHeight }, h(Text, { dimColor: true }, "Loading your queue…"));
  } else if (!result) {
    body = h(Box, { height: listHeight }, h(Text, { dimColor: true }, "Couldn't load the queue. r to retry, q to quit."));
  } else if (rows.length === 0) {
    body = h(Box, { height: listHeight }, h(Text, null, "Nothing in your queue."));
  } else {
    const list = h(QueueList, { rows, cursor, start, height: listHeight, width: listWidth, now });
    body = sideDetail
      ? h(Box, null, list, h(DetailPane, { row: current, width: columns - listWidth, height: listHeight, now }))
      : list;
  }

  return h(
    Box,
    { flexDirection: "column", width: columns },
    header,
    ...banners,
    body,
    showBottomDetail ? h(DetailPane, { row: current, width: columns, height: BOTTOM_DETAIL_HEIGHT, now }) : null,
    h(Text, { dimColor: true }, "─".repeat(Math.max(0, columns))),
    status ? h(Text, { color: "cyan", wrap: "truncate-end" }, status) : h(Text, { dimColor: true, wrap: "truncate-end" }, KEY_HINTS),
  );
}
