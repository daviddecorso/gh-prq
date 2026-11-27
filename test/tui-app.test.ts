import { EventEmitter } from "node:events";
import { render as inkRender } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AGENTS, type Agent } from "../src/core/review/agents.ts";
import type { Feedback } from "../src/core/review/feedback.ts";
import type { ReviewDraft } from "../src/core/review/schema.ts";
import type { ClassifiedPR, QueueResult } from "../src/core/types.ts";
import { App, AUTO_DETAIL_MIN_COLUMNS } from "../src/tui/App.ts";
import type { Actions } from "../src/tui/actions.ts";
import { DetailPane } from "../src/tui/DetailPane.ts";
import type { Row } from "../src/tui/model.ts";
import type { Reviewer } from "../src/tui/useReviews.ts";
import { item, result } from "./fixtures.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

const NO_FEEDBACK: Feedback = { since: { oid: "abc1234567", at: "2026-01-01T00:00:00Z" }, threads: [], reviews: [], comments: [] };

const DRAFT: ReviewDraft = {
  summary: "Looks close. One race in the refresh path.",
  comments: [{ path: "src/a.ts", line: 3, side: "RIGHT", body: "We can double-refresh here." }],
  threadFollowUps: [],
  suggestedVerdict: "comment",
};

function setup(
  load: (refresh: boolean) => Promise<QueueResult>,
  actionOverrides: Partial<Actions> = {},
  initial: QueueResult | null = null,
  reviewerOverrides: Partial<Reviewer> = {},
  maxConcurrent = 2,
  agents: Agent[] = [AGENTS.claude],
  showDetailByDefault: "auto" | boolean = false,
  autoRefreshSeconds = 0,
) {
  const actions: Actions = {
    open: vi.fn((pr: ClassifiedPR) => `Opened ${pr.id}`),
    openFiles: vi.fn(),
    copy: vi.fn((pr: ClassifiedPR) => `Copied ${pr.id}`),
    approve: vi.fn(async (pr: ClassifiedPR) => `Approved ${pr.id}`),
    checkoutBlocker: vi.fn(() => null),
    loadDetails: vi.fn(async (pr: ClassifiedPR) => `PR body for ${pr.id}`),
    loadFeedback: vi.fn(async () => NO_FEEDBACK),
    bell: vi.fn(),
    ...actionOverrides,
  };
  const reviewer: Reviewer = {
    run: vi.fn(async () => DRAFT),
    post: vi.fn(async () => "Pending review posted"),
    loadDrafts: vi.fn(() => []),
    saveDraft: vi.fn(),
    removeDraft: vi.fn(),
    ...reviewerOverrides,
  };
  const onCheckout = vi.fn();
  const onHandoff = vi.fn();
  const onFix = vi.fn();
  const onSteward = vi.fn();
  const app = render(
    React.createElement(App, {
      load,
      initial,
      actions,
      reviewer,
      review: { maxConcurrent, confirmBeforePosting: true },
      agents,
      collapseWaitingByDefault: true,
      showDetailByDefault,
      autoRefreshSeconds,
      onCheckout,
      onHandoff,
      onFix,
      onSteward,
    }),
  );
  return { ...app, actions, reviewer, onCheckout, onHandoff, onFix, onSteward };
}

async function press(app: { stdin: { write(s: string): void } }, ...keys: string[]) {
  for (const key of keys) {
    app.stdin.write(key);
    await tick();
  }
}

const queue = result([item("PR1", "NEEDS_REREVIEW"), item("PR2", "NEEDS_INITIAL_REVIEW"), item("PR3", "WAITING_ON_AUTHOR")]);

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("App", () => {
  test("renders buckets with waiting collapsed", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    const frame = app.lastFrame()!;
    expect(frame).toContain("▾ NEEDS RE-REVIEW (1)");
    expect(frame).toContain("PR PR1");
    expect(frame).toContain("▸ WAITING ON AUTHOR (1)");
    expect(frame).not.toContain("PR PR3");
  });

  test("lists recent commits newest first in the detail pane", async () => {
    const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h)).toISOString();
    const pr = item("PR1", "NEEDS_REREVIEW", {
      lastReviewedCommitOid: "aaaaaaa111",
      commitCount: 12,
      commits: [
        { oid: "aaaaaaa111", headline: "Add retry", committedAt: at(1) },
        { oid: "bbbbbbb222", headline: "Fix flaky test", committedAt: at(2) },
      ],
    });
    const app = render(
      React.createElement(DetailPane, { row: { kind: "pr", pr } as Row, width: 80, height: 30, now: Date.UTC(2026, 0, 2), job: undefined }),
    );
    cleanup = app.unmount;
    const frame = app.lastFrame()!;
    expect(frame).toContain("Commits (12)");
    expect(frame.indexOf("bbbbbbb Fix flaky test")).toBeGreaterThan(-1);
    expect(frame.indexOf("bbbbbbb")).toBeLessThan(frame.indexOf("aaaaaaa Add retry"));
  });

  test("shows the cached queue while the first load is in flight", async () => {
    let resolve!: (r: QueueResult) => void;
    const app = setup(() => new Promise((r) => (resolve = r)), {}, result([item("OLD", "NEEDS_REREVIEW")]));
    cleanup = app.unmount;
    await tick();
    expect(app.lastFrame()).toContain("PR OLD");
    expect(app.lastFrame()).toContain("refreshing");
    resolve(queue);
    await tick();
    expect(app.lastFrame()).toContain("PR PR1");
    expect(app.lastFrame()).not.toContain("PR OLD");
  });

  test("marks PRs that became actionable since the cached queue until the cursor leaves them", async () => {
    const cached = result([item("PR1", "NEEDS_REREVIEW"), item("PR3", "WAITING_ON_AUTHOR")]);
    const app = setup(async () => result([item("PR3", "NEEDS_REREVIEW"), item("PR1", "NEEDS_REREVIEW")]), {}, cached);
    cleanup = app.unmount;
    await tick();
    expect(app.lastFrame()).toContain("● 1 new");
    expect(app.lastFrame()).toContain("› acme/api#3");
    expect(app.actions.bell).not.toHaveBeenCalled();
    await press(app, "j");
    expect(app.lastFrame()).not.toContain("●");
  });

  test("is:new filters to fresh PRs", async () => {
    const cached = result([item("PR1", "NEEDS_REREVIEW")]);
    const app = setup(async () => result([item("PR1", "NEEDS_REREVIEW"), item("PR2", "NEEDS_INITIAL_REVIEW")]), {}, cached);
    cleanup = app.unmount;
    await tick();
    await press(app, "/", ..."is:new", "\r");
    expect(app.lastFrame()).toContain("PR PR2");
    expect(app.lastFrame()).not.toContain("PR PR1");
  });

  test("a background refresh that adds actionable PRs rings the bell", async () => {
    let calls = 0;
    const load = async () => (calls++ === 0 ? result([item("PR1", "NEEDS_REREVIEW")]) : queue);
    const app = setup(load, {}, null, {}, 2, [AGENTS.claude], false, 0.05);
    cleanup = app.unmount;
    await tick();
    expect(app.actions.bell).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 80));
    expect(app.actions.bell).toHaveBeenCalledTimes(1);
    expect(app.lastFrame()).toContain("● acme/api#2");
  });

  test("space unfolds the bucket under the cursor", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    app.stdin.write("G");
    await tick();
    app.stdin.write(" ");
    await tick();
    expect(app.lastFrame()).toContain("PR PR3");
  });

  test("starts on the first PR and o opens it", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    app.stdin.write("o");
    await tick();
    expect(app.actions.open).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }));
    expect(app.lastFrame()).toContain("Opened PR1");
  });

  test("a burst of j/k keys moves by the net count", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    app.stdin.write("jjjk");
    await tick();
    app.stdin.write("o");
    await tick();
    expect(app.actions.open).toHaveBeenCalledWith(expect.objectContaining({ id: "PR2" }));
  });

  test("a failed refresh keeps the old rows and shows the error", async () => {
    let calls = 0;
    const app = setup(async () => {
      if (calls++ === 0) return queue;
      throw new Error("network down");
    });
    cleanup = app.unmount;
    await tick();
    app.stdin.write("r");
    await tick();
    const frame = app.lastFrame()!;
    expect(frame).toContain("PR PR1");
    expect(frame).toContain("network down");
  });

  test("checkout from the wrong repo shows why and doesn't exit", async () => {
    const app = setup(async () => queue, { checkoutBlocker: () => "cd into acme/api to check out #1" });
    cleanup = app.unmount;
    await tick();
    app.stdin.write("c");
    await tick();
    expect(app.lastFrame()).toContain("cd into acme/api");
    expect(app.onCheckout).not.toHaveBeenCalled();
  });

  test("checkout from the right repo hands the PR back", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    app.stdin.write("c");
    await tick();
    expect(app.onCheckout).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }));
  });

  test("f with no new comments stays in the TUI", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    await press(app, "f");
    expect(app.actions.loadFeedback).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }), "me", expect.any(AbortSignal));
    expect(app.lastFrame()).toContain("No new comments");
    expect(app.onFix).not.toHaveBeenCalled();
  });

  test("f with new comments hands the PR, agent, and feedback back", async () => {
    const feedback: Feedback = { ...NO_FEEDBACK, comments: [{ author: "alice", body: "Rename this", createdAt: "2026-01-02T00:00:00Z" }] };
    const app = setup(async () => queue, { loadFeedback: vi.fn(async () => feedback) });
    cleanup = app.unmount;
    await tick();
    await press(app, "f");
    expect(app.onFix).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }), AGENTS.claude, feedback);
  });

  test("S refuses someone else's PR", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    await press(app, "S");
    expect(app.lastFrame()).toContain("only works on your own PRs");
    expect(app.onSteward).not.toHaveBeenCalled();
  });

  test("S on your own PR confirms before handing off to /steward", async () => {
    const app = setup(async () => result([item("PR1", "MY_PR_ACTION_NEEDED", { author: "me" })]));
    cleanup = app.unmount;
    await tick();
    await press(app, "S");
    expect(app.lastFrame()).toContain("pushes and replies");
    expect(app.onSteward).not.toHaveBeenCalled();
    await press(app, "y");
    expect(app.onSteward).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }));
  });

  test("f from the wrong repo shows why without loading comments", async () => {
    const app = setup(async () => queue, { checkoutBlocker: () => "cd into acme/api to check out #1" });
    cleanup = app.unmount;
    await tick();
    await press(app, "f");
    expect(app.lastFrame()).toContain("cd into acme/api");
    expect(app.actions.loadFeedback).not.toHaveBeenCalled();
  });

  test("f while loading shows a spinner, ignores a second press, and aborts on checkout", async () => {
    let resolveFeedback!: (f: Feedback) => void;
    let signal!: AbortSignal;
    const loadFeedback = vi.fn(
      (_pr: ClassifiedPR, _viewer: string, s?: AbortSignal) =>
        new Promise<Feedback>((resolve) => {
          signal = s!;
          resolveFeedback = resolve;
        }),
    );
    const app = setup(async () => queue, { loadFeedback });
    cleanup = app.unmount;
    await tick();
    app.stdin.write("f");
    app.stdin.write("f");
    await tick();
    expect(loadFeedback).toHaveBeenCalledTimes(1);
    expect(app.lastFrame()).toContain("loading comments…");
    await press(app, "c");
    expect(signal.aborted).toBe(true);
    expect(app.onCheckout).toHaveBeenCalledTimes(1);
    resolveFeedback({ ...NO_FEEDBACK, comments: [{ author: "alice", body: "fix", createdAt: "2026-01-02T00:00:00Z" }] });
    await tick();
    expect(app.onFix).not.toHaveBeenCalled();
  });

  test("f doesn't exit or abort if a review starts while comments are loading", async () => {
    let resolveFeedback!: (f: Feedback) => void;
    const loadFeedback = vi.fn(() => new Promise<Feedback>((resolve) => (resolveFeedback = resolve)));
    let reviewSignal!: AbortSignal;
    const app = setup(async () => queue, { loadFeedback }, null, {
      run: vi.fn((_pr: ClassifiedPR, _agent: Agent, s: AbortSignal) => {
        reviewSignal = s;
        return new Promise<ReviewDraft>(() => {});
      }),
    });
    cleanup = app.unmount;
    await tick();
    await press(app, "f");
    await press(app, "a");
    resolveFeedback({ ...NO_FEEDBACK, comments: [{ author: "alice", body: "fix", createdAt: "2026-01-02T00:00:00Z" }] });
    await tick();
    expect(app.onFix).not.toHaveBeenCalled();
    expect(reviewSignal.aborted).toBe(false);
    expect(app.lastFrame()).toContain("1 review running");
  });

  test("v then y approves and refreshes; v then n doesn't", async () => {
    const load = vi.fn(async () => queue);
    const app = setup(load);
    cleanup = app.unmount;
    await tick();
    await press(app, "v");
    expect(app.lastFrame()).toContain("Approve acme/api#1? y/n");
    await press(app, "n");
    expect(app.actions.approve).not.toHaveBeenCalled();

    await press(app, "v", "y");
    expect(app.actions.approve).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }));
    expect(app.lastFrame()).toContain("Approved PR1");
    expect(load).toHaveBeenLastCalledWith(true);
  });

  test("v on your own PR is refused", async () => {
    const app = setup(async () => result([item("PR1", "MY_PR_READY", { author: "me" })]));
    cleanup = app.unmount;
    await tick();
    await press(app, "v");
    expect(app.lastFrame()).toContain("You can't approve your own PR");
    expect(app.actions.approve).not.toHaveBeenCalled();
  });

  test("a failed approve shows the error", async () => {
    const app = setup(async () => queue, {
      approve: vi.fn(async () => {
        throw new Error("Approve failed: HTTP 422");
      }),
    });
    cleanup = app.unmount;
    await tick();
    await press(app, "v", "y");
    expect(app.lastFrame()).toContain("Approve failed: HTTP 422");
  });

  test("any key but y cancels a confirm and says so", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    await press(app, "v", "n");
    expect(app.lastFrame()).toContain("Cancelled");
  });

  test("enter on a bucket header folds it", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    await press(app, "k", "\r");
    expect(app.lastFrame()).toContain("▸ NEEDS RE-REVIEW (1)");
    expect(app.lastFrame()).not.toContain("PR PR1");
    expect(app.actions.open).not.toHaveBeenCalled();
  });

  test("] jumps to the next bucket", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    await press(app, "]", "j", "o");
    expect(app.actions.open).toHaveBeenCalledWith(expect.objectContaining({ id: "PR2" }));
  });

  test("/ filters rows as you type and esc clears without quitting", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    await press(app, "/", "P", "R", "3");
    let frame = app.lastFrame()!;
    expect(frame).toContain("PR PR3");
    expect(frame).not.toContain("PR PR1");
    expect(frame).toContain('filter "PR3" · 1 match');

    await press(app, "\r", "o");
    expect(app.actions.open).toHaveBeenCalledWith(expect.objectContaining({ id: "PR3" }));

    await press(app, "\x1b");
    frame = app.lastFrame()!;
    expect(frame).toContain("PR PR1");
    expect(frame).not.toContain("filter");
  });

  test("a filter with no matches says so", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    await press(app, "/", "z", "z");
    expect(app.lastFrame()).toContain('No PRs match "zz"');
  });
});

describe("agent switching", () => {
  test("m cycles agents, shows the active one, and new reviews use it", async () => {
    const app = setup(async () => queue, {}, null, {}, 2, [AGENTS.claude, AGENTS.gemini]);
    cleanup = app.unmount;
    await tick();
    expect(app.lastFrame()).toContain("⇄ claude");
    await press(app, "m");
    expect(app.lastFrame()).toContain("⇄ gemini");
    await press(app, "a");
    expect(app.reviewer.run).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }), AGENTS.gemini, expect.any(AbortSignal));
    await tick();
    expect(app.lastFrame()).toContain("Gemini draft ready");
    await press(app, "m", "A");
    expect(app.onHandoff).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }), AGENTS.claude);
  });

  test("a draft keeps its agent after switching", async () => {
    const saved = { prId: "PR1", headOid: "c1", createdAt: "", agent: "codex" as const, draft: DRAFT };
    const app = setup(async () => queue, {}, null, { loadDrafts: () => [saved] }, 2, [AGENTS.claude, AGENTS.codex]);
    cleanup = app.unmount;
    await tick();
    await press(app, "m", "m", "d");
    expect(app.lastFrame()).toContain("CODEX DRAFT");
  });

  test("a single agent hides the indicator and ignores m", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    await press(app, "m");
    expect(app.lastFrame()).not.toContain("⇄");
    expect(app.lastFrame()).not.toContain("Reviews now use");
  });

  test("no installed agent explains why a does nothing", async () => {
    const app = setup(async () => queue, {}, null, {}, 2, []);
    cleanup = app.unmount;
    await tick();
    await press(app, "a");
    expect(app.reviewer.run).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain("No review agent found");
  });
});

describe("agent reviews", () => {
  test("a runs a review in the background and shows the draft", async () => {
    let finish!: (d: ReviewDraft) => void;
    const app = setup(async () => queue, {}, null, { run: vi.fn(() => new Promise<ReviewDraft>((r) => (finish = r))) });
    cleanup = app.unmount;
    await tick();
    await press(app, "a");
    expect(app.reviewer.run).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }), AGENTS.claude, expect.any(AbortSignal));
    expect(app.lastFrame()).toContain("◐ claude");

    finish(DRAFT);
    await press(app, "i");
    const frame = app.lastFrame()!;
    expect(frame).toContain("✎ draft");
    expect(frame).toContain("One race in the refresh path");
    expect(app.reviewer.saveDraft).toHaveBeenCalled();
    expect(app.actions.bell).toHaveBeenCalled();
  });

  test("a finished background review announces itself", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    await press(app, "a");
    await tick();
    expect(app.lastFrame()).toContain("Claude draft ready for acme/api#1");
    expect(app.actions.bell).toHaveBeenCalledTimes(1);
  });

  test("d opens the in-TUI reader with draft first and lets you post from it", async () => {
    const saved = { prId: "PR1", headOid: "c1", createdAt: "", draft: DRAFT };
    const app = setup(async () => queue, {}, null, { loadDrafts: () => [saved] });
    cleanup = app.unmount;
    await tick();
    await press(app, "d");
    const frame = app.lastFrame()!;
    expect(frame).toContain("CLAUDE DRAFT");
    expect(frame).toContain("One race in the refresh path");
    expect(frame).toContain("PR body for PR1");

    await press(app, "p", "c");
    expect(app.reviewer.post).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }), DRAFT, "c1", "COMMENT");

    await press(app, "\x1b");
    expect(app.lastFrame()).toContain("▾ NEEDS RE-REVIEW (1)");
  });

  test("d shows full details and surfaces failures", async () => {
    const app = setup(async () => queue, {
      loadDetails: vi.fn(async () => {
        throw new Error("no pull requests found");
      }),
    });
    cleanup = app.unmount;
    await tick();
    await press(app, "d");
    expect(app.actions.loadDetails).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }), expect.any(Object));
    expect(app.lastFrame()).toContain("no pull requests found");
  });

  test("d keeps the draft visible even if GitHub details fail to load", async () => {
    const saved = { prId: "PR1", headOid: "c1", createdAt: "", draft: DRAFT };
    const app = setup(
      async () => queue,
      {
        loadDetails: vi.fn(async () => {
          throw new Error("offline");
        }),
      },
      null,
      { loadDrafts: () => [saved] },
    );
    cleanup = app.unmount;
    await tick();
    await press(app, "d");
    const frame = app.lastFrame()!;
    expect(frame).toContain("CLAUDE DRAFT");
    expect(frame).toContain("Couldn't load PR details: offline");
  });

  test("maxConcurrent queues extra reviews", async () => {
    const app = setup(async () => queue, {}, null, { run: vi.fn(() => new Promise<ReviewDraft>(() => {})) }, 1);
    cleanup = app.unmount;
    await tick();
    // Rows: header, PR1, header, PR2.
    await press(app, "a", "j", "j", "a");
    expect(app.reviewer.run).toHaveBeenCalledTimes(1);
    expect(app.lastFrame()).toContain("◌ claude queued");
  });

  test("p then p posts a pending review; p then n doesn't", async () => {
    const saved = { prId: "PR1", headOid: "c1", createdAt: "", draft: DRAFT };
    const app = setup(async () => queue, {}, null, { loadDrafts: () => [saved] });
    cleanup = app.unmount;
    await tick();
    await press(app, "p");
    expect(app.lastFrame()).toContain("Post to acme/api#1: c comment · a approve · r request changes · p pending");
    await press(app, "n");
    expect(app.reviewer.post).not.toHaveBeenCalled();

    await press(app, "p", "p");
    expect(app.reviewer.post).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }), DRAFT, "c1", "PENDING");
    expect(app.reviewer.removeDraft).toHaveBeenCalled();
    expect(app.actions.openFiles).toHaveBeenCalled();
    expect(app.lastFrame()).toContain("Pending review posted");
  });

  test("enter submits the draft's suggested verdict and doesn't open the browser", async () => {
    const saved = { prId: "PR1", headOid: "c1", createdAt: "", draft: { ...DRAFT, suggestedVerdict: "request_changes" as const } };
    const app = setup(async () => queue, {}, null, { loadDrafts: () => [saved] });
    cleanup = app.unmount;
    await tick();
    await press(app, "p");
    expect(app.lastFrame()).toContain("enter request changes");
    await press(app, "\r");
    expect(app.reviewer.post).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }), saved.draft, "c1", "REQUEST_CHANGES");
    expect(app.actions.openFiles).not.toHaveBeenCalled();
  });

  test("on your own PR, p only offers comment and pending", async () => {
    const own = result([item("PR1", "NEEDS_REREVIEW", { author: "me" })]);
    const saved = { prId: "PR1", headOid: "c1", createdAt: "", draft: { ...DRAFT, suggestedVerdict: "approve" as const } };
    const app = setup(async () => own, {}, null, { loadDrafts: () => [saved] });
    cleanup = app.unmount;
    await tick();
    await press(app, "p");
    expect(app.lastFrame()).toContain("c comment · p pending · enter comment");
    await press(app, "a");
    expect(app.reviewer.post).not.toHaveBeenCalled();
  });

  test("a failed post keeps the draft and shows the error", async () => {
    const saved = { prId: "PR1", headOid: "c1", createdAt: "", draft: DRAFT };
    const app = setup(async () => queue, {}, null, {
      loadDrafts: () => [saved],
      post: vi.fn(async () => {
        throw new Error("You already have a pending review");
      }),
    });
    cleanup = app.unmount;
    await tick();
    await press(app, "p", "c");
    expect(app.lastFrame()).toContain("You already have a pending review");
    expect(app.lastFrame()).toContain("✎ draft");
    expect(app.reviewer.removeDraft).not.toHaveBeenCalled();
  });

  test("a draft for an older head is marked stale", async () => {
    const saved = { prId: "PR1", headOid: "old", createdAt: "", draft: DRAFT };
    const app = setup(async () => queue, {}, null, { loadDrafts: () => [saved] });
    cleanup = app.unmount;
    await tick();
    expect(app.lastFrame()).toContain("✎ draft (stale)");
  });

  test("A hands off to an interactive session", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    await press(app, "A");
    expect(app.onHandoff).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }), AGENTS.claude);
  });

  test("q with a running review asks twice and aborts it", async () => {
    let signal!: AbortSignal;
    const app = setup(async () => queue, {}, null, {
      run: vi.fn((_pr, _agent, s: AbortSignal) => {
        signal = s;
        return new Promise<ReviewDraft>(() => {});
      }),
    });
    cleanup = app.unmount;
    await tick();
    await press(app, "a", "q");
    expect(app.lastFrame()).toContain("1 review running; q again to quit");
    expect(signal.aborted).toBe(false);
    await press(app, "q");
    expect(signal.aborted).toBe(true);
  });

  test("x cancels a running review", async () => {
    let signal!: AbortSignal;
    const app = setup(async () => queue, {}, null, {
      run: vi.fn((_pr, _agent, s: AbortSignal) => {
        signal = s;
        return new Promise<ReviewDraft>(() => {});
      }),
    });
    cleanup = app.unmount;
    await tick();
    await press(app, "a", "x");
    expect(signal.aborted).toBe(true);
    expect(app.lastFrame()).toContain("Review cancelled");
    expect(app.lastFrame()).not.toContain("◐ claude");
  });

  test("cancelling and restarting keeps the new run cancellable", async () => {
    const signals: AbortSignal[] = [];
    const resolvers: ((d: ReviewDraft) => void)[] = [];
    const app = setup(async () => queue, {}, null, {
      run: vi.fn((_pr, _agent, s: AbortSignal) => {
        signals.push(s);
        return new Promise<ReviewDraft>((r) => resolvers.push(r));
      }),
    });
    cleanup = app.unmount;
    await tick();
    await press(app, "a", "x", "a");
    resolvers[0]!(DRAFT);
    await tick();
    await press(app, "x");
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(true);
  });

  test("x while posting doesn't discard the in-flight post", async () => {
    const saved = { prId: "PR1", headOid: "c1", createdAt: "", draft: DRAFT };
    const app = setup(async () => queue, {}, null, {
      loadDrafts: () => [saved],
      post: vi.fn(() => new Promise<string>(() => {})),
    });
    cleanup = app.unmount;
    await tick();
    await press(app, "p", "c", "x");
    expect(app.lastFrame()).toContain("Post in progress");
    expect(app.lastFrame()).toContain("✎ posting");
    expect(app.reviewer.removeDraft).not.toHaveBeenCalled();
  });

  test("c is blocked while a review is running", async () => {
    const app = setup(async () => queue, {}, null, {
      run: vi.fn(() => new Promise<ReviewDraft>(() => {})),
    });
    cleanup = app.unmount;
    await tick();
    await press(app, "a", "c");
    expect(app.onCheckout).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain("1 review running");
  });

  test("a on a stale draft confirms and replaces it without deleting the old draft early", async () => {
    const saved = { prId: "PR1", headOid: "old", createdAt: "", draft: DRAFT };
    const app = setup(async () => queue, {}, null, { loadDrafts: () => [saved] });
    cleanup = app.unmount;
    await tick();
    expect(app.lastFrame()).toContain("✎ 1 draft");
    await press(app, "a");
    expect(app.lastFrame()).toContain("Draft is stale — re-run Claude on acme/api#1? y/n");
    await press(app, "y");
    expect(app.reviewer.removeDraft).not.toHaveBeenCalled();
    expect(app.reviewer.run).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }), AGENTS.claude, expect.any(AbortSignal));
    expect(app.reviewer.saveDraft).toHaveBeenCalled();
  });

  test("cancelling or failing a stale draft re-run restores the old draft", async () => {
    const saved = { prId: "PR1", headOid: "old", createdAt: "", draft: DRAFT };
    let rejectRun!: (err: Error) => void;
    const run = vi
      .fn()
      .mockImplementationOnce(() => new Promise<ReviewDraft>(() => {}))
      .mockImplementationOnce(() => new Promise<ReviewDraft>((_, rej) => (rejectRun = rej)));
    const app = setup(async () => queue, {}, null, { loadDrafts: () => [saved], run });
    cleanup = app.unmount;
    await tick();

    // Cancel restores the stale draft without removing it from disk.
    await press(app, "a", "y");
    expect(app.lastFrame()).toContain("◐ claude");
    await press(app, "x");
    expect(app.lastFrame()).toContain("✎ draft (stale)");
    expect(app.reviewer.removeDraft).not.toHaveBeenCalled();

    // Failure restores the stale draft and still reports the error.
    await press(app, "a", "y");
    rejectRun(new Error("agent timed out"));
    await tick();
    expect(app.lastFrame()).toContain("✎ draft (stale)");
    expect(app.lastFrame()).toContain("agent timed out");
    expect(app.reviewer.removeDraft).not.toHaveBeenCalled();
  });

  test("ctrl-d scrolls inside the details reader instead of closing it", async () => {
    const longBody = Array.from({ length: 60 }, (_, i) => `Detail line ${i + 1}`).join("\n");
    const app = setup(async () => queue, { loadDetails: vi.fn(async () => longBody) });
    cleanup = app.unmount;
    await tick();
    await press(app, "d");
    expect(app.lastFrame()).toContain("Detail line 1");
    expect(app.lastFrame()).toContain("1–18 / 60");
    await press(app, "\x04"); // ctrl-d
    expect(app.lastFrame()).toContain("10–27 / 60");
    await press(app, "d"); // plain d closes
    expect(app.lastFrame()).toContain("▾ NEEDS RE-REVIEW (1)");
  });

  test("details stays open when a draft finishes before loadDetails fails", async () => {
    let finishRun!: (d: ReviewDraft) => void;
    let failDetails!: (err: Error) => void;
    const app = setup(async () => queue, { loadDetails: vi.fn(() => new Promise<string>((_, rej) => (failDetails = rej))) }, null, {
      run: vi.fn(() => new Promise<ReviewDraft>((r) => (finishRun = r))),
    });
    cleanup = app.unmount;
    await tick();
    await press(app, "a", "d");
    expect(app.lastFrame()).toContain("Loading PR details");

    finishRun(DRAFT);
    await tick();
    failDetails(new Error("offline"));
    await tick();

    const frame = app.lastFrame()!;
    expect(frame).toContain("CLAUDE DRAFT");
    expect(frame).toContain("Couldn't load PR details: offline");
  });

  test("is:draft filter keeps a row visible while posting so the cursor doesn't jump", async () => {
    const saved1 = { prId: "PR1", headOid: "c1", createdAt: "", draft: DRAFT };
    const saved2 = { prId: "PR2", headOid: "c1", createdAt: "", draft: DRAFT };
    const app = setup(async () => queue, {}, null, {
      loadDrafts: () => [saved1, saved2],
      post: vi.fn(() => new Promise<string>(() => {})),
    });
    cleanup = app.unmount;
    await tick();
    await press(app, "/", ..."is:draft", "\r");
    await press(app, "p", "c");
    expect(app.lastFrame()).toContain("PR PR1");
    expect(app.lastFrame()).toContain("✎ posting");
    await press(app, "o");
    expect(app.actions.open).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }));
  });

  test("DetailPane strips control chars and renders multiline follow-up notes and errors on one line", () => {
    const pr = item("PR1", "NEEDS_REREVIEW");
    const draftWithMultiline: ReviewDraft = {
      summary: "ok\x1b]52;c;YWJj\x07\rfake",
      threadFollowUps: [{ thread: 1, path: "src/a.ts", status: "partial", note: "line one\nline two\nline three" }],
      comments: [],
      suggestedVerdict: "comment",
    };
    const readyPane = render(
      React.createElement(DetailPane, {
        row: { kind: "pr", pr } as Row,
        width: 80,
        height: 20,
        now: Date.now(),
        job: { status: "ready", agent: AGENTS.claude, headOid: pr.headOid, draft: draftWithMultiline },
      }),
    );
    const readyFrame = readyPane.lastFrame()!;
    expect(readyFrame).toContain("okfake");
    expect(readyFrame).not.toContain("\x1b]52");
    expect(readyFrame).toContain("src/a.ts: line one");
    expect(readyFrame).not.toContain("line two");
    readyPane.unmount();

    const failedPane = render(
      React.createElement(DetailPane, {
        row: { kind: "pr", pr } as Row,
        width: 80,
        height: 20,
        now: Date.now(),
        job: { status: "failed", agent: AGENTS.claude, pr, error: "err line 1\nerr line 2" },
      }),
    );
    const failedFrame = failedPane.lastFrame()!;
    expect(failedFrame).toContain("err line 1");
    expect(failedFrame).not.toContain("err line 2");
    failedPane.unmount();
  });

  test("esc closes the info pane without quitting", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    await press(app, "i");
    expect(app.lastFrame()).toContain("J/K scroll");
    await press(app, "\x1b");
    expect(app.lastFrame()).not.toContain("J/K scroll");
    // Still running: pressing o works.
    await press(app, "o");
    expect(app.actions.open).toHaveBeenCalled();
  });

  test("J/K bursts net out and scroll an overflowing info pane", async () => {
    const richPR = item("PR1", "NEEDS_REREVIEW", {
      allReasons: ["r1", "r2", "r3", "r4", "r5"],
      commits: [
        { oid: "1111111", headline: "Commit one", committedAt: new Date().toISOString() },
        { oid: "2222222", headline: "Commit two", committedAt: new Date().toISOString() },
        { oid: "3333333", headline: "Commit three", committedAt: new Date().toISOString() },
      ],
      commitCount: 3,
    });
    const app = setup(async () => result([richPR]));
    cleanup = app.unmount;
    await tick();
    await press(app, "i");
    expect(app.lastFrame()).toContain("more · J/K scroll · d full");
    await press(app, "JJJK");
    expect(app.lastFrame()).toContain("↑ 2");
  });

  test("filter supports ctrl-w and ctrl-u editing shortcuts", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    await press(app, "/", "a", "c", "m", "e", " ", "z", "z");
    expect(app.lastFrame()).toContain('No PRs match "acme zz"');
    await press(app, "\x17"); // ctrl-w deletes "zz"
    expect(app.lastFrame()).toContain("PR PR1");
    await press(app, "\x15"); // ctrl-u clears entire filter
    expect(app.lastFrame()).not.toContain('filter "');
  });

  test("in-flight approve shows an inline approving badge and shows non-own @author", async () => {
    let finish!: (msg: string) => void;
    const app = setup(async () => queue, {
      approve: vi.fn(() => new Promise<string>((r) => (finish = r))),
    });
    cleanup = app.unmount;
    await tick();
    expect(app.lastFrame()).toContain("@alice");
    await press(app, "v", "y");
    expect(app.lastFrame()).toContain("approving…");
    finish("Approved PR1");
    await tick();
    expect(app.lastFrame()).not.toContain("approving…");
  });

  test("? renders two-column help at 100 columns without clipping filter syntax", async () => {
    const app = setup(async () => queue, {}, null, {}, 2, [AGENTS.claude, AGENTS.gemini]);
    cleanup = app.unmount;
    await tick();
    await press(app, "?");
    const frame = app.lastFrame()!;
    expect(frame).toContain("Navigation");
    expect(frame).toContain("Actions & Reviews");
    expect(frame).toContain("filter (@author, ci:, is:draft, is:new)");
    expect(frame).toContain("post draft (works in details too)");
    expect(frame).toContain("any key to close");
  });

  test("? hides S when Claude isn't installed", async () => {
    const app = setup(async () => queue, {}, null, {}, 2, [AGENTS.gemini]);
    cleanup = app.unmount;
    await tick();
    await press(app, "?");
    expect(app.lastFrame()!).not.toContain("/steward");
  });

  test("? scrolls cleanly at 80x24 with two agents", async () => {
    const app = setup(async () => queue, {}, null, {}, 2, [AGENTS.claude, AGENTS.gemini]);
    cleanup = app.unmount;
    await tick();
    Object.defineProperty(app.stdout, "columns", { value: 80, configurable: true });
    Object.defineProperty(app.stdout, "rows", { value: 24, configurable: true });
    app.stdout.emit("resize");
    await tick();
    await press(app, "?");
    let frame = app.lastFrame()!;
    expect(frame).toContain("move (or scroll in details)");
    expect(frame).toContain("half page / full page");
    expect(frame).toContain("↓ 3 more · j/k scroll · any other key to close");
    expect(frame.split("\n").length).toBeLessThanOrEqual(24);
    await press(app, "j", "j", "j");
    frame = app.lastFrame()!;
    expect(frame).toContain("cancel review or discard draft");
    expect(frame).toContain("↑ 3 · j/k scroll · any other key to close");
    await press(app, "q");
    expect(app.lastFrame()).toContain("▾ NEEDS RE-REVIEW (1)");
  });

  test("showDetailByDefault auto stays closed at 120 columns and opens at 180", async () => {
    const renderAtWidth = async (columns: number) => {
      const frames: string[] = [];
      const stdout = Object.assign(new EventEmitter(), {
        columns,
        rows: 24,
        isTTY: true,
        write: (chunk: string) => {
          frames.push(chunk);
          return true;
        },
      }) as unknown as NodeJS.WriteStream;
      const stdin = Object.assign(new EventEmitter(), {
        isTTY: true,
        setRawMode: () => {},
        setEncoding: () => {},
        resume: () => {},
        pause: () => {},
        ref: () => {},
        unref: () => {},
        read: () => null,
      }) as unknown as NodeJS.ReadStream;
      const instance = inkRender(
        React.createElement(App, {
          load: async () => queue,
          initial: queue,
          actions: {
            open: vi.fn(() => ""),
            openFiles: vi.fn(),
            copy: vi.fn(() => ""),
            approve: vi.fn(async () => ""),
            checkoutBlocker: vi.fn(() => null),
            loadDetails: vi.fn(async () => ""),
            loadFeedback: vi.fn(async () => NO_FEEDBACK),
            bell: vi.fn(),
          },
          reviewer: {
            run: vi.fn(async () => DRAFT),
            post: vi.fn(async () => ""),
            loadDrafts: vi.fn(() => []),
            saveDraft: vi.fn(),
            removeDraft: vi.fn(),
          },
          review: { maxConcurrent: 2, confirmBeforePosting: true },
          agents: [AGENTS.claude],
          collapseWaitingByDefault: true,
          showDetailByDefault: "auto",
          autoRefreshSeconds: 0,
          onCheckout: vi.fn(),
          onHandoff: vi.fn(),
          onFix: vi.fn(),
        }),
        { stdout, stdin, patchConsole: false, debug: true },
      );
      await tick();
      instance.unmount();
      return frames.join("");
    };

    expect(AUTO_DETAIL_MIN_COLUMNS).toBe(180);
    expect(await renderAtWidth(120)).not.toContain("J/K scroll");
    expect(await renderAtWidth(180)).toContain("J/K scroll");
  });
});
