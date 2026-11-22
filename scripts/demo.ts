import { render } from "ink";
import React from "react";
import { AGENTS } from "../src/core/review/agents.ts";
import type { SavedDraft } from "../src/core/review/drafts.ts";
import type { BucketId, ClassifiedPR, QueueResult } from "../src/core/types.ts";
import type { Actions } from "../src/tui/actions.ts";
import { runInAltScreen } from "../src/tui/altScreen.ts";
import { App } from "../src/tui/App.ts";

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

let nextOid = 0;
function pr(
  repo: string,
  number: number,
  title: string,
  author: string,
  bucket: BucketId,
  reason: string,
  sinceMinutes: number,
  overrides: Partial<ClassifiedPR> = {},
): ClassifiedPR {
  const oid = (++nextOid).toString(16).padStart(7, "a");
  return {
    id: `${repo}#${number}`,
    repo,
    number,
    title,
    url: `https://github.com/${repo}/pull/${number}`,
    author,
    bucket,
    reason,
    allReasons: [reason],
    ciState: "SUCCESS",
    failedChecks: [],
    additions: 120,
    deletions: 34,
    headOid: oid,
    lastReviewedCommitOid: null,
    commits: [
      { oid: `${oid}1`, headline: "Initial implementation", committedAt: ago(sinceMinutes + 300) },
      { oid, headline: "Address review feedback", committedAt: ago(sinceMinutes) },
    ],
    commitCount: 2,
    viewerThreads: [],
    badges: [],
    updatedAt: ago(sinceMinutes),
    actionSince: ago(sinceMinutes),
    ...overrides,
  };
}

const items: ClassifiedPR[] = [
  pr("acme/api", 1482, "Rate limit webhook retries per installation", "priya", "NEEDS_REREVIEW", "3 new commits since your review", 42, {
    additions: 86,
    deletions: 21,
    latestReplySnippet: {
      author: "priya",
      body: "Moved the backoff into the queue worker so retries share the budget.",
      path: "src/webhooks/retry.ts",
      createdAt: ago(42),
    },
    viewerThreads: [
      {
        path: "src/webhooks/retry.ts",
        isOutdated: false,
        comments: [
          { author: "you", body: "This retries forever if the installation is suspended.", createdAt: ago(1500) },
          { author: "priya", body: "Moved the backoff into the queue worker so retries share the budget.", createdAt: ago(42) },
        ],
      },
    ],
  }),
  pr("acme/web", 3307, "Migrate settings page to the new form primitives", "marcus", "NEEDS_REREVIEW", "replied to your comment", 180, {
    additions: 412,
    deletions: 389,
    ciState: "PENDING",
  }),
  pr("acme/api", 1495, "Add cursor pagination to /v2/events", "jordan", "NEEDS_INITIAL_REVIEW", "review requested", 25, {
    additions: 233,
    deletions: 48,
  }),
  pr("acme/mobile", 812, "Cache avatar images on disk", "sam", "NEEDS_INITIAL_REVIEW", "review requested (team)", 300, {
    badges: ["team"],
    additions: 64,
    deletions: 9,
  }),
  pr("acme/infra", 207, "Bump Postgres to 17 in staging", "lee", "NEEDS_INITIAL_REVIEW", "review requested", 1440, {
    additions: 12,
    deletions: 12,
  }),
  pr("acme/web", 3311, "Fix flicker when switching workspaces", "me", "MY_PR_ACTION_NEEDED", "CI failing", 15, {
    ciState: "FAILURE",
    failedChecks: ["e2e (chromium)"],
    additions: 37,
    deletions: 14,
  }),
  pr("acme/api", 1470, "Drop legacy v1 auth tokens", "me", "MY_PR_ACTION_NEEDED", "changes requested by priya", 95, {
    additions: 58,
    deletions: 402,
  }),
  pr("acme/cli", 96, "Add --json output to `acme deploy`", "me", "MY_PR_READY", "approved, CI green", 60, {
    additions: 141,
    deletions: 22,
  }),
  pr("acme/web", 3290, "Lazy-load the billing dashboard", "nina", "WAITING_ON_AUTHOR", "you requested changes", 2880, {
    additions: 518,
    deletions: 77,
  }),
  pr("acme/api", 1488, "Log slow queries over 500ms", "me", "MY_PR_WAITING", "waiting on review", 400, {
    additions: 29,
    deletions: 3,
  }),
  pr("acme/mobile", 820, "WIP: offline mode", "sam", "DRAFTS", "draft", 4320, {
    additions: 904,
    deletions: 156,
    ciState: "NONE",
  }),
];

const queue: QueueResult = { viewer: "me", fetchedAt: ago(1), warnings: [], items };

const draftFor = items[0]!;
const drafts: SavedDraft[] = [
  {
    prId: draftFor.id,
    headOid: draftFor.headOid,
    createdAt: ago(3),
    agent: "claude",
    draft: {
      summary: "The retry budget fix looks right. One edge case left: suspended installations still enqueue a retry before the budget check.",
      comments: [
        {
          path: "src/webhooks/retry.ts",
          line: 48,
          side: "RIGHT",
          body: "We check the budget after enqueueing, so a suspended install still gets one retry. Can we move the check above `queue.push`?",
        },
      ],
      threadFollowUps: [],
      suggestedVerdict: "comment",
    },
  },
];

const actions: Actions = {
  open: (p) => `Opened ${p.repo}#${p.number}`,
  openFiles: () => {},
  copy: (p) => `Copied ${p.url}`,
  approve: async (p) => `Approved ${p.repo}#${p.number}`,
  checkoutBlocker: () => null,
  loadDetails: async (p) =>
    `${p.repo}#${p.number} — ${p.title}\nAuthor: @${p.author}\n\n${p.latestReplySnippet?.body ?? "Demo PR body."}\n\nREVIEW COMMENTS\nNo inline review comments.`,
  bell: () => {},
};

await runInAltScreen(() =>
  render(
    React.createElement(App, {
      load: async () => queue,
      initial: queue,
      actions,
      reviewer: {
        run: async () => drafts[0]!.draft,
        post: async () => "Review posted",
        loadDrafts: () => drafts,
        saveDraft: () => {},
        removeDraft: () => {},
      },
      review: { maxConcurrent: 2, confirmBeforePosting: true },
      agents: [AGENTS.claude, AGENTS.gemini],
      collapseWaitingByDefault: false,
      showDetailByDefault: "auto",
      autoRefreshSeconds: 0,
      onCheckout: () => {},
      onHandoff: () => {},
    }),
  ),
);
