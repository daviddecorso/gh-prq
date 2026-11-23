import { makeBotMatcher } from "../classifier.ts";
import type { Config } from "../config.ts";
import { firstErrorLine, run, type Runner } from "../exec.ts";
import type { ClassifiedPR } from "../types.ts";

const FEEDBACK_QUERY = /* GraphQL */ `
query PRFeedback($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 1) { nodes { commit { oid committedDate pushedDate } } }
      reviewThreads(last: 100) {
        nodes {
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(last: 50) { nodes { author { login } body createdAt } }
        }
      }
      reviews(last: 100) { nodes { author { login } state body submittedAt } }
      comments(last: 100) { nodes { author { login } body createdAt } }
    }
  }
}
`;

interface RawAuthored {
  author: { login: string } | null;
  body: string;
}

export interface RawFeedback {
  commits: { nodes: { commit: { oid: string; committedDate: string; pushedDate: string | null } }[] };
  reviewThreads: {
    nodes: {
      isResolved: boolean;
      isOutdated: boolean;
      path: string;
      line: number | null;
      originalLine: number | null;
      comments: { nodes: (RawAuthored & { createdAt: string })[] };
    }[];
  };
  reviews: { nodes: (RawAuthored & { state: string; submittedAt: string | null })[] };
  comments: { nodes: (RawAuthored & { createdAt: string })[] };
}

export interface FeedbackComment {
  author: string;
  body: string;
  createdAt: string;
  /** Posted after the last commit; the rest of the thread is context. */
  isNew: boolean;
}

export interface FeedbackThread {
  path: string;
  line: number | null;
  isOutdated: boolean;
  comments: FeedbackComment[];
}

export interface Feedback {
  /** The head commit the feedback is measured against. */
  since: { oid: string; at: string };
  threads: FeedbackThread[];
  reviews: { author: string; state: string; body: string; submittedAt: string }[];
  comments: { author: string; body: string; createdAt: string }[];
}

export const feedbackCount = (f: Feedback) => f.threads.length + f.reviews.length + f.comments.length;

const ms = (iso: string) => Date.parse(iso);
const login = (c: RawAuthored) => c.author?.login ?? "ghost";

export function selectFeedback(
  raw: RawFeedback,
  { viewer, isBot }: { viewer: string; isBot: (login: string) => boolean },
): Feedback | null {
  const head = raw.commits.nodes.at(-1)?.commit;
  if (!head) return null;
  const at = head.pushedDate ?? head.committedDate;
  const cutoff = ms(at);
  const counts = (c: RawAuthored, when: string | null) =>
    when != null && ms(when) > cutoff && login(c) !== viewer && !isBot(login(c));

  const threads: FeedbackThread[] = [];
  for (const t of raw.reviewThreads.nodes) {
    if (t.isResolved) continue;
    const comments = t.comments.nodes
      .filter((c) => !isBot(login(c)))
      .map((c) => ({ author: login(c), body: c.body, createdAt: c.createdAt, isNew: counts(c, c.createdAt) }));
    if (comments.some((c) => c.isNew)) {
      threads.push({ path: t.path, line: t.line ?? t.originalLine, isOutdated: t.isOutdated, comments });
    }
  }

  const reviews = raw.reviews.nodes
    .filter((r) => r.state !== "PENDING" && r.body.trim() && counts(r, r.submittedAt))
    .map((r) => ({ author: login(r), state: r.state, body: r.body, submittedAt: r.submittedAt! }));

  const comments = raw.comments.nodes
    .filter((c) => c.body.trim() && counts(c, c.createdAt))
    .map((c) => ({ author: login(c), body: c.body, createdAt: c.createdAt }));

  return { since: { oid: head.oid, at }, threads, reviews, comments };
}

export async function loadFeedback(
  pr: Pick<ClassifiedPR, "repo" | "number">,
  viewer: string,
  filters: Config["filters"],
  exec: Runner = run,
  signal?: AbortSignal,
): Promise<Feedback> {
  const [owner, name] = pr.repo.split("/");
  const res = await exec(
    "gh",
    ["api", "graphql", "-f", `query=${FEEDBACK_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr.number}`],
    { signal },
  );
  if (res.code !== 0) throw new Error(`Couldn't load comments: ${firstErrorLine(res)}`);
  const raw = (JSON.parse(res.stdout) as { data?: { repository?: { pullRequest?: RawFeedback } } }).data?.repository?.pullRequest;
  if (!raw) throw new Error(`Couldn't load comments for ${pr.repo}#${pr.number}`);
  const feedback = selectFeedback(raw, { viewer, isBot: makeBotMatcher(filters) });
  if (!feedback) throw new Error(`${pr.repo}#${pr.number} has no commits`);
  return feedback;
}
