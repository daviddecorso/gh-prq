import { describe, expect, test } from "vitest";
import { adjacentHeader, buildRows, keyHints, matchesFilter, restoreCursor, rowKey, scrollWindow } from "../src/tui/model.ts";
import { item } from "./fixtures.ts";

const items = [
  item("PR1", "NEEDS_REREVIEW"),
  item("PR2", "NEEDS_REREVIEW"),
  item("PR3", "WAITING_ON_AUTHOR"),
];

describe("buildRows", () => {
  test("headers in bucket order with their PRs", () => {
    expect(buildRows(items, new Set()).map(rowKey)).toEqual(["h:NEEDS_REREVIEW", "pr:PR1", "pr:PR2", "h:WAITING_ON_AUTHOR", "pr:PR3"]);
  });

  test("collapsed buckets keep the header and count but hide PRs", () => {
    const rows = buildRows(items, new Set(["WAITING_ON_AUTHOR"]));
    expect(rows.map(rowKey)).toEqual(["h:NEEDS_REREVIEW", "pr:PR1", "pr:PR2", "h:WAITING_ON_AUTHOR"]);
    expect(rows.at(-1)).toMatchObject({ kind: "header", count: 1, collapsed: true });
  });
});

describe("restoreCursor", () => {
  test("follows the selected PR when it moves", () => {
    const moved = [item("PR2", "NEEDS_REREVIEW"), item("PR1", "WAITING_ON_AUTHOR")];
    const rows = buildRows(moved, new Set());
    expect(rowKey(rows[restoreCursor({ key: "pr:PR1", index: 1 }, rows)]!)).toBe("pr:PR1");
  });

  test("stays at the same index, clamped, when the PR is gone", () => {
    const rows = buildRows([item("PR2", "NEEDS_REREVIEW")], new Set());
    expect(restoreCursor({ key: "pr:PR9", index: 1 }, rows)).toBe(1);
    expect(restoreCursor({ key: "pr:PR9", index: 7 }, rows)).toBe(1);
  });

  test("no prior selection starts on the first PR", () => {
    expect(restoreCursor(null, buildRows(items, new Set()))).toBe(1);
  });

  test("a null index falls back to the first PR when the key is gone", () => {
    const rows = buildRows(items, new Set(), "PR3");
    expect(rowKey(rows[restoreCursor({ key: "pr:PR1", index: null }, rows)]!)).toBe("pr:PR3");
  });
});

describe("filtering", () => {
  test("matchesFilter checks ref, title, and author case-insensitively", () => {
    const pr = item("PR1", "NEEDS_REREVIEW", { title: "Fix Login", author: "octo" });
    expect(matchesFilter(pr, "login")).toBe(true);
    expect(matchesFilter(pr, "@OCTO")).toBe(true);
    expect(matchesFilter(pr, `${pr.repo}#${pr.number}`)).toBe(true);
    expect(matchesFilter(pr, "logout")).toBe(false);
  });

  test("a query expands collapsed buckets and drops empty ones", () => {
    const rows = buildRows(items, new Set(["WAITING_ON_AUTHOR"]), "PR3");
    expect(rows.map(rowKey)).toEqual(["h:WAITING_ON_AUTHOR", "pr:PR3"]);
    expect(rows[0]).toMatchObject({ collapsed: false, count: 1 });
  });
});

describe("adjacentHeader", () => {
  const rows = buildRows(items, new Set());

  test("jumps to the next and previous headers", () => {
    expect(adjacentHeader(rows, 1, 1)).toBe(3);
    expect(adjacentHeader(rows, 4, -1)).toBe(3);
    expect(adjacentHeader(rows, 3, -1)).toBe(0);
  });

  test("stays put past the last header", () => {
    expect(adjacentHeader(rows, 4, 1)).toBe(4);
  });
});

describe("keyHints", () => {
  const rows = buildRows(items, new Set());

  test("leads with help and adapts to the row", () => {
    expect(keyHints(rows[0], undefined, false)).toMatch(/^\? help {2}enter fold/);
    expect(keyHints(rows[0], undefined, true)).not.toContain("enter fold");
    expect(keyHints(rows[1], undefined, false)).toContain("a claude");
    expect(keyHints(rows[1], { status: "running", pr: items[0]!, startedAt: 0 }, false)).toContain("x cancel");
    expect(keyHints(rows[1], undefined, true)).toContain("esc clear");
  });
});

describe("scrollWindow", () => {
  test("doesn't scroll while the cursor is visible", () => {
    expect(scrollWindow(3, 20, 5, 0)).toBe(0);
    expect(scrollWindow(6, 20, 5, 4)).toBe(4);
  });

  test("scrolls just enough to reveal the cursor", () => {
    expect(scrollWindow(5, 20, 5, 0)).toBe(1);
    expect(scrollWindow(2, 20, 5, 4)).toBe(2);
  });

  test("never scrolls past the end", () => {
    expect(scrollWindow(19, 20, 5, 30)).toBe(15);
    expect(scrollWindow(1, 3, 5, 2)).toBe(0);
  });
});
