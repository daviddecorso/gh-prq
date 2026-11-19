import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ClassifiedPR, QueueResult } from "../src/core/types.ts";
import type { ReviewDraft } from "../src/core/review/schema.ts";
import type { Actions } from "../src/tui/actions.ts";
import { App } from "../src/tui/App.ts";
import { DetailPane } from "../src/tui/DetailPane.ts";
import type { Row } from "../src/tui/model.ts";
import type { Reviewer } from "../src/tui/useReviews.ts";
import { item, result } from "./fixtures.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

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
) {
  const actions: Actions = {
    open: vi.fn((pr: ClassifiedPR) => `Opened ${pr.id}`),
    openFiles: vi.fn(),
    copy: vi.fn((pr: ClassifiedPR) => `Copied ${pr.id}`),
    approve: vi.fn(async (pr: ClassifiedPR) => `Approved ${pr.id}`),
    checkoutBlocker: vi.fn(() => null),
    viewDetails: vi.fn(() => null),
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
  const app = render(
    React.createElement(App, {
      load,
      initial,
      actions,
      reviewer,
      claude: { maxConcurrent, confirmBeforePosting: true },
      collapseWaitingByDefault: true,
      autoRefreshSeconds: 0,
      onCheckout,
      onHandoff,
    }),
  );
  return { ...app, actions, reviewer, onCheckout, onHandoff };
}

async function press(app: { stdin: { write(s: string): void } }, ...keys: string[]) {
  for (const key of keys) {
    app.stdin.write(key);
    await tick();
  }
}

const queue = result([
  item("PR1", "NEEDS_REREVIEW"),
  item("PR2", "NEEDS_INITIAL_REVIEW"),
  item("PR3", "WAITING_ON_AUTHOR"),
]);

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

describe("Claude reviews", () => {
  test("a runs a review in the background and shows the draft", async () => {
    let finish!: (d: ReviewDraft) => void;
    const app = setup(async () => queue, {}, null, { run: vi.fn(() => new Promise<ReviewDraft>((r) => (finish = r))) });
    cleanup = app.unmount;
    await tick();
    await press(app, "a");
    expect(app.reviewer.run).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }), expect.any(AbortSignal));
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

  test("d pages the draft along with the details when one exists", async () => {
    const saved = { prId: "PR1", headOid: "c1", createdAt: "", draft: DRAFT };
    const app = setup(async () => queue, {}, null, { loadDrafts: () => [saved] });
    cleanup = app.unmount;
    await tick();
    await press(app, "d");
    expect(app.actions.viewDetails).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }), DRAFT);
  });

  test("d shows full details and surfaces failures", async () => {
    const app = setup(async () => queue, { viewDetails: vi.fn(() => "no pull requests found") });
    cleanup = app.unmount;
    await tick();
    await press(app, "d");
    expect(app.actions.viewDetails).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }));
    expect(app.lastFrame()).toContain("no pull requests found");
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

  test("p then y posts the draft; p then n doesn't", async () => {
    const saved = { prId: "PR1", headOid: "c1", createdAt: "", draft: DRAFT };
    const app = setup(async () => queue, {}, null, { loadDrafts: () => [saved] });
    cleanup = app.unmount;
    await tick();
    await press(app, "p");
    expect(app.lastFrame()).toContain("Post a pending review on acme/api#1? y/n");
    await press(app, "n");
    expect(app.reviewer.post).not.toHaveBeenCalled();

    await press(app, "p", "y");
    expect(app.reviewer.post).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }), DRAFT, "c1");
    expect(app.reviewer.removeDraft).toHaveBeenCalled();
    expect(app.actions.openFiles).toHaveBeenCalled();
    expect(app.lastFrame()).toContain("Pending review posted");
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
    await press(app, "p", "y");
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
    expect(app.onHandoff).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }));
  });

  test("q with a running review asks twice and aborts it", async () => {
    let signal!: AbortSignal;
    const app = setup(async () => queue, {}, null, {
      run: vi.fn((_pr, s: AbortSignal) => {
        signal = s;
        return new Promise<ReviewDraft>(() => {});
      }),
    });
    cleanup = app.unmount;
    await tick();
    await press(app, "a", "q");
    expect(app.lastFrame()).toContain("1 Claude review running; q again to quit");
    expect(signal.aborted).toBe(false);
    await press(app, "q");
    expect(signal.aborted).toBe(true);
  });

  test("x cancels a running review", async () => {
    let signal!: AbortSignal;
    const app = setup(async () => queue, {}, null, {
      run: vi.fn((_pr, s: AbortSignal) => {
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
      run: vi.fn((_pr, s: AbortSignal) => {
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
    await press(app, "p", "y", "x");
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
    expect(app.lastFrame()).toContain("1 Claude review running");
  });
});
