import { describe, expect, test } from "vitest";
import { classifyPR, type ClassifyOptions } from "../src/core/classifier.ts";
import { DEFAULT_CONFIG, type Config } from "../src/core/config.ts";
import type { Comment, NormalizedPR, Review, ReviewState, ReviewThread } from "../src/core/types.ts";

const ME = "me";
const at = (hour: number) => new Date(Date.UTC(2026, 0, 1, hour)).toISOString();

function pr(overrides: Partial<NormalizedPR> = {}): NormalizedPR {
  return {
    id: "PR_1",
    repo: "acme/api",
    number: 1,
    title: "Test PR",
    url: "https://github.com/acme/api/pull/1",
    author: "alice",
    isDraft: false,
    createdAt: at(0),
    updatedAt: at(0),
    mergeable: "MERGEABLE",
    reviewDecision: null,
    additions: 10,
    deletions: 2,
    headOid: "c0",
    latestCommitAt: at(0),
    ciState: "SUCCESS",
    failedChecks: [],
    requestedUsers: [],
    requestedTeams: [],
    viewerReviewRequested: false,
    reviews: [],
    threads: [],
    comments: [],
    ...overrides,
  };
}

const review = (author: string, state: ReviewState, hour: number, commitOid = "c0"): Review => ({
  author,
  state,
  submittedAt: state === "PENDING" ? null : at(hour),
  commitOid,
});
const comment = (author: string, hour: number, body = "comment"): Comment => ({ author, body, createdAt: at(hour) });
const thread = (comments: Comment[], isResolved = false): ReviewThread => ({
  isResolved,
  isOutdated: false,
  path: "src/a.ts",
  comments,
});

const classify = (p: NormalizedPR, opts?: ClassifyOptions, config: Config = DEFAULT_CONFIG) =>
  classifyPR(p, ME, config, opts);
const bucketOf = (p: NormalizedPR, opts?: ClassifyOptions, config?: Config) => classify(p, opts, config)?.bucket ?? null;

describe("drafts", () => {
  test("any draft lands in DRAFTS", () => {
    expect(bucketOf(pr({ isDraft: true, author: ME }))).toBe("DRAFTS");
    expect(bucketOf(pr({ isDraft: true, requestedUsers: [ME] }))).toBe("DRAFTS");
  });
});

describe("reviewer: initial review", () => {
  test("direct request with no reviews", () => {
    const result = classify(pr({ requestedUsers: [ME], viewerReviewRequested: true }));
    expect(result?.bucket).toBe("NEEDS_INITIAL_REVIEW");
    expect(result?.reason).toBe("Direct review request");
  });

  test("team request gets a team badge", () => {
    const result = classify(pr({ requestedTeams: ["acme/backend"], viewerReviewRequested: true }));
    expect(result?.bucket).toBe("NEEDS_INITIAL_REVIEW");
    expect(result?.badges).toContain("team");
  });

  test("muted team request is dropped", () => {
    const config = { ...DEFAULT_CONFIG, filters: { ...DEFAULT_CONFIG.filters, mutedTeams: ["acme/everyone"] } };
    expect(bucketOf(pr({ requestedTeams: ["acme/everyone"], viewerReviewRequested: true }), {}, config)).toBeNull();
  });

  test("team requests can be disabled", () => {
    const config = { ...DEFAULT_CONFIG, filters: { ...DEFAULT_CONFIG.filters, includeTeamRequests: false } };
    expect(bucketOf(pr({ requestedTeams: ["acme/backend"], viewerReviewRequested: true }), {}, config)).toBeNull();
  });

  test("not requested and never interacted", () => {
    expect(bucketOf(pr())).toBeNull();
  });

  test("requested reviewer who only left a top-level comment still owes a review", () => {
    expect(bucketOf(pr({ requestedUsers: [ME], comments: [comment(ME, 1)] }))).toBe("NEEDS_INITIAL_REVIEW");
  });
});

describe("reviewer: re-review vs waiting", () => {
  test("changes requested and nothing since", () => {
    const result = classify(pr({ reviews: [review(ME, "CHANGES_REQUESTED", 1)] }));
    expect(result?.bucket).toBe("WAITING_ON_AUTHOR");
    expect(result?.reason).toBe("Waiting on requested changes");
    expect(result?.lastReviewedCommitOid).toBe("c0");
  });

  test("new commits after review", () => {
    const result = classify(
      pr({ reviews: [review(ME, "CHANGES_REQUESTED", 1)], headOid: "c1", latestCommitAt: at(2) }),
    );
    expect(result?.bucket).toBe("NEEDS_REREVIEW");
    expect(result?.reason).toBe("New commits pushed since your review");
    expect(result?.actionSince).toBe(at(2));
  });

  test("new head commit with older timestamp still triggers re-review", () => {
    const result = classify(
      pr({ reviews: [review(ME, "CHANGES_REQUESTED", 2, "c0")], headOid: "c1", latestCommitAt: at(1) }),
    );
    expect(result?.bucket).toBe("NEEDS_REREVIEW");
    expect(result?.reason).toBe("New commits pushed since your review");
  });

  test("later COMMENTED review preserves CHANGES_REQUESTED waiting reason", () => {
    const result = classify(
      pr({ reviews: [review(ME, "CHANGES_REQUESTED", 1), review(ME, "COMMENTED", 2)] }),
    );
    expect(result?.bucket).toBe("WAITING_ON_AUTHOR");
    expect(result?.reason).toBe("Waiting on requested changes");
  });

  test("explicit re-request", () => {
    const result = classify(pr({ reviews: [review(ME, "COMMENTED", 1)], requestedUsers: [ME] }));
    expect(result?.reason).toBe("Review re-requested");
  });

  test("human reply on my unresolved thread", () => {
    const result = classify(
      pr({
        reviews: [review(ME, "COMMENTED", 1)],
        threads: [thread([comment(ME, 1), comment("alice", 3, "fixed")])],
      }),
    );
    expect(result?.bucket).toBe("NEEDS_REREVIEW");
    expect(result?.reason).toBe("@alice replied on your thread");
    expect(result?.latestReplySnippet).toEqual({ author: "alice", body: "fixed", path: "src/a.ts", createdAt: at(3) });
  });

  test("bot reply on my thread is ignored", () => {
    const result = classify(
      pr({
        reviews: [review(ME, "CHANGES_REQUESTED", 1)],
        threads: [thread([comment(ME, 1), comment("vercel[bot]", 3)])],
      }),
    );
    expect(result?.bucket).toBe("WAITING_ON_AUTHOR");
  });

  test("reply on a resolved thread is ignored", () => {
    const result = classify(
      pr({
        reviews: [review(ME, "CHANGES_REQUESTED", 1)],
        threads: [thread([comment(ME, 1), comment("alice", 3)], true)],
      }),
    );
    expect(result?.bucket).toBe("WAITING_ON_AUTHOR");
  });

  test("author top-level comment after my review", () => {
    const result = classify(pr({ reviews: [review(ME, "COMMENTED", 1)], comments: [comment("alice", 2)] }));
    expect(result?.reason).toBe("@alice commented after your review");
  });

  test("bot top-level comment after my review is ignored", () => {
    const result = classify(
      pr({ reviews: [review(ME, "COMMENTED", 1)], comments: [comment("github-actions[bot]", 2)] }),
    );
    expect(result?.bucket).toBe("WAITING_ON_AUTHOR");
    expect(result?.reason).toBe("Waiting on author reply");
  });

  test("pending review doesn't count as reviewed but adds a badge", () => {
    const result = classify(pr({ requestedUsers: [ME], reviews: [review(ME, "PENDING", 1)] }));
    expect(result?.bucket).toBe("NEEDS_INITIAL_REVIEW");
    expect(result?.badges).toContain("draft review");
  });
});

describe("reviewer: approved", () => {
  const approved = pr({
    reviews: [review(ME, "CHANGES_REQUESTED", 1), review(ME, "APPROVED", 2)],
    headOid: "c1",
    latestCommitAt: at(3),
    comments: [comment("alice", 4)],
  });

  test("new commits and comments after approval don't bounce it back", () => {
    expect(bucketOf(approved)).toBeNull();
  });

  test("--all keeps it under WAITING_ON_AUTHOR", () => {
    const result = classify(approved, { includeApproved: true });
    expect(result?.bucket).toBe("WAITING_ON_AUTHOR");
    expect(result?.reason).toBe("Approved by you");
  });

  test("thread reply after approval still bounces it back", () => {
    const result = classify(pr({ ...approved, threads: [thread([comment(ME, 1), comment("alice", 5)])] }));
    expect(result?.bucket).toBe("NEEDS_REREVIEW");
  });

  test("re-request after approval bounces it back", () => {
    expect(bucketOf(pr({ ...approved, requestedUsers: [ME] }))).toBe("NEEDS_REREVIEW");
  });

  test("later COMMENTED review after approval keeps it approved", () => {
    const commentedAfterApproval = pr({
      ...approved,
      reviews: [review(ME, "APPROVED", 2), review(ME, "COMMENTED", 3)],
    });
    expect(bucketOf(commentedAfterApproval)).toBeNull();
  });

  test("unresolved thread reply before approval doesn't bounce it back", () => {
    const repliedBeforeApproval = pr({
      reviews: [review(ME, "COMMENTED", 1), review(ME, "APPROVED", 3)],
      threads: [thread([comment(ME, 1), comment("alice", 2)])],
    });
    expect(bucketOf(repliedBeforeApproval)).toBeNull();
  });
});

describe("author", () => {
  const mine = (overrides: Partial<NormalizedPR> = {}) => pr({ author: ME, ...overrides });

  test("merge conflicts", () => {
    expect(classify(mine({ mergeable: "CONFLICTING" }))?.reason).toBe("Merge conflicts");
  });

  test("failing CI lists checks", () => {
    const result = classify(mine({ ciState: "FAILURE", failedChecks: ["unit-tests"] }));
    expect(result?.bucket).toBe("MY_PR_ACTION_NEEDED");
    expect(result?.reason).toBe("CI failing (unit-tests)");
    expect(result?.failedChecks).toEqual(["unit-tests"]);
  });

  test("changes requested after my latest commit", () => {
    const result = classify(mine({ reviews: [review("bob", "CHANGES_REQUESTED", 1)] }));
    expect(result?.reason).toBe("Changes requested by @bob");
  });

  test("changes requested before my latest commit means I've responded", () => {
    expect(bucketOf(mine({ reviews: [review("bob", "CHANGES_REQUESTED", 1)], latestCommitAt: at(2) }))).toBe(
      "MY_PR_WAITING",
    );
  });

  test("a later COMMENTED review doesn't clear changes requested", () => {
    const result = classify(
      mine({ reviews: [review("bob", "CHANGES_REQUESTED", 1), review("bob", "COMMENTED", 2)] }),
    );
    expect(result?.bucket).toBe("MY_PR_ACTION_NEEDED");
  });

  test("unresolved thread where a reviewer spoke last", () => {
    const result = classify(mine({ threads: [thread([comment("bob", 1, "why?")])] }));
    expect(result?.reason).toBe("1 unresolved thread");
    expect(result?.latestReplySnippet?.body).toBe("why?");
  });

  test("unresolved thread where I spoke last isn't on me", () => {
    expect(bucketOf(mine({ threads: [thread([comment("bob", 1), comment(ME, 2)])] }))).toBe("MY_PR_WAITING");
  });

  test("approved and green is ready", () => {
    expect(bucketOf(mine({ reviewDecision: "APPROVED" }))).toBe("MY_PR_READY");
  });

  test("approved with no checks is ready", () => {
    expect(bucketOf(mine({ reviewDecision: "APPROVED", ciState: "NONE" }))).toBe("MY_PR_READY");
  });

  test("approved with CI pending waits", () => {
    const result = classify(mine({ reviewDecision: "APPROVED", ciState: "PENDING" }));
    expect(result?.bucket).toBe("MY_PR_WAITING");
    expect(result?.reason).toBe("Approved, CI running");
  });

  test("waiting names requested reviewers", () => {
    const result = classify(mine({ requestedUsers: ["bob"], requestedTeams: ["acme/backend"] }));
    expect(result?.reason).toBe("Waiting on @bob, acme/backend");
  });
});
