import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import type { RunOptions, RunResult } from "../src/core/exec.ts";
import { markReady, mergePR, rerequestReviews } from "../src/core/prActions.ts";
import { AGENTS, ALLOWED_TOOLS, availableAgents, extractJson } from "../src/core/review/agents.ts";
import { fileDraftStore } from "../src/core/review/drafts.ts";
import { approvePR, postDraft, toReviewPayload } from "../src/core/review/post.ts";
import { buildCodeReviewPrompt, buildReviewPrompt } from "../src/core/review/prompt.ts";
import { agentRun, runHeadlessReview } from "../src/core/review/runner.ts";
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
    const { prompt } = buildReviewPrompt(reReview, { local: true, delta: { kind: "diff", path: "/tmp/x/since.diff", local: true } });
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

  test("a written diff file replaces gh pr diff", () => {
    const { prompt } = buildReviewPrompt(item("PR1", "NEEDS_INITIAL_REVIEW"), { local: false, diffPath: "/ctx/pr.diff" });
    expect(prompt).toContain("The PR diff is in /ctx/pr.diff");
    expect(prompt).not.toContain("gh pr diff");
  });

  test("inlineSchema asks for bare JSON in headless runs only", () => {
    const pr = item("PR1", "NEEDS_INITIAL_REVIEW");
    expect(buildReviewPrompt(pr, { local: true }, { inlineSchema: true }).prompt).toContain('"suggestedVerdict"');
    expect(buildReviewPrompt(pr, { local: true }, { inlineSchema: true, interactive: true }).prompt).not.toContain('"suggestedVerdict"');
  });

  test("interactive prompts don't ask for structured output", () => {
    const { prompt } = buildReviewPrompt(reReview, { local: false, delta: { kind: "no-new-commits" } }, { interactive: true });
    expect(prompt).toContain("no new commits");
    expect(prompt).not.toContain("threadFollowUps");
    expect(prompt).toContain("Don't post anything");
  });
});

describe("buildCodeReviewPrompt", () => {
  test("first review targets the PR URL", () => {
    const { prompt } = buildCodeReviewPrompt(item("PR1", "NEEDS_INITIAL_REVIEW"), { local: true }, "high");
    expect(prompt).toBe("/code-review high https://github.com/acme/api/pull/1");
  });

  test("local re-review targets the commit range and carries threads in the system prompt", () => {
    const { prompt, appendSystemPrompt } = buildCodeReviewPrompt(reReview, {
      local: true,
      delta: { kind: "diff", path: "/tmp/x/since.diff", local: true },
    });
    expect(prompt).toBe("/code-review old1234567..new1234567");
    expect(appendSystemPrompt).toContain("last reviewed old1234");
    expect(appendSystemPrompt).toContain("@alice: Fixed in the latest push.");
    expect(appendSystemPrompt).toContain("Don't post anything to GitHub.");
  });

  test("local checkout with an API-fallback delta targets the URL and points at the delta file", () => {
    const { prompt, appendSystemPrompt } = buildCodeReviewPrompt(reReview, {
      local: true,
      delta: { kind: "diff", path: "/tmp/x/since.diff", local: false },
    });
    expect(prompt).toBe(`/code-review ${reReview.url}`);
    expect(appendSystemPrompt).toContain("/tmp/x/since.diff");
  });

  test("re-review without a checkout targets the URL and points at the delta file", () => {
    const { prompt, appendSystemPrompt } = buildCodeReviewPrompt(reReview, {
      local: false,
      delta: { kind: "diff", path: "/tmp/x/since.diff", local: false },
    });
    expect(prompt).toBe(`/code-review ${reReview.url}`);
    expect(appendSystemPrompt).toContain("/tmp/x/since.diff");
  });
});

describe("agentRun", () => {
  const ws: Workspace = { cwd: "/wt", contextDir: "/ctx", local: true, cleanup: () => {} };
  const pr = item("PR1", "NEEDS_INITIAL_REVIEW");

  test("interactive Claude uses /code-review, headless and other agents keep our prompt", () => {
    expect(agentRun(pr, AGENTS.claude, DEFAULT_CONFIG, ws, true).prompt).toMatch(/^\/code-review /);
    expect(agentRun(pr, AGENTS.claude, DEFAULT_CONFIG, ws).prompt).toMatch(/^Review /);
    expect(agentRun(pr, AGENTS.gemini, DEFAULT_CONFIG, ws, true).prompt).toMatch(/^Review /);
  });

  test("no-new-commits re-review keeps our prompt instead of running /code-review", () => {
    const noNew: Workspace = { ...ws, delta: { kind: "no-new-commits" } };
    expect(agentRun(reReview, AGENTS.claude, DEFAULT_CONFIG, noNew, true).prompt).toMatch(/^Review /);
  });

  test("claudeBuiltins off keeps our prompt", () => {
    const config = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, claudeBuiltins: false } };
    expect(agentRun(pr, AGENTS.claude, config, ws, true).prompt).toMatch(/^Review /);
  });

  test("interactive Claude may use skills and subagents but not edit", () => {
    const args = AGENTS.claude.interactive(agentRun(pr, AGENTS.claude, DEFAULT_CONFIG, ws, true));
    expect(args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"))).toEqual([...ALLOWED_TOOLS, "Skill", "Agent"]);
    expect(args.slice(args.indexOf("--disallowedTools") + 1)).toEqual(["Edit", "Write", "NotebookEdit"]);
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
    expect(delta).toMatchObject({ kind: "diff", local: true });
    expect(readFileSync((delta as { path: string }).path, "utf8")).toBe("LOCAL DIFF");
  });

  test("falls back to the compare API, then to unreachable", async () => {
    const dir = tempDir();
    const compare = fakeExec([
      ["git", ["cat-file"], fail("missing")],
      ["gh", ["api"], ok("REMOTE DIFF")],
    ]);
    const delta = await resolveDelta(reReview, dir, "/wt", compare);
    expect(delta).toMatchObject({ kind: "diff", local: false });
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

  test("writeDiff saves the full PR diff into the context dir", async () => {
    const ws = await prepareWorkspace(
      item("PR1", "NEEDS_INITIAL_REVIEW"),
      { exec: fakeExec([["gh", ["pr", "diff"], ok("FULL DIFF")]]), remoteForRepo: () => null, createWorktree: vi.fn() },
      undefined,
      { writeDiff: true },
    );
    expect(readFileSync(ws.diffPath!, "utf8")).toBe("FULL DIFF");
    ws.cleanup();
  });

  test("a failed diff fetch cleans up and throws", async () => {
    await expect(
      prepareWorkspace(
        item("PR1", "NEEDS_INITIAL_REVIEW"),
        { exec: fakeExec([]), remoteForRepo: () => null, createWorktree: vi.fn() },
        undefined,
        { writeDiff: true },
      ),
    ).rejects.toThrow("Couldn't fetch the PR diff");
  });
});

describe("agents", () => {
  test("extractJson handles bare, fenced, and wrapped replies", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n{"a":1}\nDone.')).toEqual({ a: 1 });
    expect(() => extractJson("no json here")).toThrow("wasn't valid JSON");
  });

  test("availableAgents lists installed agents with the preferred one first", () => {
    const installed = (bin: string) => bin !== "claude";
    expect(availableAgents("codex", installed).map((a) => a.id)).toEqual(["codex", "gemini"]);
    expect(availableAgents("claude", installed).map((a) => a.id)).toEqual(["gemini", "codex"]);
  });
});

describe("runHeadlessReview", () => {
  const workspace = () => ({ cwd: "/wt", contextDir: "/ctx", local: true, cleanup: vi.fn<() => void>() }) satisfies Workspace;

  test("runs claude read-only in the workspace and parses structured output", async () => {
    const ws = workspace();
    const exec = fakeExec([["claude", ["-p"], ok(JSON.stringify({ is_error: false, structured_output: DRAFT }))]]);
    const draft = await runHeadlessReview(item("PR1", "NEEDS_INITIAL_REVIEW"), DEFAULT_CONFIG, AGENTS.claude, {
      exec,
      prepare: async () => ws,
    });

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
    const exec = fakeExec([
      ["claude", ["-p"], { code: 1, stdout: JSON.stringify({ is_error: true, result: "rate limited" }), stderr: "" }],
    ]);
    await expect(
      runHeadlessReview(item("PR1", "NEEDS_INITIAL_REVIEW"), DEFAULT_CONFIG, AGENTS.claude, { exec, prepare: async () => ws }),
    ).rejects.toThrow("claude failed: rate limited");
    expect(ws.cleanup).toHaveBeenCalled();
  });

  test("gemini gets the diff file, the context dir, and a JSON-only prompt", async () => {
    const ws = workspace();
    const response = `\`\`\`json\n${JSON.stringify(DRAFT)}\n\`\`\``;
    const exec = fakeExec([["gemini", ["--include-directories", "/ctx"], ok(JSON.stringify({ response }))]]);
    const prepare = vi.fn(async () => ws);
    const draft = await runHeadlessReview(item("PR1", "NEEDS_INITIAL_REVIEW"), DEFAULT_CONFIG, AGENTS.gemini, { exec, prepare });

    expect(draft).toEqual(DRAFT);
    expect(prepare).toHaveBeenCalledWith(expect.anything(), undefined, { writeDiff: true });
    const [, args] = exec.mock.calls[0]!;
    expect(args).not.toContain("--model");
    expect(args.at(-1)).toContain("drafting a pull request review");
    expect(args.at(-1)).toContain('"suggestedVerdict"');
  });

  test("gemini errors and non-JSON replies are surfaced", async () => {
    const pr = item("PR1", "NEEDS_INITIAL_REVIEW");
    const run = (res: RunResult) =>
      runHeadlessReview(pr, DEFAULT_CONFIG, AGENTS.gemini, { exec: fakeExec([["gemini", [], res]]), prepare: async () => workspace() });
    await expect(run({ code: 1, stdout: JSON.stringify({ error: { message: "quota" } }), stderr: "" })).rejects.toThrow(
      "gemini failed: quota",
    );
    await expect(run(ok(JSON.stringify({ response: "Looks fine to me." })))).rejects.toThrow("gemini failed: reply wasn't valid JSON");
  });

  test("codex runs read-only with a schema file and reads the last message", async () => {
    const ws = { ...workspace(), contextDir: tempDir() };
    const config = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, models: { codex: "gpt-5" } } };
    const exec = fakeExec([
      [
        "codex",
        ["exec", "--sandbox", "read-only"],
        (args) => {
          const schemaPath = args[args.indexOf("--output-schema") + 1]!;
          expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toHaveProperty("required");
          writeFileSync(args[args.indexOf("--output-last-message") + 1]!, JSON.stringify(DRAFT));
          return ok();
        },
      ],
    ]);
    const draft = await runHeadlessReview(item("PR1", "NEEDS_INITIAL_REVIEW"), config, AGENTS.codex, { exec, prepare: async () => ws });

    expect(draft).toEqual(DRAFT);
    const [, args] = exec.mock.calls[0]!;
    expect(args).toEqual(expect.arrayContaining(["--skip-git-repo-check", "--model", "gpt-5"]));
  });

  test("a failed codex run reports stderr", async () => {
    const ws = { ...workspace(), contextDir: tempDir() };
    const exec = fakeExec([["codex", ["exec"], fail("not logged in")]]);
    await expect(
      runHeadlessReview(item("PR1", "NEEDS_INITIAL_REVIEW"), DEFAULT_CONFIG, AGENTS.codex, { exec, prepare: async () => ws }),
    ).rejects.toThrow("codex failed: not logged in");
  });

  test("an aborted signal skips claude and cleans up", async () => {
    const ws = workspace();
    const exec = fakeExec([]);
    const prepare = vi.fn(async () => ws);
    const controller = new AbortController();
    controller.abort();
    await expect(
      runHeadlessReview(item("PR1", "NEEDS_INITIAL_REVIEW"), DEFAULT_CONFIG, AGENTS.claude, {
        exec,
        prepare,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(prepare).toHaveBeenCalledWith(expect.anything(), controller.signal, { writeDiff: false });
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

  test("a submitted review carries its event and keeps the 422 fallback", async () => {
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
    const status = await postDraft(pr, DRAFT, exec, "abc", "REQUEST_CHANGES");
    expect(status).toBe(`Requested changes on ${pr.repo}#${pr.number} (comments moved into the body)`);
    expect(bodies[0]).toMatchObject({ event: "REQUEST_CHANGES" });
    expect(bodies[1]).toMatchObject({ event: "REQUEST_CHANGES", comments: [] });
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

  test("approve submits an APPROVE review on the head commit", async () => {
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
    expect(await approvePR(pr, exec)).toBe("Approved acme/api#7");
    expect(body).toEqual({ commit_id: "abc", event: "APPROVE" });
  });

  test("approve reports a blocking pending review", async () => {
    const exec = fakeExec([["gh", ["api"], fail("User can only have one pending review per pull request (HTTP 422)")]]);
    await expect(approvePR(pr, exec)).rejects.toThrow("pending review on acme/api#7");
  });
});

describe("PR actions", () => {
  const own = item("PR7", "MY_PR_READY", { author: "me", headOid: "abc", pastReviewers: ["bob"] });

  test("merge uses --auto with the chosen method and pins the head commit", async () => {
    const exec = fakeExec([["gh", ["pr", "merge"], ok()]]);
    expect(await mergePR(own, "rebase", exec)).toContain("Merge requested on acme/api#7");
    expect(exec).toHaveBeenCalledWith("gh", ["pr", "merge", own.url, "--auto", "--rebase", "--match-head-commit", "abc"]);
  });

  test("merge failures surface gh's first error line", async () => {
    const exec = fakeExec([["gh", ["pr", "merge"], fail("Pull request is not mergeable\nmore")]]);
    await expect(mergePR(own, "squash", exec)).rejects.toThrow("Merge failed: Pull request is not mergeable");
  });

  test("markReady runs gh pr ready", async () => {
    const exec = fakeExec([["gh", ["pr", "ready"], ok()]]);
    expect(await markReady(own, exec)).toBe("acme/api#7 is ready for review");
  });

  test("rerequestReviews posts the past reviewers", async () => {
    let body: unknown;
    const exec = fakeExec([
      [
        "gh",
        ["api", "--method", "POST", "repos/acme/api/pulls/7/requested_reviewers"],
        (_args, opts) => {
          body = JSON.parse(opts!.input!);
          return ok("{}");
        },
      ],
    ]);
    expect(await rerequestReviews(own, exec)).toBe("Re-requested @bob on acme/api#7");
    expect(body).toEqual({ reviewers: ["bob"] });
  });
});

describe("fileDraftStore", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("drops and deletes drafts older than 30 days", () => {
    const cache = tempDir();
    vi.stubEnv("XDG_CACHE_HOME", cache);
    const save = (number: number, daysAgo: number) => {
      const pr = item(`PR${number}`, "NEEDS_INITIAL_REVIEW", { repo: "acme/api", number });
      const createdAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
      fileDraftStore.save(pr, { prId: pr.id, headOid: pr.headOid, createdAt, draft: DRAFT });
    };
    save(1, 29);
    save(2, 31);

    expect(fileDraftStore.load().map((d) => d.prId)).toEqual(["PR1"]);
    expect(existsSync(join(cache, "gh-prq", "drafts", "acme__api#2.json"))).toBe(false);
  });
});
