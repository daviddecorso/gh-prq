import { createHash } from "node:crypto";
import { readCache, writeCache } from "./cache.ts";
import { classifyPR } from "./classifier.ts";
import type { Config } from "./config.ts";
import { fetchSnapshot, getGhToken, GhAuthError, type Scope } from "./github.ts";
import { BUCKET_ORDER, type ClassifiedPR, type QueueResult, type QueueSnapshot } from "./types.ts";

export interface LoadQueueOptions extends Scope {
  config: Config;
  refresh?: boolean;
  includeApproved?: boolean;
}

function compareItems(a: ClassifiedPR, b: ClassifiedPR): number {
  const bucket = BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket);
  if (bucket !== 0) return bucket;
  const team = Number(a.badges.includes("team")) - Number(b.badges.includes("team"));
  if (team !== 0) return team;
  return Date.parse(b.actionSince) - Date.parse(a.actionSince);
}

/** Case-insensitive globs; a pattern without `/` matches the repo name under any owner. */
export function repoMatcher(patterns: string[]): (repo: string) => boolean {
  const regexes = patterns.map((pattern) => {
    const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return { regex: new RegExp(`^${source}$`, "i"), wholeRepo: pattern.includes("/") };
  });
  return (repo) => regexes.some(({ regex, wholeRepo }) => regex.test(wholeRepo ? repo : repo.split("/")[1] ?? repo));
}

export function classifySnapshot(
  snapshot: QueueSnapshot,
  config: Config,
  includeApproved = false,
): ClassifiedPR[] {
  const isExcluded = repoMatcher(config.filters.excludeRepos);
  return snapshot.prs
    .filter((pr) => !isExcluded(pr.repo))
    .map((pr) => classifyPR(pr, snapshot.viewer, config, { includeApproved }))
    .filter((pr): pr is ClassifiedPR => pr !== null)
    .sort(compareItems);
}

/** Keyed by a token hash so switching `gh auth` accounts never serves another account's queue. */
const cacheKeyFor = (opts: Scope, token: string) =>
  JSON.stringify({
    account: createHash("sha256").update(token).digest("hex").slice(0, 16),
    repo: opts.repo ?? null,
    org: opts.org ?? null,
  });

function toResult(snapshot: QueueSnapshot, opts: LoadQueueOptions, staleReason?: string): QueueResult {
  return {
    viewer: snapshot.viewer,
    fetchedAt: snapshot.fetchedAt,
    staleReason,
    warnings: snapshot.warnings,
    items: classifySnapshot(snapshot, opts.config, opts.includeApproved),
  };
}

/** The last cached queue at any age, without touching the network. */
export function loadCachedQueue(opts: LoadQueueOptions): QueueResult | null {
  let token: string;
  try {
    token = getGhToken();
  } catch {
    return null;
  }
  const snapshot = readCache(cacheKeyFor(opts, token), Infinity);
  return snapshot ? toResult(snapshot, opts) : null;
}

/** Fetches (or reads from cache) and classifies the viewer's queue. Falls back to a stale cache when offline. */
export async function loadQueue(opts: LoadQueueOptions): Promise<QueueResult> {
  const token = getGhToken();
  const cacheKey = cacheKeyFor(opts, token);

  let snapshot = opts.refresh ? null : readCache(cacheKey, opts.config.ui.cacheTtlSeconds);
  let staleReason: string | undefined;

  if (!snapshot) {
    try {
      snapshot = await fetchSnapshot({ repo: opts.repo, org: opts.org }, token);
      // Warnings describe this fetch only; caching them would repeat them on every cached run.
      writeCache(cacheKey, { ...snapshot, warnings: [] });
    } catch (err) {
      const stale = err instanceof GhAuthError ? null : readCache(cacheKey, Infinity);
      if (!stale) throw err;
      snapshot = stale;
      staleReason = (err as Error).message;
    }
  }

  return toResult(snapshot, opts, staleReason);
}
