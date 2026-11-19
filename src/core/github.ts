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

export const ID_SEARCH_QUERY = /* GraphQL */ `
query SearchPRIds($q: String!, $after: String) {
  viewer { login }
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { id } }
  }
}
`;

/** GitHub resolves one query's PRs serially, so small parallel batches are about 2x faster than a single query. */
export const DETAILS_QUERY = /* GraphQL */ `
query PRDetails($ids: [ID!]!) {
  nodes(ids: $ids) { ...PRFields }
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
  recentCommits: commits(last: 10) {
    totalCount
    nodes { commit { oid messageHeadline committedDate } }
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
  recentCommits: {
    totalCount: number;
    nodes: { commit: { oid: string; messageHeadline: string; committedDate: string } }[];
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

interface RawIdSearch {
  viewer: RawActor | null;
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    /** Issues come back as `{}` because the PullRequest fragment doesn't match. */
    nodes: ({ id?: string } | null)[];
  } | null;
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
    commits: raw.recentCommits.nodes.map(({ commit: c }) => ({ oid: c.oid, headline: c.messageHeadline, committedAt: c.committedDate })),
    commitCount: raw.recentCommits.totalCount,
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

const DETAILS_BATCH_SIZE = 10;
const MAX_PARALLEL_REQUESTS = 8;
const MAX_SEARCH_PAGES = 3;

async function graphql<T>(query: string, variables: object, token: string): Promise<{ data: T; warnings: string[] }> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "gh-prq",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401) {
    throw new GhAuthError("GitHub rejected the CLI's token. Run `gh auth login` and try again.");
  }
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} ${res.statusText}`.trim());

  const body = (await res.json()) as { data?: T | null; errors?: { message: string }[] };
  const warnings = body.errors?.map((e) => e.message) ?? [];
  if (!body.data) throw new Error(warnings.join("; ") || "Empty GraphQL response");
  return { data: body.data, warnings };
}

async function searchIds(q: string, token: string): Promise<{ viewer: string; ids: string[]; warnings: string[] }> {
  const ids: string[] = [];
  const warnings: string[] = [];
  let viewer = "";
  let after: string | null = null;
  for (let page = 0; ; page++) {
    const res: { data: RawIdSearch; warnings: string[] } = await graphql<RawIdSearch>(ID_SEARCH_QUERY, { q, after }, token);
    viewer ||= res.data.viewer?.login ?? "";
    warnings.push(...res.warnings);
    for (const node of res.data.search?.nodes ?? []) if (node?.id) ids.push(node.id);
    const pageInfo = res.data.search?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    if (page + 1 >= MAX_SEARCH_PAGES) {
      warnings.push(`"${q}" matched more than ${ids.length} PRs; showing the first ${ids.length}. Narrow with --repo or --org.`);
      break;
    }
    after = pageInfo.endCursor;
  }
  if (!viewer) throw new Error(warnings.join("; ") || "Empty GraphQL response");
  return { viewer, ids, warnings };
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function fetchSnapshot(scope: Scope, token = getGhToken()): Promise<QueueSnapshot> {
  const { qAuthored, qRequested, qInvolved } = buildSearchQueries(scope);
  const searches = await Promise.all([qAuthored, qRequested, qInvolved].map((q) => searchIds(q, token)));
  const requestedIds = new Set(searches[1]!.ids);
  const ids = [...new Set(searches.flatMap((s) => s.ids))];

  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += DETAILS_BATCH_SIZE) batches.push(ids.slice(i, i + DETAILS_BATCH_SIZE));
  const details = await mapLimited(batches, MAX_PARALLEL_REQUESTS, (batch) =>
    graphql<{ nodes: (RawPR | null)[] }>(DETAILS_QUERY, { ids: batch }, token),
  );

  const prs = details.flatMap((d) => d.data.nodes).filter((pr): pr is RawPR => pr !== null);
  return {
    viewer: searches[0]!.viewer,
    fetchedAt: new Date().toISOString(),
    prs: prs.map((pr) => normalizePR(pr, requestedIds.has(pr.id))),
    warnings: [...new Set([...searches, ...details].flatMap((r) => r.warnings))],
  };
}
