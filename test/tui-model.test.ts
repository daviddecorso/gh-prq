import { describe, expect, test } from "vitest";
import { buildRows, restoreCursor, rowKey, scrollWindow } from "../src/tui/model.ts";
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

  test("no prior selection starts at the top", () => {
    expect(restoreCursor(null, buildRows(items, new Set()))).toBe(0);
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
