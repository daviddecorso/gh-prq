import { Box, Text, useApp, useInput, useStdout } from "ink";
import React from "react";
import { relativeTime } from "../core/format.ts";
import { ACTIONABLE_BUCKETS, WAITING_BUCKETS, type BucketId, type ClassifiedPR, type QueueResult } from "../core/types.ts";
import type { Config } from "../core/config.ts";
import type { Actions } from "./actions.ts";
import { DetailPane } from "./DetailPane.ts";
import { adjacentHeader, bucketOfRow, buildRows, clampCursor, keyHints, restoreCursor, rowKey, scrollWindow } from "./model.ts";
import { QueueList } from "./QueueList.ts";
import { useQueue, type QueueLoader } from "./useQueue.ts";
import { useReviews, type Reviewer, type ReviewSettled } from "./useReviews.ts";

const h = React.createElement;

const SIDE_DETAIL_MIN_COLUMNS = 120;
const BOTTOM_DETAIL_HEIGHT = 12;
/** Header, footer rule, footer text, and one spare line so Ink never renders taller than the terminal. */
const CHROME_LINES = 4;
const STATUS_MS = 3000;
const ERROR_MS = 8000;
const CLOCK_MS = 30_000;
const MAX_WARNINGS = 2;
const NO_ITEMS: ClassifiedPR[] = [];

const firstLine = (text: string) => text.split(/\r?\n/, 1)[0]!;
const ref = (pr: ClassifiedPR) => `${pr.repo}#${pr.number}`;

const HELP_LINES: [string, string][] = [
  ["j / k / ↓ / ↑", "move"],
  ["ctrl-d/u pgdn/up", "half page / full page"],
  ["g / G", "top / bottom"],
  ["] / [", "next / previous bucket"],
  ["space / tab", "fold or unfold the bucket"],
  ["enter / o", "open in browser (enter folds on a bucket)"],
  ["/", "filter by repo, title, or @author (esc clears)"],
  ["c", "check out (exits)"],
  ["y", "copy URL"],
  ["d", "full details, with the Claude draft first if there is one"],
  ["i", "toggle the info pane"],
  ["a", "Claude drafts a review in the background"],
  ["A", "interactive Claude review session (exits)"],
  ["p", "post the draft as a pending GitHub review"],
  ["v", "approve"],
  ["x", "cancel the review or discard the draft"],
  ["r", "refresh"],
  ["q / esc", "quit"],
];

export interface AppProps {
  load: QueueLoader;
  initial?: QueueResult | null;
  actions: Actions;
  reviewer: Reviewer;
  claude: Pick<Config["claude"], "maxConcurrent" | "confirmBeforePosting">;
  collapseWaitingByDefault: boolean;
  autoRefreshSeconds: number;
  onCheckout: (pr: ClassifiedPR) => void;
  onHandoff: (pr: ClassifiedPR) => void;
}

interface Confirm {
  prompt: string;
  onYes: () => void;
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

interface Status {
  text: string;
  tone: "info" | "error";
}

function useStatus() {
  const [status, setStatus] = React.useState<Status | null>(null);
  React.useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), status.tone === "error" ? ERROR_MS : STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);
  const info = React.useCallback((text: string) => setStatus({ text, tone: "info" }), []);
  const error = React.useCallback((text: string) => setStatus({ text, tone: "error" }), []);
  return { status, info, error };
}

export function App({
  load,
  initial,
  actions,
  reviewer,
  claude,
  collapseWaitingByDefault,
  autoRefreshSeconds,
  onCheckout,
  onHandoff,
}: AppProps) {
  const { exit } = useApp();
  const { columns, rows: termRows } = useTerminalSize();
  const now = useNow();
  const queue = useQueue(load, autoRefreshSeconds, initial);
  const { status, info, error } = useStatus();
  const onReviewSettled: ReviewSettled = (pr, outcome) => {
    actions.bell();
    if (outcome.ok) info(`Claude draft ready for ${ref(pr)} (d to read)`);
    else error(`Claude review failed for ${ref(pr)}: ${firstLine(outcome.error)}`);
  };
  const reviews = useReviews(reviewer, claude.maxConcurrent, onReviewSettled);
  const [confirm, setConfirm] = React.useState<Confirm | null>(null);
  const [quitArmed, setQuitArmed] = React.useState(false);
  const approving = React.useRef(new Set<string>());

  const [collapsed, setCollapsed] = React.useState<ReadonlySet<BucketId>>(
    () => new Set(collapseWaitingByDefault ? WAITING_BUCKETS : []),
  );
  const [filter, setFilterText] = React.useState("");
  const [filterEditing, setFilterEditing] = React.useState(false);
  // Selection is tracked by row key so it follows the same PR when a refresh reorders rows.
  const [selection, setSelection] = React.useState<{ key: string; index: number | null } | null>(null);
  const [scrollStart, setScrollStart] = React.useState(0);
  const [showDetail, setShowDetail] = React.useState(false);
  const [showHelp, setShowHelp] = React.useState(false);

  const items = queue.result?.items ?? NO_ITEMS;
  const rows = React.useMemo(() => buildRows(items, collapsed, filter), [items, collapsed, filter]);
  const cursor = restoreCursor(selection, rows);
  const current = rows[cursor];
  const currentJob = current?.kind === "pr" ? reviews.jobs.get(current.pr.id) : undefined;
  const filterActive = filter.trim() !== "";

  const select = (index: number) => {
    const next = clampCursor(index, rows.length);
    const row = rows[next];
    if (row) setSelection({ key: rowKey(row), index: next });
  };

  const setFilter = (next: React.SetStateAction<string>) => {
    setFilterText(next);
    setSelection((s) => (s ? { key: s.key, index: null } : null));
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
    if (!current || filterActive) return;
    const bucket = bucketOfRow(current);
    const next = new Set(collapsed);
    if (next.has(bucket)) next.delete(bucket);
    else next.add(bucket);
    setSelection({ key: `h:${bucket}`, index: cursor });
    setCollapsed(next);
  };

  const withPR = (fn: (pr: ClassifiedPR) => void) => {
    if (current?.kind === "pr") fn(current.pr);
    else info("Select a PR first");
  };

  const confirmThen = (prompt: string, onYes: () => void) => {
    if (claude.confirmBeforePosting) setConfirm({ prompt, onYes });
    else onYes();
  };
  const runningGuard = (what: string) =>
    reviews.activeCount > 0
      ? `${reviews.activeCount} Claude review${reviews.activeCount === 1 ? "" : "s"} running; ${what}`
      : null;

  useInput((input, key) => {
    if (showHelp) {
      setShowHelp(false);
      return;
    }
    if (confirm) {
      setConfirm(null);
      if (input === "y" || input === "Y") confirm.onYes();
      else info("Cancelled");
      return;
    }
    if (filterEditing) {
      if (key.escape) {
        setFilter("");
        setFilterEditing(false);
      } else if (key.return) {
        setFilterEditing(false);
      } else if (key.backspace || key.delete) {
        setFilter((f) => f.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && !/[\x00-\x1f]/.test(input)) {
        setFilter((f) => f + input);
      } else if (key.downArrow) {
        select(cursor + 1);
      } else if (key.upArrow) {
        select(cursor - 1);
      }
      return;
    }
    const armed = quitArmed;
    setQuitArmed(false);
    if (key.escape && filterActive) return setFilter("");
    if (input === "q" || key.escape) {
      const guard = runningGuard("q again to quit and cancel them");
      if (guard && !armed) {
        setQuitArmed(true);
        return info(guard);
      }
      reviews.abortAll();
      return exit();
    }
    if (key.downArrow) return select(cursor + 1);
    if (key.upArrow) return select(cursor - 1);
    if (key.pageDown) return select(cursor + listHeight);
    if (key.pageUp) return select(cursor - listHeight);
    if (key.ctrl && input === "d") return select(cursor + Math.ceil(listHeight / 2));
    if (key.ctrl && input === "u") return select(cursor - Math.ceil(listHeight / 2));
    // Ink hands over key-repeat bursts as one string ("jjjk"), so net them out.
    if (/^[jk]+$/.test(input)) {
      const moves = [...input].reduce((n, ch) => n + (ch === "j" ? 1 : -1), 0);
      return select(cursor + moves);
    }
    if (input === "g") return select(0);
    if (input === "G") return select(rows.length - 1);
    if (input === "]") return select(adjacentHeader(rows, cursor, 1));
    if (input === "[") return select(adjacentHeader(rows, cursor, -1));
    if (input === "/") return setFilterEditing(true);
    if (input === " " || key.tab) return toggleFold();
    if (key.return && current?.kind === "header") return toggleFold();
    if (input === "i") return setShowDetail((v) => !v);
    if (input === "d") {
      return withPR((pr) => {
        const job = reviews.jobs.get(pr.id);
        const err = job?.status === "ready" ? actions.viewDetails(pr, job.draft) : actions.viewDetails(pr);
        if (err) error(err);
      });
    }
    if (input === "?") return setShowHelp(true);
    if (input === "r") return queue.refresh();
    if (input === "o" || key.return) return withPR((pr) => info(actions.open(pr)));
    if (input === "y") return withPR((pr) => info(actions.copy(pr)));
    if (input === "c") {
      return withPR((pr) => {
        const guard = runningGuard("wait or cancel them (x) first");
        if (guard) return info(guard);
        const blocker = actions.checkoutBlocker(pr);
        if (blocker) return error(blocker);
        onCheckout(pr);
        exit();
      });
    }
    if (input === "a") return withPR((pr) => info(reviews.start(pr)));
    if (input === "A") {
      return withPR((pr) => {
        const guard = runningGuard("wait or cancel them (x) first");
        if (guard) return info(guard);
        onHandoff(pr);
        exit();
      });
    }
    if (input === "p") {
      return withPR((pr) => {
        const job = reviews.jobs.get(pr.id);
        if (job?.status !== "ready") return info("No draft to post (a to start one)");
        const stale = job.headOid !== pr.headOid ? " (draft is for an older commit)" : "";
        confirmThen(`Post a pending review on ${ref(pr)}${stale}? y/n`, () =>
          reviews.post(pr, (msg, posted) => {
            if (!posted) return error(msg);
            info(msg);
            actions.openFiles(pr);
          }),
        );
      });
    }
    if (input === "v") {
      return withPR((pr) => {
        if (pr.author === queue.result?.viewer) return info("You can't approve your own PR");
        if (approving.current.has(pr.id)) return info(`Already approving ${ref(pr)}`);
        // Always asks: an approval is public the moment it lands, unlike a pending review.
        setConfirm({
          prompt: `Approve ${ref(pr)}? y/n`,
          onYes: () => {
            approving.current.add(pr.id);
            info(`Approving ${ref(pr)}…`);
            actions
              .approve(pr)
              .then((msg) => {
                info(msg);
                queue.refresh();
              })
              .catch((err: Error) => error(err.message))
              .finally(() => approving.current.delete(pr.id));
          },
        });
      });
    }
    if (input === "x") {
      return withPR((pr) => {
        const job = reviews.jobs.get(pr.id);
        if (!job) return info("Nothing to cancel or discard");
        if (job.status === "ready") confirmThen(`Discard the Claude draft for ${ref(pr)}? y/n`, () => info(reviews.discard(pr)));
        else info(reviews.discard(pr));
      });
    }
  });

  const result = queue.result;
  const actionable = items.filter((i) => ACTIONABLE_BUCKETS.has(i.bucket)).length;
  const waiting = items.filter((i) => WAITING_BUCKETS.has(i.bucket)).length;
  const matchCount = rows.filter((r) => r.kind === "pr").length;

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
    reviews.activeCount > 0 ? h(Text, { color: "magenta" }, `  ◐ ${reviews.activeCount} claude`) : null,
    filterActive ? h(Text, { color: "cyan" }, `  filter "${filter.trim()}" · ${matchCount} match${matchCount === 1 ? "" : "es"}`) : null,
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
      { flexDirection: "column", height: listHeight, overflowY: "hidden", paddingX: 2 },
      ...HELP_LINES.map(([keys, what]) => h(Text, { key: keys, wrap: "truncate-end" }, h(Text, { color: "cyan" }, keys.padEnd(18)), what)),
      h(Text, { dimColor: true, wrap: "truncate-end" }, "any key to close"),
    );
  } else if (queue.loading) {
    body = h(Box, { height: listHeight }, h(Text, { dimColor: true }, "Loading your queue…"));
  } else if (!result) {
    body = h(Box, { height: listHeight }, h(Text, { dimColor: true }, "Couldn't load the queue. r to retry, q to quit."));
  } else if (rows.length === 0 && filterActive) {
    body = h(Box, { height: listHeight }, h(Text, { dimColor: true }, `No PRs match "${filter.trim()}". esc to clear.`));
  } else if (rows.length === 0) {
    body = h(Box, { height: listHeight }, h(Text, null, "Nothing in your queue."));
  } else {
    const list = h(QueueList, { rows, cursor, start, height: listHeight, width: listWidth, now, jobs: reviews.jobs });
    body = sideDetail
      ? h(Box, null, list, h(DetailPane, { row: current, width: columns - listWidth, height: listHeight, now, job: currentJob }))
      : list;
  }

  let footer: React.ReactNode;
  if (confirm) footer = h(Text, { color: "yellow", wrap: "truncate-end" }, confirm.prompt);
  else if (filterEditing) {
    footer = h(Text, { wrap: "truncate-end" }, h(Text, { color: "cyan" }, `/${filter}▏`), h(Text, { dimColor: true }, "  enter keep · esc clear"));
  } else if (status) {
    footer = h(Text, { color: status.tone === "error" ? "red" : "cyan", wrap: "truncate-end" }, status.text);
  } else footer = h(Text, { dimColor: true, wrap: "truncate-end" }, keyHints(current, currentJob, filterActive));

  return h(
    Box,
    { flexDirection: "column", width: columns },
    header,
    ...banners,
    body,
    showBottomDetail ? h(DetailPane, { row: current, width: columns, height: BOTTOM_DETAIL_HEIGHT, now, job: currentJob }) : null,
    h(Text, { dimColor: true }, "─".repeat(Math.max(0, columns))),
    footer,
  );
}
