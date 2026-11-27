import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { filterItems } from "../src/cli/filter.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import { fileSnoozeStore, isSnoozed, pruneSnoozes, snoozeEntry } from "../src/core/snooze.ts";
import { item, NOW, result } from "./fixtures.ts";

const DAY = 24 * 60 * 60 * 1000;
const pr = item("PR1", "NEEDS_REREVIEW");
const snoozes = { PR1: snoozeEntry(pr, NOW) };

describe("isSnoozed", () => {
  test("holds while nothing changes", () => {
    expect(isSnoozed(pr, snoozes, NOW + DAY)).toBe(true);
  });

  test.each([
    ["bucket", { bucket: "NEEDS_INITIAL_REVIEW" as const }],
    ["activity time", { actionSince: new Date(NOW + DAY).toISOString() }],
    ["head commit", { headOid: "c2" }],
  ])("ends when the %s changes", (_, change) => {
    expect(isSnoozed({ ...pr, ...change }, snoozes, NOW)).toBe(false);
  });

  test("expires after 30 days", () => {
    expect(isSnoozed(pr, snoozes, NOW + 30 * DAY)).toBe(false);
  });
});

describe("pruneSnoozes", () => {
  test("drops changed and expired entries but keeps PRs outside the result", () => {
    const other = item("PR2", "NEEDS_REREVIEW");
    const gone = item("PR3", "NEEDS_REREVIEW");
    const all = { PR1: snoozeEntry(pr, NOW), PR2: snoozeEntry(other, NOW - 31 * DAY), PR3: snoozeEntry(gone, NOW) };
    expect(Object.keys(pruneSnoozes(all, [{ ...pr, headOid: "c2" }, other], NOW))).toEqual(["PR3"]);
  });
});

describe("filterItems", () => {
  test("hides snoozed PRs unless --all", () => {
    const queue = result([pr, item("PR2", "NEEDS_INITIAL_REVIEW")]);
    const live = { PR1: snoozeEntry(pr) };
    expect(filterItems(queue, {}, DEFAULT_CONFIG, live).map((p) => p.id)).toEqual(["PR2"]);
    expect(filterItems(queue, { all: true }, DEFAULT_CONFIG, live)).toHaveLength(2);
  });
});

describe("fileSnoozeStore", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("round-trips through the cache dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-prq-snooze-"));
    try {
      vi.stubEnv("XDG_CACHE_HOME", dir);
      expect(fileSnoozeStore.load()).toEqual({});
      fileSnoozeStore.save(snoozes);
      expect(fileSnoozeStore.load()).toEqual(snoozes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignores non-object JSON in snoozed.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-prq-snooze-"));
    try {
      vi.stubEnv("XDG_CACHE_HOME", dir);
      mkdirSync(join(dir, "gh-prq"), { recursive: true });
      for (const content of ["null", "[]", '"bad"']) {
        writeFileSync(join(dir, "gh-prq", "snoozed.json"), content);
        expect(fileSnoozeStore.load()).toEqual({});
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
