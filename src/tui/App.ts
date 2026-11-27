import { Box, Text, useApp, useInput, useStdout } from "ink";
import React from "react";
import type { Config } from "../core/config.ts";
import { displayWidth, relativeTime } from "../core/format.ts";
import { AGENT_IDS, type Agent } from "../core/review/agents.ts";
import { type Feedback, feedbackCount } from "../core/review/feedback.ts";
import { EVENT_FOR_VERDICT, type ReviewEvent } from "../core/review/post.ts";
import { ACTIONABLE_BUCKETS, type BucketId, type ClassifiedPR, type QueueResult, WAITING_BUCKETS } from "../core/types.ts";
import type { Actions } from "./actions.ts";
import { buildDetailLines, DetailPane, maxDetailScroll } from "./DetailPane.ts";
import { buildDetailsViewLines, type DetailsBody, DetailsView } from "./DetailsView.ts";
import { adjacentHeader, bucketOfRow, buildRows, clampCursor, keyHints, restoreCursor, rowKey, scrollWindow } from "./model.ts";
import { QueueList } from "./QueueList.ts";
import { type OnFresh, type QueueLoader, useQueue } from "./useQueue.ts";
import { type Reviewer, type ReviewSettled, useReviews } from "./useReviews.ts";

const h = React.createElement;

const SIDE_DETAIL_MIN_COLUMNS = 120;
export const AUTO_DETAIL_MIN_COLUMNS = 180;
const BOTTOM_DETAIL_HEIGHT = 12;
const TWO_COL_HELP_MIN_COLUMNS = 96;
/** Header, footer rule, 1-line footer, and one spare line so Ink never renders taller than the terminal. */
const BASE_CHROME_LINES = 4;
const STATUS_MS = 3000;
const ERROR_MS = 8000;
const CLOCK_MS = 30_000;
const FAST_CLOCK_MS = 1000;
const SPINNER_MS = 200;
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const MAX_WARNINGS = 2;
const NO_ITEMS: ClassifiedPR[] = [];
const NO_LINES: readonly string[] = [];

const firstLine = (text: string) => text.split(/\r?\n/, 1)[0]!;
const ref = (pr: ClassifiedPR) => `${pr.repo}#${pr.number}`;

const POST_CHOICES: readonly { key: string; event: ReviewEvent; label: string }[] = [
  { key: "c", event: "COMMENT", label: "comment" },
  { key: "a", event: "APPROVE", label: "approve" },
  { key: "r", event: "REQUEST_CHANGES", label: "request changes" },
  { key: "p", event: "PENDING", label: "pending" },
];

const NAV_HELP_LINES: [string, string][] = [
  ["j/k / ↑/↓", "move (or scroll in details)"],
  ["^d/^u pgdn/up", "half page / full page"],
  ["g / G", "top / bottom"],
  ["] / [", "next / previous bucket"],
  ["space / tab", "fold or unfold the bucket"],
  ["enter / o", "open in browser (enter folds bucket)"],
  ["/", "filter (@author, ci:, is:draft, is:new)"],
  ["i", "toggle the info pane"],
  ["J / K", "scroll the info pane"],
  ["r", "refresh"],
  ["q / esc", "quit (esc closes panes/filters first)"],
];

const ACTION_HELP_LINES: [string, string][] = [
  ["d", "full details & draft reader"],
  ["c", "check out (exits)"],
  ["f", "check out & fix new comments with agent (exits)"],
  ["S", "check out & start /steward on your PR (exits)"],
  ["y", "copy URL"],
  ["a", "agent drafts a review in background"],
  ["A", "interactive agent session (exits)"],
  ["m", "switch the active agent"],
  ["p", "post draft (works in details too)"],
  ["v", "approve"],
  ["x", "cancel review or discard draft"],
];

export interface AppProps {
  load: QueueLoader;
  initial?: QueueResult | null;
  actions: Actions;
  reviewer: Reviewer;
  review: Pick<Config["agent"], "maxConcurrent" | "confirmBeforePosting">;
  /** Installed agents; the first is active at startup. */
  agents: readonly Agent[];
  collapseWaitingByDefault: boolean;
  showDetailByDefault?: "auto" | boolean;
  autoRefreshSeconds: number;
  onCheckout: (pr: ClassifiedPR) => void;
  onHandoff: (pr: ClassifiedPR, agent: Agent) => void;
  onFix: (pr: ClassifiedPR, agent: Agent, feedback: Feedback) => void;
  /** Unset when Claude's built-in commands are turned off. */
  onSteward?: (pr: ClassifiedPR) => void;
}

interface Confirm {
  prompt: string;
  /** Keyed by input character, or "enter". Any other key cancels. */
  choices: Record<string, () => void>;
}

interface DetailsState {
  prId: string;
  pr: ClassifiedPR;
  body: DetailsBody;
  scroll: number;
}

const yesNo = (prompt: string, onYes: () => void): Confirm => ({ prompt, choices: { y: onYes, Y: onYes } });

function useTerminalSize() {
  const { stdout } = useStdout();
  const read = () => ({ columns: stdout.columns || 100, rows: stdout.rows || 24 });
  const [size, setSize] = React.useState(read);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read is recreated every render; depending on it would resubscribe each time.
  React.useEffect(() => {
    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout]);
  return size;
}

function useNow(fast: boolean) {
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), fast ? FAST_CLOCK_MS : CLOCK_MS);
    return () => clearInterval(timer);
  }, [fast]);
  return now;
}

function useSpinner(active: boolean) {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((n) => (n + 1) % SPINNER_FRAMES.length), SPINNER_MS);
    return () => clearInterval(timer);
  }, [active]);
  return active ? SPINNER_FRAMES[frame]! : SPINNER_FRAMES[0];
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

function renderRule(width: number, label: string | null): string {
  if (width <= 0) return "";
  if (!label || label.length + 4 >= width) return "─".repeat(width);
  const left = 2;
  const right = Math.max(0, width - left - label.length);
  return `${"─".repeat(left)}${label}${"─".repeat(right)}`;
}

export function App({
  load,
  initial,
  actions,
  reviewer,
  review,
  agents,
  collapseWaitingByDefault,
  showDetailByDefault = false,
  autoRefreshSeconds,
  onCheckout,
  onHandoff,
  onFix,
  onSteward,
}: AppProps) {
  const { exit } = useApp();
  const { columns, rows: termRows } = useTerminalSize();
  const { status, info, error } = useStatus();
  const onFresh: OnFresh = (ids, trigger) => {
    if (trigger !== "auto") return;
    actions.bell();
    info(`${ids.length} new in your queue (● marks them)`);
  };
  const queue = useQueue(load, autoRefreshSeconds, initial, onFresh);
  const onReviewSettled: ReviewSettled = (pr, agent, outcome) => {
    actions.bell();
    if (outcome.ok) info(`${agent.label} draft ready for ${ref(pr)} (d to read)`);
    else error(`${agent.label} review failed for ${ref(pr)}: ${firstLine(outcome.error)}`);
  };
  const reviews = useReviews(reviewer, review.maxConcurrent, onReviewSettled);
  const jobsRef = React.useRef(reviews.jobs);
  jobsRef.current = reviews.jobs;
  const [agentIndex, setAgentIndex] = React.useState(0);
  const activeAgent = agents[agentIndex];
  const canSwitchAgent = agents.length > 1;
  const canSteward = Boolean(onSteward && agents.some((a) => a.id === "claude"));
  const [confirm, setConfirm] = React.useState<Confirm | null>(null);
  const [quitArmed, setQuitArmed] = React.useState(false);
  const approvingRef = React.useRef(new Set<string>());
  const [approving, setApproving] = React.useState<ReadonlySet<string>>(() => new Set());
  const [details, setDetails] = React.useState<DetailsState | null>(null);
  const detailsAbort = React.useRef<AbortController | null>(null);
  const fixingRef = React.useRef<{ prRef: string; controller: AbortController } | null>(null);
  const [fixing, setFixing] = React.useState<string | null>(null);

  const now = useNow(reviews.activeCount > 0);
  const spinner = useSpinner(
    reviews.activeCount > 0 || queue.refreshing || approving.size > 0 || Boolean(details?.body.loading) || fixing !== null,
  );

  React.useEffect(
    () => () => {
      detailsAbort.current?.abort();
      fixingRef.current?.controller.abort();
    },
    [],
  );

  const [collapsed, setCollapsed] = React.useState<ReadonlySet<BucketId>>(() => new Set(collapseWaitingByDefault ? WAITING_BUCKETS : []));
  const [filter, setFilterText] = React.useState("");
  const [filterEditing, setFilterEditing] = React.useState(false);
  // Selection is tracked by row key so it follows the same PR when a refresh reorders rows.
  const [selection, setSelection] = React.useState<{ key: string; index: number | null } | null>(null);
  const [scrollStart, setScrollStart] = React.useState(0);
  const [showDetail, setShowDetail] = React.useState(() =>
    showDetailByDefault === "auto" ? columns >= AUTO_DETAIL_MIN_COLUMNS : Boolean(showDetailByDefault),
  );
  const [detailScroll, setDetailScroll] = React.useState(0);
  const [showHelp, setShowHelp] = React.useState(false);
  const [helpScroll, setHelpScroll] = React.useState(0);

  const items = queue.result?.items ?? NO_ITEMS;
  const { fresh, markSeen } = queue;
  const rows = React.useMemo(
    () => buildRows(items, collapsed, filter, reviews.jobs, (pr) => (fresh.has(pr.id) ? ["is:new"] : [])),
    [items, collapsed, filter, reviews.jobs, fresh],
  );
  const cursor = restoreCursor(selection, rows);
  const current = rows[cursor];
  const currentKey = current ? rowKey(current) : null;
  const currentPRId = current?.kind === "pr" ? current.pr.id : null;
  const currentJob = current?.kind === "pr" ? reviews.jobs.get(current.pr.id) : undefined;
  const filterActive = filter.trim() !== "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: resets scroll when the selected PR changes.
  React.useEffect(() => setDetailScroll(0), [currentKey]);
  // A PR counts as seen once the cursor leaves it, so a fresh row under the startup cursor keeps its marker until you move.
  React.useEffect(() => () => void (currentPRId && markSeen(currentPRId)), [currentPRId, markSeen]);

  const select = (index: number) => {
    const next = clampCursor(index, rows.length);
    const row = rows[next];
    if (row) setSelection({ key: rowKey(row), index: next });
  };

  const setFilter = (next: React.SetStateAction<string>) => {
    setFilterText(next);
    setSelection((s) => (s ? { key: s.key, index: null } : null));
  };

  const detailsOpen = details !== null;
  const detailsPR = details ? (items.find((p) => p.id === details.prId) ?? details.pr) : null;
  const detailsJob = details ? reviews.jobs.get(details.prId) : undefined;

  const sideDetail = showDetail && !detailsOpen && columns >= SIDE_DETAIL_MIN_COLUMNS;
  const showBottomDetail = showDetail && !detailsOpen && !sideDetail && Boolean(queue.result) && !showHelp;
  const warnings = queue.result?.warnings ?? [];
  const bannerLines = (queue.result?.staleReason ? 1 : 0) + Math.min(warnings.length, MAX_WARNINGS + 1) + (queue.error ? 1 : 0);
  const confirmExtraLines = confirm ? Math.max(0, Math.ceil(displayWidth(confirm.prompt) / Math.max(1, columns)) - 1) : 0;
  const listHeight = Math.max(
    3,
    termRows - BASE_CHROME_LINES - confirmExtraLines - bannerLines - (showBottomDetail ? BOTTOM_DETAIL_HEIGHT : 0),
  );
  const listWidth = sideDetail ? Math.floor(columns * 0.58) : columns;
  const detailWidth = sideDetail ? columns - listWidth : columns;
  const detailHeight = sideDetail ? listHeight : BOTTOM_DETAIL_HEIGHT;

  const start = scrollWindow(cursor, rows.length, listHeight, scrollStart);
  React.useEffect(() => setScrollStart(start), [start]);

  const detailMaxScroll =
    showDetail && !detailsOpen ? maxDetailScroll(buildDetailLines(current, detailWidth, now, currentJob, spinner).length, detailHeight) : 0;
  const detailsContentWidth = Math.max(20, columns - 2);
  const detailsDraft =
    detailsJob?.status === "ready" || detailsJob?.status === "posting" ? { draft: detailsJob.draft, agent: detailsJob.agent } : null;
  const detailsBody = details?.body;
  // biome-ignore lint/correctness/useExhaustiveDependencies: detailsDraft is a fresh object each render; its fields are the real inputs.
  const detailsStaticLines = React.useMemo(
    () => (detailsBody ? buildDetailsViewLines(detailsDraft, detailsBody, detailsContentWidth) : NO_LINES),
    [detailsDraft?.draft, detailsDraft?.agent, detailsBody, detailsContentWidth],
  );
  const detailsLines = detailsBody?.loading
    ? [...detailsStaticLines, ...(detailsStaticLines.length ? [""] : []), `\x1b[33m${spinner} Loading PR details…\x1b[0m`]
    : detailsStaticLines;
  const detailsMaxScroll = details ? Math.max(0, detailsLines.length - Math.max(1, listHeight - 2)) : 0;

  const actionHelp = ACTION_HELP_LINES.filter(([keys]) => (keys !== "m" || canSwitchAgent) && (keys !== "S" || canSteward));
  const twoColHelp = columns >= TWO_COL_HELP_MIN_COLUMNS;
  const helpVisibleHeight = Math.max(1, listHeight - 1);
  const helpRowCount = twoColHelp ? 1 + Math.max(NAV_HELP_LINES.length, actionHelp.length) : NAV_HELP_LINES.length + actionHelp.length;
  const helpMaxScroll = Math.max(0, helpRowCount - helpVisibleHeight);

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
    if (review.confirmBeforePosting) setConfirm(yesNo(prompt, onYes));
    else onYes();
  };
  const runningGuard = (what: string) => {
    const active = [...jobsRef.current.values()].filter((j) => j.status === "queued" || j.status === "running").length;
    return active > 0 ? `${active} review${active === 1 ? "" : "s"} running; ${what}` : null;
  };
  const withAgent = (fn: (agent: Agent) => void) => {
    if (activeAgent) fn(activeAgent);
    else error(`No review agent found (install ${AGENT_IDS.join(", ")})`);
  };

  const closeDetails = () => {
    detailsAbort.current?.abort();
    detailsAbort.current = null;
    setDetails(null);
  };

  const openDetails = (pr: ClassifiedPR) => {
    detailsAbort.current?.abort();
    const controller = new AbortController();
    detailsAbort.current = controller;
    setDetails({ prId: pr.id, pr, body: { loading: true, text: null, error: null }, scroll: 0 });
    actions
      .loadDetails(pr, { width: Math.max(20, columns - 2), signal: controller.signal })
      .then((text) => {
        if (controller.signal.aborted) return;
        setDetails((prev) => (prev?.prId === pr.id ? { ...prev, body: { loading: false, text, error: null } } : prev));
      })
      .catch((err: Error) => {
        if (controller.signal.aborted) return;
        const msg = firstLine(err.message);
        const status = jobsRef.current.get(pr.id)?.status;
        if (status === "ready" || status === "posting") {
          setDetails((prev) => (prev?.prId === pr.id ? { ...prev, body: { loading: false, text: null, error: msg } } : prev));
        } else {
          setDetails((prev) => (prev?.prId === pr.id ? null : prev));
          error(msg);
        }
      });
  };

  const startReview = (pr: ClassifiedPR) =>
    withAgent((agent) => {
      const job = reviews.jobs.get(pr.id);
      if (job?.status === "ready" && job.headOid !== pr.headOid) {
        setConfirm(
          yesNo(`Draft is stale — re-run ${agent.label} on ${ref(pr)}? y/n`, () => info(reviews.start(pr, agent, { replace: true }))),
        );
      } else {
        info(reviews.start(pr, agent));
      }
    });

  const postReview = (pr: ClassifiedPR) => {
    const job = reviews.jobs.get(pr.id);
    if (job?.status !== "ready") return info("No draft to post (a to start one)");
    const stale = job.headOid !== pr.headOid ? " (stale)" : "";
    // GitHub rejects approving or requesting changes on your own PR.
    const own = pr.author === queue.result?.viewer;
    const options = POST_CHOICES.filter((c) => !own || c.event === "COMMENT" || c.event === "PENDING");
    const suggested = options.find((c) => c.event === EVENT_FOR_VERDICT[job.draft.suggestedVerdict]) ?? options[0]!;
    const submit = (event: ReviewEvent) =>
      reviews.post(pr, event, (msg, posted) => {
        if (!posted) return error(msg);
        info(msg);
        if (event === "PENDING") actions.openFiles(pr);
        else queue.refresh();
      });
    const choices: Confirm["choices"] = { enter: () => submit(suggested.event) };
    for (const c of options) choices[c.key] = () => submit(c.event);
    setConfirm({
      prompt: `Post to ${ref(pr)}${stale}: ${options.map((c) => `${c.key} ${c.label}`).join(" · ")} · enter ${suggested.label} · esc cancel`,
      choices,
    });
  };

  const approveReview = (pr: ClassifiedPR) => {
    if (pr.author === queue.result?.viewer) return info("You can't approve your own PR");
    if (approvingRef.current.has(pr.id)) return info(`Already approving ${ref(pr)}`);
    // Always asks: an approval is public the moment it lands, unlike a pending review.
    setConfirm(
      yesNo(`Approve ${ref(pr)}? y/n`, () => {
        approvingRef.current.add(pr.id);
        setApproving(new Set(approvingRef.current));
        info(`Approving ${ref(pr)}…`);
        actions
          .approve(pr)
          .then((msg) => {
            info(msg);
            queue.refresh();
          })
          .catch((err: Error) => error(err.message))
          .finally(() => {
            approvingRef.current.delete(pr.id);
            setApproving(new Set(approvingRef.current));
          });
      }),
    );
  };

  const startSteward = (pr: ClassifiedPR) => {
    if (!canSteward || !onSteward) return info("Steward needs Claude with claudeBuiltins on");
    const viewer = queue.result?.viewer;
    if (!viewer) return info("Wait for the queue to load");
    if (pr.author !== viewer) return info("Steward only works on your own PRs");
    const guard = runningGuard("wait or cancel them (x) first");
    if (guard) return info(guard);
    const blocker = actions.checkoutBlocker(pr);
    if (blocker) return error(blocker);
    // Always asks: the watch commits, pushes and replies to reviewers under the user's name.
    setConfirm(
      yesNo(`Steward commits, pushes and replies to reviewers on ${ref(pr)} as you until /ship stop. Continue? y/n`, () => {
        fixingRef.current?.controller.abort();
        onSteward(pr);
        exit();
      }),
    );
  };

  const fixFeedback = (pr: ClassifiedPR) =>
    withAgent((agent) => {
      if (fixingRef.current) return info(`Already loading comments for ${fixingRef.current.prRef}`);
      const viewer = queue.result?.viewer;
      if (!viewer) return info("Wait for the queue to load");
      const guard = runningGuard("wait or cancel them (x) first");
      if (guard) return info(guard);
      const blocker = actions.checkoutBlocker(pr);
      if (blocker) return error(blocker);
      const controller = new AbortController();
      const prRef = ref(pr);
      fixingRef.current = { prRef, controller };
      setFixing(prRef);
      info(`Loading comments on ${prRef} since the last commit…`);
      actions
        .loadFeedback(pr, viewer, controller.signal)
        .then((feedback) => {
          if (controller.signal.aborted) return;
          const lateGuard = runningGuard("wait or cancel them (x) first");
          if (lateGuard) return info(lateGuard);
          if (feedbackCount(feedback) === 0) return info(`No new comments on ${prRef} since ${feedback.since.oid.slice(0, 7)}`);
          onFix(pr, agent, feedback);
          exit();
        })
        .catch((err: Error) => {
          if (!controller.signal.aborted) error(firstLine(err.message));
        })
        .finally(() => {
          if (fixingRef.current?.controller === controller) fixingRef.current = null;
          setFixing(null);
        });
    });

  const discardReview = (pr: ClassifiedPR) => {
    const job = reviews.jobs.get(pr.id);
    if (!job) return info("Nothing to cancel or discard");
    if (job.status === "ready") confirmThen(`Discard the ${job.agent.label} draft for ${ref(pr)}? y/n`, () => info(reviews.discard(pr)));
    else info(reviews.discard(pr));
  };

  useInput((input, key) => {
    if (showHelp) {
      if (helpMaxScroll > 0) {
        const scrollHelp = (delta: number) => setHelpScroll((s) => Math.max(0, Math.min(helpMaxScroll, s + delta)));
        if (key.downArrow) return scrollHelp(1);
        if (key.upArrow) return scrollHelp(-1);
        if (key.pageDown) return scrollHelp(helpVisibleHeight);
        if (key.pageUp) return scrollHelp(-helpVisibleHeight);
        if (key.ctrl && input === "d") return scrollHelp(Math.ceil(helpVisibleHeight / 2));
        if (key.ctrl && input === "u") return scrollHelp(-Math.ceil(helpVisibleHeight / 2));
        if (/^[jk]+$/.test(input)) {
          const moves = [...input].reduce((n, ch) => n + (ch === "j" ? 1 : -1), 0);
          return scrollHelp(moves);
        }
      }
      setShowHelp(false);
      setHelpScroll(0);
      return;
    }
    if (confirm) {
      setConfirm(null);
      const choice = confirm.choices[key.return ? "enter" : input];
      if (choice) choice();
      else info("Cancelled");
      return;
    }
    if (filterEditing) {
      if (key.escape) {
        setFilter("");
        setFilterEditing(false);
      } else if (key.return) {
        setFilterEditing(false);
      } else if (key.ctrl && input === "u") {
        setFilter("");
      } else if (key.ctrl && input === "w") {
        setFilter((f) => f.replace(/\S+\s*$/, ""));
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
    if (details && detailsPR) {
      const scrollBy = (delta: number) =>
        setDetails((prev) => (prev ? { ...prev, scroll: Math.max(0, Math.min(detailsMaxScroll, prev.scroll + delta)) } : prev));
      const page = Math.max(1, listHeight - 2);
      if (key.escape || input === "q" || (input === "d" && !key.ctrl)) return closeDetails();
      if (input === "?") {
        setHelpScroll(0);
        return setShowHelp(true);
      }
      if (key.downArrow) return scrollBy(1);
      if (key.upArrow) return scrollBy(-1);
      if (key.pageDown || input === " ") return scrollBy(page);
      if (key.pageUp) return scrollBy(-page);
      if (key.ctrl && input === "d") return scrollBy(Math.ceil(page / 2));
      if (key.ctrl && input === "u") return scrollBy(-Math.ceil(page / 2));
      if (/^[jk]+$/.test(input)) {
        const moves = [...input].reduce((n, ch) => n + (ch === "j" ? 1 : -1), 0);
        return scrollBy(moves);
      }
      if (input === "g") return setDetails((prev) => (prev ? { ...prev, scroll: 0 } : prev));
      if (input === "G") return setDetails((prev) => (prev ? { ...prev, scroll: detailsMaxScroll } : prev));
      if (input === "o") return info(actions.open(detailsPR));
      if (input === "y") return info(actions.copy(detailsPR));
      if (input === "p") return postReview(detailsPR);
      if (input === "v") return approveReview(detailsPR);
      if (input === "a") return startReview(detailsPR);
      if (input === "x") return discardReview(detailsPR);
      if (input === "f") return fixFeedback(detailsPR);
      if (input === "S") return startSteward(detailsPR);
      if (input === "m" && canSwitchAgent) {
        const next = (agentIndex + 1) % agents.length;
        setAgentIndex(next);
        return info(`Reviews now use ${agents[next]!.label}`);
      }
      return;
    }

    const armed = quitArmed;
    setQuitArmed(false);
    if (key.escape) {
      if (filterActive) return setFilter("");
      if (showDetail) return setShowDetail(false);
    }
    if (input === "q" || key.escape) {
      const guard = runningGuard("q again to quit and cancel them");
      if (guard && !armed) {
        setQuitArmed(true);
        return info(guard);
      }
      fixingRef.current?.controller.abort();
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
    if (/^[JK]+$/.test(input) && showDetail) {
      const moves = [...input].reduce((n, ch) => n + (ch === "J" ? 1 : -1), 0);
      return setDetailScroll((s) => Math.max(0, Math.min(detailMaxScroll, s + moves)));
    }
    if (input === "g") return select(0);
    if (input === "G") return select(rows.length - 1);
    if (input === "]") return select(adjacentHeader(rows, cursor, 1));
    if (input === "[") return select(adjacentHeader(rows, cursor, -1));
    if (input === "/") return setFilterEditing(true);
    if (input === " " || key.tab) return toggleFold();
    if (key.return && current?.kind === "header") return toggleFold();
    if (input === "i") return setShowDetail((v) => !v);
    if (input === "d") return withPR(openDetails);
    if (input === "?") {
      setHelpScroll(0);
      return setShowHelp(true);
    }
    if (input === "r") return queue.refresh();
    if (input === "o" || key.return) return withPR((pr) => info(actions.open(pr)));
    if (input === "y") return withPR((pr) => info(actions.copy(pr)));
    if (input === "c") {
      return withPR((pr) => {
        const guard = runningGuard("wait or cancel them (x) first");
        if (guard) return info(guard);
        const blocker = actions.checkoutBlocker(pr);
        if (blocker) return error(blocker);
        fixingRef.current?.controller.abort();
        onCheckout(pr);
        exit();
      });
    }
    if (input === "a") return withPR(startReview);
    if (input === "f") return withPR(fixFeedback);
    if (input === "S") return withPR(startSteward);
    if (input === "A") {
      return withPR((pr) =>
        withAgent((agent) => {
          const guard = runningGuard("wait or cancel them (x) first");
          if (guard) return info(guard);
          fixingRef.current?.controller.abort();
          onHandoff(pr, agent);
          exit();
        }),
      );
    }
    if (input === "m" && canSwitchAgent) {
      const next = (agentIndex + 1) % agents.length;
      setAgentIndex(next);
      return info(`Reviews now use ${agents[next]!.label}`);
    }
    if (input === "p") return withPR(postReview);
    if (input === "v") return withPR(approveReview);
    if (input === "x") return withPR(discardReview);
  });

  const result = queue.result;
  const actionable = items.filter((i) => ACTIONABLE_BUCKETS.has(i.bucket)).length;
  const waiting = items.filter((i) => WAITING_BUCKETS.has(i.bucket)).length;
  const matchCount = rows.filter((r) => r.kind === "pr").length;
  const readyCount = items.reduce((n, pr) => n + (reviews.jobs.get(pr.id)?.status === "ready" ? 1 : 0), 0);

  const header = h(
    Text,
    { wrap: "truncate-end" },
    h(Text, { bold: true }, "gh-prq"),
    "  ",
    result
      ? h(Text, { dimColor: true }, `${actionable} actionable · ${waiting} waiting · updated ${relativeTime(result.fetchedAt, now)} ago`)
      : null,
    fresh.size > 0 ? h(Text, { color: "cyan" }, `  ● ${fresh.size} new`) : null,
    reviews.activeCount > 0 ? h(Text, { color: "magenta" }, `  ${spinner} ${reviews.activeCount} reviewing`) : null,
    readyCount > 0 ? h(Text, { color: "magenta" }, `  ✎ ${readyCount} draft${readyCount === 1 ? "" : "s"}`) : null,
    canSwitchAgent ? h(Text, { color: "magenta" }, `  ⇄ ${activeAgent!.id}`) : null,
    filterActive ? h(Text, { color: "cyan" }, `  filter "${filter.trim()}" · ${matchCount} match${matchCount === 1 ? "" : "es"}`) : null,
    queue.refreshing ? h(Text, { color: "yellow" }, `  ${spinner} refreshing…`) : null,
    fixing ? h(Text, { color: "yellow" }, `  ${spinner} loading comments…`) : null,
  );

  const banners = [
    result?.staleReason
      ? h(Text, { key: "stale", color: "yellow", wrap: "truncate-end" }, `⚠ Offline / stale cache: ${firstLine(result.staleReason)}`)
      : null,
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
    const helpOffset = Math.max(0, Math.min(helpScroll, helpMaxScroll));
    const helpBelow = Math.max(0, helpRowCount - (helpOffset + helpVisibleHeight));
    const helpHint =
      helpMaxScroll > 0
        ? [helpOffset > 0 ? `↑ ${helpOffset}` : null, helpBelow > 0 ? `↓ ${helpBelow} more` : null, "j/k scroll · any other key to close"]
            .filter(Boolean)
            .join(" · ")
        : "any key to close";
    let helpRows: React.ReactNode[];
    if (twoColHelp) {
      const innerWidth = Math.max(20, columns - 4);
      const leftWidth = Math.floor(innerWidth * 0.59);
      const rightWidth = innerWidth - leftWidth;
      const pairCount = Math.max(NAV_HELP_LINES.length, actionHelp.length);
      helpRows = [
        h(
          Box,
          { key: "help-hdr", flexDirection: "row", gap: 2 },
          h(Box, { width: leftWidth }, h(Text, { bold: true, dimColor: true, wrap: "truncate-end" }, "Navigation")),
          h(Box, { width: rightWidth }, h(Text, { bold: true, dimColor: true, wrap: "truncate-end" }, "Actions & Reviews")),
        ),
        ...Array.from({ length: pairCount }, (_, i) => {
          const left = NAV_HELP_LINES[i];
          const right = actionHelp[i];
          return h(
            Box,
            { key: `help-${i}`, flexDirection: "row", gap: 2 },
            h(
              Box,
              { width: leftWidth },
              left ? h(Text, { wrap: "truncate-end" }, h(Text, { color: "cyan" }, left[0].padEnd(15)), left[1]) : h(Text, null, " "),
            ),
            h(
              Box,
              { width: rightWidth },
              right ? h(Text, { wrap: "truncate-end" }, h(Text, { color: "cyan" }, right[0].padEnd(3)), right[1]) : h(Text, null, " "),
            ),
          );
        }),
      ];
    } else {
      helpRows = [...NAV_HELP_LINES, ...actionHelp].map(([keys, what]) =>
        h(Text, { key: keys, wrap: "truncate-end" }, h(Text, { color: "cyan" }, keys.padEnd(15)), what),
      );
    }
    body = h(
      Box,
      { flexDirection: "column", height: listHeight, overflowY: "hidden", paddingX: 1 },
      ...helpRows.slice(helpOffset, helpOffset + helpVisibleHeight),
      h(Text, { dimColor: true, wrap: "truncate-end" }, helpHint),
    );
  } else if (details && detailsPR) {
    body = h(DetailsView, {
      pr: detailsPR,
      lines: detailsLines,
      width: columns,
      height: listHeight,
      scroll: details.scroll,
    });
  } else if (queue.loading) {
    body = h(Box, { height: listHeight }, h(Text, { dimColor: true }, "Loading your queue…"));
  } else if (!result) {
    body = h(Box, { height: listHeight }, h(Text, { dimColor: true }, "Couldn't load the queue. r to retry, q to quit."));
  } else if (rows.length === 0 && filterActive) {
    body = h(Box, { height: listHeight }, h(Text, { dimColor: true }, `No PRs match "${filter.trim()}". esc to clear.`));
  } else if (rows.length === 0) {
    body = h(Box, { height: listHeight }, h(Text, null, "Nothing in your queue."));
  } else {
    const list = h(QueueList, {
      rows,
      cursor,
      start,
      height: listHeight,
      width: listWidth,
      now,
      jobs: reviews.jobs,
      viewer: result.viewer,
      approving,
      fresh,
      spinner,
    });
    body = sideDetail
      ? h(
          Box,
          null,
          list,
          h(DetailPane, { row: current, width: detailWidth, height: detailHeight, now, job: currentJob, scroll: detailScroll, spinner }),
        )
      : list;
  }

  let scrollLabel: string | null = null;
  if (!showHelp && !detailsOpen && rows.length > listHeight) {
    const above = start;
    const below = Math.max(0, rows.length - (start + listHeight));
    const parts = [above > 0 ? `↑ ${above} above` : null, below > 0 ? `↓ ${below} more` : null].filter(Boolean);
    if (parts.length) scrollLabel = ` ${parts.join(" · ")} `;
  }

  let footer: React.ReactNode;
  if (confirm) footer = h(Text, { color: "yellow", wrap: "wrap" }, confirm.prompt);
  else if (filterEditing) {
    footer = h(
      Text,
      { wrap: "truncate-end" },
      h(Text, { color: "cyan" }, `/${filter}▏`),
      h(Text, { dimColor: true }, "  enter keep · esc clear · ctrl-u/w delete"),
    );
  } else if (status) {
    footer = h(Text, { color: status.tone === "error" ? "red" : "cyan", wrap: "truncate-end" }, status.text);
  } else {
    const hintRow = detailsOpen && detailsPR ? ({ kind: "pr", pr: detailsPR } as const) : current;
    const hintJob = detailsOpen ? detailsJob : currentJob;
    footer = h(Text, { dimColor: true, wrap: "truncate-end" }, keyHints(hintRow, hintJob, filterActive, { showDetail, detailsOpen }));
  }

  return h(
    Box,
    { flexDirection: "column", width: columns },
    header,
    ...banners,
    body,
    showBottomDetail
      ? h(DetailPane, { row: current, width: columns, height: BOTTOM_DETAIL_HEIGHT, now, job: currentJob, scroll: detailScroll, spinner })
      : null,
    h(Text, { dimColor: true }, renderRule(Math.max(0, columns), scrollLabel)),
    footer,
  );
}
