import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ClassifiedPR, QueueResult } from "../src/core/types.ts";
import type { Actions } from "../src/tui/actions.ts";
import { App } from "../src/tui/App.ts";
import { item, result } from "./fixtures.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function setup(
  load: (refresh: boolean) => Promise<QueueResult>,
  actionOverrides: Partial<Actions> = {},
  initial: QueueResult | null = null,
) {
  const actions: Actions = {
    open: vi.fn((pr: ClassifiedPR) => `Opened ${pr.id}`),
    copy: vi.fn((pr: ClassifiedPR) => `Copied ${pr.id}`),
    checkoutBlocker: vi.fn(() => null),
    ...actionOverrides,
  };
  const onCheckout = vi.fn();
  const app = render(
    React.createElement(App, { load, initial, actions, collapseWaitingByDefault: true, autoRefreshSeconds: 0, onCheckout }),
  );
  return { ...app, actions, onCheckout };
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

  test("j then o opens the selected PR", async () => {
    const app = setup(async () => queue);
    cleanup = app.unmount;
    await tick();
    app.stdin.write("j");
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
    app.stdin.write("jjjjk");
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
    app.stdin.write("j");
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
    app.stdin.write("j");
    await tick();
    app.stdin.write("c");
    await tick();
    expect(app.onCheckout).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1" }));
  });
});
