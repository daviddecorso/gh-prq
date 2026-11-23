import { EventEmitter } from "node:events";
import { constants as osConstants } from "node:os";
import { describe, expect, test, vi } from "vitest";
import { stripControlChars, wrapAnsiLines } from "../src/core/format.ts";
import { AGENTS } from "../src/core/review/agents.ts";
import { formatDraft } from "../src/tui/actions.ts";
import { runInAltScreen } from "../src/tui/altScreen.ts";
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
  test("matchesFilter checks ref, title, author, reason, badges, ci, and is:draft with multi-term AND", () => {
    const pr = item("PR1", "NEEDS_REREVIEW", {
      title: "Fix Login Draft PR",
      author: "octo",
      reason: "Draft PR",
      ciState: "FAILURE",
      badges: ["team", "draft review"],
    });
    const draft = { summary: "ok", comments: [], threadFollowUps: [], suggestedVerdict: "comment" as const };
    const draftJob = { status: "ready" as const, agent: AGENTS.claude, headOid: "c1", draft };
    const postingJob = { status: "posting" as const, agent: AGENTS.claude, headOid: "c1", draft };
    expect(matchesFilter(pr, "login")).toBe(true);
    expect(matchesFilter(pr, "@OCTO")).toBe(true);
    expect(matchesFilter(pr, `${pr.repo}#${pr.number}`)).toBe(true);
    expect(matchesFilter(pr, "acme login @octo")).toBe(true);
    expect(matchesFilter(pr, "ci:failure team")).toBe(true);
    expect(matchesFilter(pr, "is:draft", draftJob)).toBe(true);
    expect(matchesFilter(pr, "is:draft", postingJob)).toBe(true);
    expect(matchesFilter(pr, "is:draft")).toBe(false);
    expect(matchesFilter(pr, "acme logout")).toBe(false);
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
  const draft = { summary: "ok", comments: [], threadFollowUps: [], suggestedVerdict: "comment" as const };

  test("leads with help and adapts to the row", () => {
    expect(keyHints(rows[0], undefined, false)).toMatch(/^\? help {2}enter fold/);
    expect(keyHints(rows[0], undefined, true)).not.toContain("enter fold");
    expect(keyHints(rows[1], undefined, false)).toContain("a review");
    expect(keyHints(rows[1], { status: "running", agent: AGENTS.claude, pr: items[0]!, startedAt: 0 }, false)).toContain("x cancel");
    expect(keyHints(rows[1], undefined, true)).toContain("esc clear");
    expect(keyHints(rows[1], { status: "ready", agent: AGENTS.claude, headOid: "old", draft }, false)).toContain("a re-review");
    expect(keyHints(rows[1], undefined, false, { showDetail: true })).toContain("J/K scroll");
    expect(keyHints(rows[1], { status: "ready", agent: AGENTS.claude, headOid: "c1", draft }, false, { detailsOpen: true })).toMatch(
      /^esc back {2}j\/k scroll {2}p post/,
    );
    const ownRow = { kind: "pr" as const, pr: item("PR9", "MY_PR_ACTION_NEEDED") };
    expect(keyHints(ownRow, undefined, false)).toContain("f fix comments");
    expect(keyHints(ownRow, undefined, false, { detailsOpen: true })).toContain("f fix comments");
    expect(keyHints(ownRow, undefined, false, { detailsOpen: true })).not.toContain("v approve");
  });
});

describe("wrapAnsiLines", () => {
  test("wraps long lines and preserves SGR codes across breaks", () => {
    expect(wrapAnsiLines("\x1b[31mabcdefgh\x1b[0m", 4)).toEqual(["\x1b[31mabcd\x1b[0m", "\x1b[31mefgh\x1b[0m"]);
  });

  test("strips non-SGR escapes (OSC 52, CSI, DCS) and control characters including bare CR", () => {
    expect(wrapAnsiLines("a\x1b]52;c;cHdu\x07b\x1b]52;c;cHdu\x1b\\c\x1b[2Jd\rfake\x07\x1bPtmux;x\x1b\\e", 80)).toEqual(["abcdfakee"]);
    expect(wrapAnsiLines("\x1b[32mok\x1b]8;;https://evil.example\x07link\x1b]8;;\x07\x1b[0m", 80)).toEqual(["\x1b[32moklink\x1b[0m"]);
  });
});

describe("stripControlChars and formatDraft", () => {
  test("strips all escapes and control characters while keeping newlines and tabs", () => {
    expect(stripControlChars("\x1b[31mhi\x1b[0m\x1b]52;c;YWJj\x07\rfake\r\n\tok\x07")).toBe("hifake\n\tok");
  });

  test("formatDraft strips untrusted escapes and bare CR from draft text", () => {
    const out = formatDraft({
      agent: AGENTS.claude,
      draft: {
        summary: "ok\x1b]52;c;YWJj\x07\rfake",
        threadFollowUps: [{ thread: 1, path: "a\x1b[2J.ts", status: "addressed", note: "done\rspoof\x1b]52;c;YQ==\x07" }],
        comments: [{ path: "b\r.ts", line: 1, side: "RIGHT", body: "fix\x1b]52;c;Yg==\x1b\\\x1b[8mhidden\x1b[0m" }],
        suggestedVerdict: "comment",
      },
    });
    expect(out).not.toContain("\x1b]52");
    expect(out).not.toContain("\x1b[2J");
    expect(out).not.toContain("\x1b[8m");
    expect(out).not.toContain("\r");
    expect(out).toContain("okfake");
    expect(out).toContain("a.ts: donespoof");
    expect(out).toContain("fixhidden");
  });
});

describe("runInAltScreen", () => {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(`restores the terminal, unmounts, and exits 128+n on ${sig}`, async () => {
      const proc = new EventEmitter();
      const writes: string[] = [];
      const unmount = vi.fn();
      const exit = vi.fn();
      let resolveExit!: () => void;

      const done = runInAltScreen(
        () => ({ unmount, waitUntilExit: () => new Promise<void>((r) => (resolveExit = r)) }),
        { stdout: { write: (s: string) => writes.push(s) }, proc: proc as unknown as NodeJS.Process, exit },
      );

      proc.emit(sig);
      expect(unmount).toHaveBeenCalledTimes(1);
      expect(writes).toEqual(["\x1b[?1049h\x1b[H", "\x1b[?1049l"]);
      expect(exit).toHaveBeenCalledWith(128 + osConstants.signals[sig]);
      expect(proc.listenerCount("SIGINT")).toBe(0);
      expect(proc.listenerCount("SIGTERM")).toBe(0);
      expect(proc.listenerCount("SIGHUP")).toBe(0);

      resolveExit();
      await done;
      expect(writes).toEqual(["\x1b[?1049h\x1b[H", "\x1b[?1049l"]);
    });
  }

  test("leaves alt screen and removes signal handlers on normal exit", async () => {
    const proc = new EventEmitter();
    const writes: string[] = [];
    await runInAltScreen(() => ({ unmount: vi.fn(), waitUntilExit: async () => {} }), {
      stdout: { write: (s: string) => writes.push(s) },
      proc: proc as unknown as NodeJS.Process,
      exit: vi.fn(),
    });
    expect(writes).toEqual(["\x1b[?1049h\x1b[H", "\x1b[?1049l"]);
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    expect(proc.listenerCount("SIGHUP")).toBe(0);
    expect(proc.listenerCount("exit")).toBe(0);
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
