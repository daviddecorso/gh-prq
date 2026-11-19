export type BucketId =
  | "NEEDS_REREVIEW"
  | "NEEDS_INITIAL_REVIEW"
  | "MY_PR_ACTION_NEEDED"
  | "MY_PR_READY"
  | "WAITING_ON_AUTHOR"
  | "MY_PR_WAITING"
  | "DRAFTS";

export const BUCKET_ORDER: readonly BucketId[] = [
  "NEEDS_REREVIEW",
  "NEEDS_INITIAL_REVIEW",
  "MY_PR_ACTION_NEEDED",
  "MY_PR_READY",
  "WAITING_ON_AUTHOR",
  "MY_PR_WAITING",
  "DRAFTS",
];

export const BUCKET_LABELS: Record<BucketId, string> = {
  NEEDS_REREVIEW: "Needs Re-review",
  NEEDS_INITIAL_REVIEW: "Needs Review",
  MY_PR_ACTION_NEEDED: "My PRs — Action Needed",
  MY_PR_READY: "My PRs — Ready to Merge",
  WAITING_ON_AUTHOR: "Waiting on Author",
  MY_PR_WAITING: "My PRs — Waiting",
  DRAFTS: "Drafts",
};

export const ACTIONABLE_BUCKETS: ReadonlySet<BucketId> = new Set([
  "NEEDS_REREVIEW",
  "NEEDS_INITIAL_REVIEW",
  "MY_PR_ACTION_NEEDED",
  "MY_PR_READY",
]);

export const WAITING_BUCKETS: ReadonlySet<BucketId> = new Set(["WAITING_ON_AUTHOR", "MY_PR_WAITING"]);

export type CiState = "SUCCESS" | "PENDING" | "FAILURE" | "ERROR" | "NONE";

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export interface Comment {
  author: string;
  body: string;
  createdAt: string;
}

export interface Review {
  author: string;
  state: ReviewState;
  /** null while the review is PENDING (unsubmitted). */
  submittedAt: string | null;
  commitOid: string | null;
}

export interface ReviewThread {
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  comments: Comment[];
}

/** A PR as fetched from GitHub, before any viewer-relative classification or bot filtering. */
export interface NormalizedPR {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  additions: number;
  deletions: number;
  headOid: string;
  latestCommitAt: string | null;
  ciState: CiState;
  failedChecks: string[];
  requestedUsers: string[];
  /** Team combined slugs ("org/team"). */
  requestedTeams: string[];
  /** Matched `review-requested:@me`, which also covers requests to the viewer's teams. */
  viewerReviewRequested: boolean;
  reviews: Review[];
  threads: ReviewThread[];
  comments: Comment[];
}

export interface QueueSnapshot {
  viewer: string;
  fetchedAt: string;
  prs: NormalizedPR[];
  /** Partial GraphQL errors (e.g. an org blocked by SAML) that didn't prevent a response. */
  warnings: string[];
}

export interface ViewerThread {
  path: string;
  isOutdated: boolean;
  comments: Comment[];
}

export interface ClassifiedPR {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  bucket: BucketId;
  reason: string;
  allReasons: string[];
  ciState: CiState;
  failedChecks: string[];
  additions: number;
  deletions: number;
  headOid: string;
  lastReviewedCommitOid: string | null;
  latestReplySnippet?: {
    author: string;
    body: string;
    path?: string;
    createdAt: string;
  };
  /** Unresolved threads the viewer commented in, oldest comment first. */
  viewerThreads: ViewerThread[];
  /** Small row annotations, e.g. "team", "draft review". */
  badges: string[];
  updatedAt: string;
  actionSince: string;
}

export interface QueueResult {
  viewer: string;
  fetchedAt: string;
  /** Set when the API call failed and these results came from an expired cache entry. */
  staleReason?: string;
  warnings: string[];
  items: ClassifiedPR[];
}
