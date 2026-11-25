import { describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import { AGENTS } from "../src/core/review/agents.ts";
import { loadFeedback, type RawFeedback, selectFeedback } from "../src/core/review/feedback.ts";
import { buildFixPrompt } from "../src/core/review/prompt.ts";
import { item } from "./fixtures.ts";

const COMMIT_AT = "2026-01-01T12:00:00Z";
const before = "2026-01-01T11:00:00Z";
const after = "2026-01-01T13:00:00Z";
const by = (login: string | null) => (login ? { login } : null);

const raw = (overrides: Partial<RawFeedback> = {}): RawFeedback => ({
  commits: { nodes: [{ commit: { oid: "head123456", committedDate: COMMIT_AT, pushedDate: null } }] },
  reviewThreads: { nodes: [] },
  reviews: { nodes: [] },
  comments: { nodes: [] },
  ...overrides,
});

const isBot = (login: string) => login.endsWith("[bot]");
const select = (r: RawFeedback) => selectFeedback(r, { viewer: "me", isBot })!;

describe("selectFeedback", () => {
  test("keeps discussion comments after the head commit from other humans", () => {
    const f = select(
      raw({
        comments: {
          nodes: [
            { author: by("alice"), body: "old", createdAt: before },
            { author: by("alice"), body: "at cutoff", createdAt: COMMIT_AT },
            { author: by("alice"), body: "new", createdAt: after },
            { author: by("me"), body: "mine", createdAt: after },
            { author: by("vercel[bot]"), body: "deployed", createdAt: after },
          ],
        },
      }),
    );
    expect(f.comments.map((c) => c.body)).toEqual(["new"]);
    expect(f.since).toEqual({ oid: "head123456", at: COMMIT_AT });
  });

  test("prefers pushedDate over committedDate even with clock skew", () => {
    const f = select(
      raw({
        commits: { nodes: [{ commit: { oid: "h", committedDate: after, pushedDate: COMMIT_AT } }] },
        comments: {
          nodes: [
            { author: by("alice"), body: "before push", createdAt: before },
            { author: by("alice"), body: "after push", createdAt: "2026-01-01T12:30:00Z" },
          ],
        },
      }),
    );
    expect(f.comments.map((c) => c.body)).toEqual(["after push"]);
    expect(f.since.at).toBe(COMMIT_AT);
  });

  test("keeps unresolved threads with a new comment, with earlier comments as context", () => {
    const thread = (isResolved: boolean, comments: [string, string][]) => ({
      isResolved,
      isOutdated: false,
      path: "src/a.ts",
      line: 4,
      originalLine: 3,
      comments: { nodes: comments.map(([who, at]) => ({ author: by(who), body: `${who} says`, createdAt: at })) },
    });
    const f = select(
      raw({
        reviewThreads: {
          nodes: [
            thread(false, [
              ["alice", before],
              ["me", before],
              ["alice", after],
            ]),
            thread(true, [["bob", after]]),
            thread(false, [["bob", before]]),
            thread(false, [["me", after]]),
          ],
        },
      }),
    );
    expect(f.threads).toHaveLength(1);
    expect(f.threads[0]!.comments.map((c) => [c.author, c.isNew])).toEqual([
      ["alice", false],
      ["me", false],
      ["alice", true],
    ]);
  });

  test("keeps review summaries with a body, skipping empty and pending ones", () => {
    const f = select(
      raw({
        reviews: {
          nodes: [
            { author: by("alice"), state: "CHANGES_REQUESTED", body: "Needs tests", submittedAt: after },
            { author: by("bob"), state: "COMMENTED", body: "  ", submittedAt: after },
            { author: by("carol"), state: "PENDING", body: "draft", submittedAt: null },
            { author: by("dave"), state: "APPROVED", body: "lgtm", submittedAt: before },
          ],
        },
      }),
    );
    expect(f.reviews.map((r) => r.author)).toEqual(["alice"]);
  });

  test("returns null without a head commit", () => {
    expect(selectFeedback(raw({ commits: { nodes: [] } }), { viewer: "me", isBot })).toBeNull();
  });
});

describe("loadFeedback", () => {
  test("queries the PR by owner, name, and number", async () => {
    const exec = vi.fn(async (_cmd: string, _args: string[]) => ({
      code: 0,
      stdout: JSON.stringify({ data: { repository: { pullRequest: raw() } } }),
      stderr: "",
    }));
    const f = await loadFeedback({ repo: "acme/api", number: 7 }, "me", DEFAULT_CONFIG.filters, exec);
    expect(f.since.oid).toBe("head123456");
    const args = exec.mock.calls[0]![1];
    expect(args).toEqual(expect.arrayContaining(["owner=acme", "name=api", "number=7"]));
    const query = args.find((a) => a.startsWith("query="))!;
    expect(query).toContain("reviewThreads(last: 100)");
    expect(query).toContain("comments(last: 50)");
  });

  test("surfaces gh errors", async () => {
    const exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "HTTP 404" }));
    await expect(loadFeedback({ repo: "acme/api", number: 7 }, "me", DEFAULT_CONFIG.filters, exec)).rejects.toThrow("HTTP 404");
  });
});

describe("buildFixPrompt", () => {
  test("numbers threads, reviews, and discussion together", () => {
    const { prompt, appendSystemPrompt } = buildFixPrompt(item("PR7", "MY_PR_ACTION_NEEDED"), {
      since: { oid: "head123456", at: COMMIT_AT },
      threads: [
        {
          path: "src/a.ts",
          line: 4,
          isOutdated: true,
          comments: [
            { author: "alice", body: "Race here", createdAt: before, isNew: false },
            { author: "alice", body: "Still racy", createdAt: after, isNew: true },
          ],
        },
      ],
      reviews: [{ author: "bob", state: "CHANGES_REQUESTED", body: "Add tests", submittedAt: after }],
      comments: [{ author: "carol", body: "Rename the flag", createdAt: after }],
    });
    expect(prompt).toContain("since the last commit head123");
    expect(prompt).toContain("1. src/a.ts:4 (outdated)");
    expect(prompt).toContain("@alice: Race here");
    expect(prompt).toContain("@alice (new): Still racy");
    expect(prompt).toContain("2. @bob (changes requested): Add tests");
    expect(prompt).toContain("3. @carol: Rename the flag");
    expect(appendSystemPrompt).toContain("Don't commit, push");
  });

  test("doesn't truncate long review feedback", () => {
    const longBody = `${"a".repeat(700)} TAIL_MARKER`;
    const { prompt } = buildFixPrompt(item("PR7", "MY_PR_ACTION_NEEDED"), {
      since: { oid: "head123456", at: COMMIT_AT },
      threads: [],
      reviews: [{ author: "bob", state: "CHANGES_REQUESTED", body: longBody, submittedAt: after }],
      comments: [],
    });
    expect(prompt).toContain("TAIL_MARKER");
  });

  test("asks for /code-review --fix only when requested and includes reviewEffort", () => {
    const feedback = { since: { oid: "head123456", at: COMMIT_AT }, threads: [], reviews: [], comments: [] };
    const pr = item("PR7", "MY_PR_ACTION_NEEDED");
    expect(buildFixPrompt(pr, feedback).prompt).not.toContain("/code-review");
    expect(buildFixPrompt(pr, feedback, { codeReview: true }).prompt).toMatch(/After the feedback is addressed, run \/code-review --fix/);
    expect(buildFixPrompt(pr, feedback, { codeReview: true, reviewEffort: "high" }).prompt).toMatch(
      /After the feedback is addressed, run \/code-review high --fix/,
    );
  });
});

describe("agent fix args", () => {
  const run = { prompt: "P", systemPrompt: "S", model: "m" };
  test("don't carry the read-only restrictions", () => {
    expect(AGENTS.claude.fix(run)).toEqual(["P", "--model", "m", "--append-system-prompt", "S"]);
    expect(AGENTS.gemini.fix(run)).toEqual(["--model", "m", "-i", "S\n\nP"]);
    expect(AGENTS.codex.fix(run)).toEqual(["--model", "m", "S\n\nP"]);
  });
});
