import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import type { RunOptions, RunResult } from "../src/core/exec.ts";
import { postDraft, toReviewPayload } from "../src/core/review/post.ts";
import { buildReviewPrompt } from "../src/core/review/prompt.ts";
import { ALLOWED_TOOLS, runHeadlessReview } from "../src/core/review/runner.ts";
import type { ReviewDraft } from "../src/core/review/schema.ts";
import { prepareWorkspace, resolveDelta, type Workspace } from "../src/core/review/workspace.ts";
import type { ClassifiedPR } from "../src/core/types.ts";
import { item } from "./fixtures.ts";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr });

/** Fake runner: the first matching [cmd, argsPrefix] answers; everything else exits 1. */
function fakeExec(routes: [string, string[], RunResult | ((args: string[], opts?: RunOptions) => RunResult)][]) {
  return vi.fn(async (cmd: string, args: string[], opts?: RunOptions) => {
    for (const [c, prefix, res] of routes) {
      if (c === cmd && prefix.every((p, i) => args[i] === p)) return typeof res === "function" ? res(args, opts) : res;
    }
    return fail(`unexpected ${cmd} ${args.join(" ")}`);
  });
}

const DRAFT: ReviewDraft = {
  summary: "Mostly good.",
  comments: [{ path: "src/a.ts", line: 10, side: "RIGHT", body: "We leak the timer here." }],
  threadFollowUps: [{ thread: 1, path: "src/b.ts", status: "addressed", note: "Now awaits the lock." }],
  suggestedVerdict: "comment",
};

type ReReviewPR = ClassifiedPR & { lastReviewedCommitOid: string };

const reReview = item("PR7", "NEEDS_REREVIEW", {
  lastReviewedCommitOid: "old1234567",
  headOid: "new1234567",
  viewerThreads: [
    {
      path: "src/b.ts",
      isOutdated: true,
      comments: [
        { author: "me", body: "This races with refresh.", createdAt: "" },
        { author: "alice", body: "Fixed in the latest push.", createdAt: "" },
      ],
    },
  ],
}) as ReReviewPR;

let dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-prq-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("buildReviewPrompt", () => {
  test("initial review points at the full diff", () => {
    const { prompt } = buildReviewPrompt(item("PR1", "NEEDS_INITIAL_REVIEW"), { local: false });
    expect(prompt).toContain("gh pr diff https://github.com/acme/api/pull/1");
    expect(prompt).toContain("no local checkout");
    expect(prompt).not.toContain("re-review");
  });

  test("re-review points at the delta and inlines the viewer's threads", () => {
    const { prompt } = buildReviewPrompt(reReview, { local: true, delta: { kind: "diff", path: "/tmp/x/since.diff" } });
    expect(prompt).toContain("last reviewed old1234");
    expect(prompt).toContain("/tmp/x/since.diff");
    expect(prompt).toContain("detached checkout");
    expect(prompt).toContain("1. src/b.ts (outdated)");
    expect(prompt).toContain("@alice: Fixed in the latest push.");
    expect(prompt).toContain("threadFollowUps");
  });

  test("an unreachable old commit falls back to the full diff", () => {
    const { prompt } = buildReviewPrompt(reReview, { local: false, delta: { kind: "unreachable" } });
    expect(prompt).toContain("force-push");
    expect(prompt).toContain("gh pr diff");
  });

  test("interactive prompts don't ask for structured output", () => {
    const { prompt } = buildReviewPrompt(reReview, { local: false, delta: { kind: "no-new-commits" } }, { interactive: true });
    expect(prompt).toContain("no new commits");
    expect(prompt).not.toContain("threadFollowUps");
    expect(prompt).toContain("Don't post anything");
  });
});

describe("resolveDelta", () => {
  test("uses local git when the old commit exists", async () => {
    const dir = tempDir();
    const exec = fakeExec([
      ["git", ["cat-file"], ok()],
      ["git", ["diff", "old1234567", "new1234567"], ok("LOCAL DIFF")],
    ]);
    const delta = await resolveDelta(reReview, dir, "/wt", exec);
    expect(delta.kind).toBe("diff");
    expect(readFileSync((delta as { path: string }).path, "utf8")).toBe("LOCAL DIFF");
  });

  test("falls back to the compare API, then to unreachable", async () => {
    const dir = tempDir();
    const compare = fakeExec([
      ["git", ["cat-file"], fail("missing")],
      ["gh", ["api"], ok("REMOTE DIFF")],
    ]);
    const delta = await resolveDelta(reReview, dir, "/wt", compare);
    expect(readFileSync((delta as { path: string }).path, "utf8")).toBe("REMOTE DIFF");
    expect(compare).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["repos/acme/api/compare/old1234567...new1234567"]),
      expect.any(Object),
    );

    expect(await resolveDelta(reReview, dir, null, fakeExec([]))).toEqual({ kind: "unreachable" });
  });

  test("no new commits skips the diff", async () => {
    const pr = { ...reReview, headOid: "old1234567" };
    expect(await resolveDelta(pr, tempDir(), null, fakeExec([]))).toEqual({ kind: "no-new-commits" });
  });
});

describe("prepareWorkspace", () => {
  test("uses a worktree when the cwd has the repo and cleans up both dirs", async () => {
    const wtCleanup = vi.fn();
    const ws = await prepareWorkspace(item("PR1", "NEEDS_INITIAL_REVIEW"), {
      exec: fakeExec([]),
      remoteForRepo: () => "origin",
      createWorktree: vi.fn(async () => ({ dir: "/wt", cleanup: wtCleanup })),
    });
    expect(ws).toMatchObject({ cwd: "/wt", local: true, delta: undefined });
    expect(existsSync(ws.contextDir)).toBe(true);
    ws.cleanup();
    expect(wtCleanup).toHaveBeenCalled();
    expect(existsSync(ws.contextDir)).toBe(false);
  });

  test("diff-only when the repo isn't local", async () => {
    const createWorktree = vi.fn();
    const ws = await prepareWorkspace(item("PR1", "NEEDS_INITIAL_REVIEW"), {
      exec: fakeExec([]),
      remoteForRepo: () => null,
      createWorktree,
    });
    expect(ws.local).toBe(false);
    expect(ws.cwd).toBe(ws.contextDir);
    expect(createWorktree).not.toHaveBeenCalled();
    ws.cleanup();
  });
});

describe("runHeadlessReview", () => {
  const workspace = () => ({ cwd: "/wt", contextDir: "/ctx", local: true, cleanup: vi.fn<() => void>() }) satisfies Workspace;

  test("runs claude read-only in the workspace and parses structured output", async () => {
    const ws = workspace();
    const exec = fakeExec([["claude", ["-p"], ok(JSON.stringify({ is_error: false, structured_output: DRAFT }))]]);
    const draft = await runHeadlessReview(item("PR1", "NEEDS_INITIAL_REVIEW"), DEFAULT_CONFIG, { exec, prepare: async () => ws });

    expect(draft).toEqual(DRAFT);
    const [, args, opts] = exec.mock.calls[0]!;
    expect(opts?.cwd).toBe("/wt");
    expect(args).toEqual(expect.arrayContaining(["--model", "sonnet", "--json-schema", "--add-dir", "/ctx"]));
    expect(args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"))).toEqual(ALLOWED_TOOLS);
    expect(args.slice(args.indexOf("--disallowedTools") + 1)).toEqual(["Edit", "Write", "NotebookEdit"]);
    expect(args.join(" ")).not.toContain("gh api");
    expect(ws.cleanup).toHaveBeenCalled();
  });

  test("surfaces claude errors and still cleans up", async () => {
    const ws = workspace();
    const exec = fakeExec([["claude", ["-p"], { code: 1, stdout: JSON.stringify({ is_error: true, result: "rate limited" }), stderr: "" }]]);
    await expect(
      runHeadlessReview(item("PR1", "NEEDS_INITIAL_REVIEW"), DEFAULT_CONFIG, { exec, prepare: async () => ws }),
    ).rejects.toThrow("claude failed: rate limited");
    expect(ws.cleanup).toHaveBeenCalled();
  });

  test("an aborted signal skips claude and cleans up", async () => {
    const ws = workspace();
    const exec = fakeExec([]);
    const prepare = vi.fn(async () => ws);
    const controller = new AbortController();
    controller.abort();
    await expect(
      runHeadlessReview(item("PR1", "NEEDS_INITIAL_REVIEW"), DEFAULT_CONFIG, {
        exec,
        prepare,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(prepare).toHaveBeenCalledWith(expect.anything(), controller.signal);
    expect(exec).not.toHaveBeenCalled();
    expect(ws.cleanup).toHaveBeenCalled();
  });
});

describe("posting", () => {
  const pr = item("PR7", "NEEDS_REREVIEW", { headOid: "abc" });

  test("payload is a pending review on the head commit with a follow-up checklist", () => {
    const payload = toReviewPayload(DRAFT, pr);
    expect(payload).not.toHaveProperty("event");
    expect(payload.commit_id).toBe("abc");
    expect(payload.comments).toEqual([{ path: "src/a.ts", line: 10, side: "RIGHT", body: "We leak the timer here." }]);
    expect(payload.body).toContain("- [x] `src/b.ts`: Now awaits the lock.");
  });

  test("uses the draft's commitId when posting a stale draft", async () => {
    let body: unknown;
    const exec = fakeExec([
      [
        "gh",
        ["api"],
        (_args, opts) => {
          body = JSON.parse(opts!.input!);
          return ok("{}");
        },
      ],
    ]);
    await postDraft(pr, DRAFT, exec, "older-sha");
    expect(body).toMatchObject({ commit_id: "older-sha" });
  });

  test("a 422 retries with the comments folded into the body", async () => {
    const bodies: unknown[] = [];
    let calls = 0;
    const exec = fakeExec([
      [
        "gh",
        ["api"],
        (_args, opts) => {
          bodies.push(JSON.parse(opts!.input!));
          return calls++ === 0 ? fail("gh: Unprocessable Entity (HTTP 422)") : ok("{}");
        },
      ],
    ]);
    const status = await postDraft(pr, DRAFT, exec);
    expect(status).toContain("comments moved into the body");
    expect(bodies[1]).toMatchObject({ comments: [] });
    expect((bodies[1] as { body: string }).body).toContain("`src/a.ts:10`: We leak the timer here.");
  });

  test("an existing pending review is reported, not retried", async () => {
    const exec = fakeExec([["gh", ["api"], fail("User can only have one pending review per pull request (HTTP 422)")]]);
    await expect(postDraft(pr, DRAFT, exec)).rejects.toThrow("already have a pending review");
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
