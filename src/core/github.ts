import { execFileSync } from "node:child_process";
import type { CiState, Comment, NormalizedPR, QueueSnapshot, Review, ReviewState } from "./types.ts";

const GRAPHQL_URL = "https://api.github.com/graphql";

export class GhAuthError extends Error {}

export interface Scope {
  repo?: string;
  org?: string;
}

export function getGhToken(): string {
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) return token;
  } catch {}
  throw new GhAuthError("GitHub CLI isn't authenticated. Run `gh auth login` and try again.");
}

export function resolveCurrentRepo(): string {
  try {
    return execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("`--repo .` needs to run inside a git repo with a GitHub remote.");
  }
}

export function buildSearchQueries(scope: Scope) {
  const suffix = [scope.repo && `repo:${scope.repo}`, scope.org && `org:${scope.org}`]
    .filter(Boolean)
    .join(" ");
  const q = (base: string) => (suffix ? `${base} ${suffix}` : base);
  return {
    qAuthored: q("is:open is:pr author:@me"),
    qRequested: q("is:open is:pr review-requested:@me"),
    qInvolved: q("is:open is:pr reviewed-by:@me -author:@me"),
  };
}

export const QUEUE_QUERY = /* GraphQL */ `
query FetchPRQueue($qAuthored: String!, $qRequested: String!, $qInvolved: String!) {
  viewer { login }
  authored: search(query: $qAuthored, type: ISSUE, first: 40) { nodes { ...PRFields } }
  reviewRequested: search(query: $qRequested, type: ISSUE, first: 40) { nodes { ...PRFields } }
  involved: search(query: $qInvolved, type: ISSUE, first: 40) { nodes { ...PRFields } }
}

fragment PRFields on PullRequest {
  id
  number
  title
  url
  isDraft
  createdAt
  updatedAt
  mergeable
  reviewDecision
  additions
  deletions
  headRefOid
  repository { nameWithOwner }
  author { login }
  commits(last: 1) {
    nodes {
      commit {
        oid
        committedDate
        pushedDate
        statusCheckRollup {
          state
          contexts(first: 20) {
            nodes {
              ... on CheckRun { name conclusion status }
              ... on StatusContext { context state }
            }
          }
        }
      }
    }
  }
  reviewRequests(first: 20) {
    nodes {
      requestedReviewer {
        ... on User { login }
        ... on Team { combinedSlug }
      }
    }
  }
  reviews(last: 50) {
    nodes {
      author { login }
      state
      submittedAt
      commit { oid }
    }
  }
  reviewThreads(last: 50) {
    nodes {
      isResolved
      isOutdated
      path
      comments(last: 10) {
        nodes { author { login } body createdAt }
      }
    }
  }
  comments(last: 15) {
    nodes { author { login } body createdAt }
  }
}
`;

interface RawActor {
  login: string;
}

interface RawComment {
  author: RawActor | null;
  body: string;
  createdAt: string;
}

type RawCheckContext =
  | { name: string; conclusion: string | null; status: string }
  | { context: string; state: string };

interface RawPR {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergeable: NormalizedPR["mergeable"];
  reviewDecision: NormalizedPR["reviewDecision"];
  additions: number;
  deletions: number;
  headRefOid: string;
  repository: { nameWithOwner: string };
  author: RawActor | null;
  commits: {
    nodes: {
      commit: {
        oid: string;
        committedDate: string;
        pushedDate: string | null;
        statusCheckRollup: { state: string; contexts: { nodes: RawCheckContext[] } } | null;
      };
    }[];
  };
  reviewRequests: {
    nodes: { requestedReviewer: { login?: string; combinedSlug?: string } | null }[];
  };
  reviews: {
    nodes: { author: RawActor | null; state: ReviewState; submittedAt: string | null; commit: { oid: string } | null }[];
  };
  reviewThreads: {
    nodes: { isResolved: boolean; isOutdated: boolean; path: string; comments: { nodes: RawComment[] } }[];
  };
  comments: { nodes: RawComment[] };
}

interface RawResponse {
  viewer: RawActor | null;
  /** Search nodes that aren't PullRequests come back as `{}` because the fragment doesn't match. */
  authored: { nodes: (RawPR | { id?: undefined } | null)[] } | null;
  reviewRequested: { nodes: (RawPR | { id?: undefined } | null)[] } | null;
  involved: { nodes: (RawPR | { id?: undefined } | null)[] } | null;
}

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

function toCiState(state: string | undefined): CiState {
  switch (state) {
    case "SUCCESS":
    case "FAILURE":
    case "ERROR":
    case "PENDING":
      return state;
    case "EXPECTED":
      return "PENDING";
    default:
      return "NONE";
  }
}

const login = (actor: RawActor | null) => actor?.login ?? "ghost";

const toComment = (c: RawComment): Comment => ({ author: login(c.author), body: c.body, createdAt: c.createdAt });

export function normalizePR(raw: RawPR, viewerReviewRequested: boolean): NormalizedPR {
  const commit = raw.commits.nodes[0]?.commit;
  const rollup = commit?.statusCheckRollup;

  const failedChecks: string[] = [];
  for (const ctx of rollup?.contexts.nodes ?? []) {
    if ("name" in ctx && ctx.conclusion && FAILED_CONCLUSIONS.has(ctx.conclusion)) failedChecks.push(ctx.name);
    if ("context" in ctx && (ctx.state === "FAILURE" || ctx.state === "ERROR")) failedChecks.push(ctx.context);
  }

  const requestedUsers: string[] = [];
  const requestedTeams: string[] = [];
  for (const { requestedReviewer: r } of raw.reviewRequests.nodes) {
    if (r?.login) requestedUsers.push(r.login);
    if (r?.combinedSlug) requestedTeams.push(r.combinedSlug);
  }

  const reviews: Review[] = raw.reviews.nodes.map((r) => ({
    author: login(r.author),
    state: r.state,
    submittedAt: r.submittedAt,
    commitOid: r.commit?.oid ?? null,
  }));

  return {
    id: raw.id,
    repo: raw.repository.nameWithOwner,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: login(raw.author),
    isDraft: raw.isDraft,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    mergeable: raw.mergeable,
    reviewDecision: raw.reviewDecision,
    additions: raw.additions,
    deletions: raw.deletions,
    headOid: raw.headRefOid,
    latestCommitAt: commit?.pushedDate ?? commit?.committedDate ?? null,
    ciState: toCiState(rollup?.state),
    failedChecks,
    requestedUsers,
    requestedTeams,
    viewerReviewRequested,
    reviews,
    threads: raw.reviewThreads.nodes.map((t) => ({
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path,
      comments: t.comments.nodes.map(toComment),
    })),
    comments: raw.comments.nodes.map(toComment),
  };
}

const REQUEST_TIMEOUT_MS = 15_000;

export async function fetchSnapshot(scope: Scope, token = getGhToken()): Promise<QueueSnapshot> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "gh-prq",
    },
    body: JSON.stringify({ query: QUEUE_QUERY, variables: buildSearchQueries(scope) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}: ${await res.text()}`);

  const body = (await res.json()) as { data?: RawResponse | null; errors?: { message: string }[] };
  const warnings = body.errors?.map((e) => e.message) ?? [];
  const viewer = body.data?.viewer?.login;
  if (!body.data || !viewer) throw new Error(warnings.join("; ") || "Empty GraphQL response");

  const byId = new Map<string, NormalizedPR>();
  const add = (nodes: (RawPR | { id?: undefined } | null)[] | undefined, fromRequested: boolean) => {
    for (const node of nodes ?? []) {
      if (!node?.id) continue;
      const existing = byId.get(node.id);
      if (existing) existing.viewerReviewRequested ||= fromRequested;
      else byId.set(node.id, normalizePR(node, fromRequested));
    }
  };
  add(body.data.authored?.nodes, false);
  add(body.data.reviewRequested?.nodes, true);
  add(body.data.involved?.nodes, false);

  return {
    viewer,
    fetchedAt: new Date().toISOString(),
    prs: [...byId.values()],
    warnings,
  };
}
