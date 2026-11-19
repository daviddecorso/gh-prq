import type { Config } from "./config.ts";
import type { BucketId, ClassifiedPR, Comment, NormalizedPR, Review } from "./types.ts";

export interface ClassifyOptions {
  /** Keep PRs you approved that have nothing new (normally dropped), filed under WAITING_ON_AUTHOR. */
  includeApproved?: boolean;
}

type SubmittedReview = Review & { submittedAt: string };
type Snippet = NonNullable<ClassifiedPR["latestReplySnippet"]>;

export function makeBotMatcher(filters: Config["filters"]): (login: string) => boolean {
  const names = new Set(filters.ignoredBots.map((s) => s.toLowerCase()));
  const pattern = filters.ignoredBotPattern ? new RegExp(filters.ignoredBotPattern, "i") : null;
  return (login) => names.has(login.toLowerCase()) || (pattern?.test(login) ?? false);
}

const ms = (iso: string) => Date.parse(iso);

const isAfter = (a: string | null | undefined, b: string | null | undefined): boolean =>
  a != null && (b == null || ms(a) > ms(b));

function maxIso(values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const v of values) if (isAfter(v, best)) best = v!;
  return best;
}

function newest<T extends { createdAt: string }>(items: T[]): T | null {
  let best: T | null = null;
  for (const item of items) if (!best || isAfter(item.createdAt, best.createdAt)) best = item;
  return best;
}

const DECISIVE_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/** Mirrors GitHub: a COMMENTED review doesn't clear an earlier CHANGES_REQUESTED from the same reviewer. */
function latestDecisiveReviewPerAuthor(reviews: SubmittedReview[]): SubmittedReview[] {
  const byAuthor = new Map<string, SubmittedReview>();
  for (const r of reviews) {
    if (!DECISIVE_STATES.has(r.state)) continue;
    const prev = byAuthor.get(r.author);
    if (!prev || isAfter(r.submittedAt, prev.submittedAt)) byAuthor.set(r.author, r);
  }
  return [...byAuthor.values()];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function classifyPR(
  pr: NormalizedPR,
  viewer: string,
  config: Config,
  opts: ClassifyOptions = {},
): ClassifiedPR | null {
  const isBot = makeBotMatcher(config.filters);
  const isHuman = (x: { author: string }) => !isBot(x.author);

  const reviews = pr.reviews.filter(
    (r): r is SubmittedReview => r.state !== "PENDING" && r.submittedAt != null && isHuman(r),
  );
  const comments = pr.comments.filter(isHuman);
  const unresolvedThreads = pr.threads
    .filter((t) => !t.isResolved)
    .map((t) => ({ ...t, comments: t.comments.filter(isHuman) }))
    .filter((t) => t.comments.length > 0);

  const badges: string[] = [];
  if (pr.reviews.some((r) => r.state === "PENDING" && r.author === viewer)) badges.push("draft review");

  const lastActivityAt =
    maxIso([
      pr.latestCommitAt,
      ...reviews.map((r) => r.submittedAt),
      ...comments.map((c) => c.createdAt),
      ...pr.threads.flatMap((t) => t.comments.filter(isHuman).map((c) => c.createdAt)),
    ]) ?? pr.updatedAt;

  const make = (
    bucket: BucketId,
    reasons: string[],
    actionSince: string,
    extra: { lastReviewedCommitOid?: string | null; snippet?: Snippet | null } = {},
  ): ClassifiedPR => ({
    id: pr.id,
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    bucket,
    reason: reasons[0]!,
    allReasons: reasons,
    ciState: pr.ciState,
    failedChecks: pr.failedChecks,
    additions: pr.additions,
    deletions: pr.deletions,
    headOid: pr.headOid,
    lastReviewedCommitOid: extra.lastReviewedCommitOid ?? null,
    ...(extra.snippet ? { latestReplySnippet: extra.snippet } : {}),
    badges,
    updatedAt: pr.updatedAt,
    actionSince,
  });

  if (pr.isDraft) return make("DRAFTS", ["Draft PR"], pr.updatedAt);

  // --- Authored PRs ---
  if (pr.author === viewer) {
    const reasons: string[] = [];

    if (pr.mergeable === "CONFLICTING") reasons.push("Merge conflicts");
    if (pr.ciState === "FAILURE" || pr.ciState === "ERROR") {
      reasons.push(pr.failedChecks.length ? `CI failing (${pr.failedChecks.join(", ")})` : "CI failing");
    }

    const threadsWaitingOnMe = unresolvedThreads.filter((t) => t.comments.at(-1)!.author !== viewer);
    if (threadsWaitingOnMe.length > 0) reasons.push(plural(threadsWaitingOnMe.length, "unresolved thread"));

    const blockingReviews = latestDecisiveReviewPerAuthor(reviews.filter((r) => r.author !== viewer)).filter(
      (r) => r.state === "CHANGES_REQUESTED" && isAfter(r.submittedAt, pr.latestCommitAt),
    );
    if (blockingReviews.length > 0) {
      reasons.push(`Changes requested by ${blockingReviews.map((r) => `@${r.author}`).join(", ")}`);
    }

    if (reasons.length > 0) {
      const lastWaiting = newest(
        threadsWaitingOnMe.map((t) => ({ ...t.comments.at(-1)!, path: t.path })),
      );
      return make("MY_PR_ACTION_NEEDED", reasons, lastActivityAt, { snippet: lastWaiting });
    }

    if (pr.reviewDecision === "APPROVED" && pr.ciState !== "PENDING") {
      return make("MY_PR_READY", ["Approved & CI green"], lastActivityAt);
    }

    const waitingOn = [...pr.requestedUsers.map((u) => `@${u}`), ...pr.requestedTeams];
    const waitingReason =
      pr.reviewDecision === "APPROVED"
        ? "Approved, CI running"
        : waitingOn.length > 0
          ? `Waiting on ${waitingOn.join(", ")}`
          : "Awaiting review";
    return make("MY_PR_WAITING", [waitingReason], lastActivityAt);
  }

  // --- PRs where the viewer is (or was) a reviewer ---
  const myReviews = reviews.filter((r) => r.author === viewer);
  const lastMyReview = myReviews.reduce<SubmittedReview | null>(
    (best, r) => (!best || isAfter(r.submittedAt, best.submittedAt) ? r : best),
    null,
  );
  const myDecisiveReview = latestDecisiveReviewPerAuthor(myReviews)[0] ?? null;
  const lastReviewedCommitOid = lastMyReview?.commitOid ?? null;

  const myThreads = unresolvedThreads.filter((t) => t.comments.some((c) => c.author === viewer));
  const lastMyInteractionAt = maxIso([
    lastMyReview?.submittedAt,
    ...myThreads.flatMap((t) => t.comments.filter((c) => c.author === viewer).map((c) => c.createdAt)),
    ...comments.filter((c) => c.author === viewer).map((c) => c.createdAt),
  ]);

  const isDirectlyRequested = pr.requestedUsers.includes(viewer);
  // requestedTeams includes all teams on the PR, not just the viewer's, so muting only hides a PR when no other requested team remains.
  const activeTeams = pr.requestedTeams.filter((t) => !config.filters.mutedTeams.includes(t));
  const isTeamRequested = !isDirectlyRequested && pr.viewerReviewRequested && activeTeams.length > 0;

  // Top-level comments alone don't count as a review, so a requested reviewer who only commented still owes one.
  if (!lastMyReview) {
    if (isDirectlyRequested) return make("NEEDS_INITIAL_REVIEW", ["Direct review request"], pr.createdAt);
    if (isTeamRequested && config.filters.includeTeamRequests) {
      badges.push("team");
      return make("NEEDS_INITIAL_REVIEW", [`Team request (${activeTeams.join(", ")})`], pr.createdAt);
    }
    if (!lastMyInteractionAt) return null;
  }

  const threadReply = newest(
    myThreads.flatMap((t) => {
      const last = t.comments.at(-1)!;
      return last.author !== viewer && isAfter(last.createdAt, lastMyReview?.submittedAt)
        ? [{ ...last, path: t.path }]
        : [];
    }),
  );
  const authorReply: Comment | null = newest(
    comments.filter((c) => c.author === pr.author && isAfter(c.createdAt, lastMyInteractionAt)),
  );
  const hasNewCommits =
    lastMyReview != null &&
    (lastMyReview.commitOid != null
      ? pr.headOid !== lastMyReview.commitOid
      : isAfter(pr.latestCommitAt, lastMyReview.submittedAt));
  const iApproved = myDecisiveReview?.state === "APPROVED";
  const extra = { lastReviewedCommitOid };

  if (iApproved && !isDirectlyRequested && !threadReply) {
    return opts.includeApproved
      ? make("WAITING_ON_AUTHOR", ["Approved by you"], lastMyReview!.submittedAt, extra)
      : null;
  }

  if (isDirectlyRequested && lastMyReview) {
    return make("NEEDS_REREVIEW", ["Review re-requested"], lastActivityAt, extra);
  }
  if (threadReply) {
    return make("NEEDS_REREVIEW", [`@${threadReply.author} replied on your thread`], threadReply.createdAt, {
      ...extra,
      snippet: threadReply,
    });
  }
  if (hasNewCommits && !iApproved) {
    return make("NEEDS_REREVIEW", ["New commits pushed since your review"], pr.latestCommitAt ?? pr.updatedAt, extra);
  }
  if (authorReply && !iApproved) {
    return make("NEEDS_REREVIEW", [`@${authorReply.author} commented after your review`], authorReply.createdAt, {
      ...extra,
      snippet: authorReply,
    });
  }

  return make(
    "WAITING_ON_AUTHOR",
    [myDecisiveReview?.state === "CHANGES_REQUESTED" ? "Waiting on requested changes" : "Waiting on author reply"],
    lastMyInteractionAt!,
    extra,
  );
}
