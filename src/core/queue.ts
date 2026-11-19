import { readCache, writeCache } from "./cache.ts";
import { classifyPR } from "./classifier.ts";
import type { Config } from "./config.ts";
import { fetchSnapshot, GhAuthError, type Scope } from "./github.ts";
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

export function classifySnapshot(
  snapshot: QueueSnapshot,
  config: Config,
  includeApproved = false,
): ClassifiedPR[] {
  const excluded = new Set(config.filters.excludeRepos);
  return snapshot.prs
    .filter((pr) => !excluded.has(pr.repo))
    .map((pr) => classifyPR(pr, snapshot.viewer, config, { includeApproved }))
    .filter((pr): pr is ClassifiedPR => pr !== null)
    .sort(compareItems);
}

/** Fetches (or reads from cache) and classifies the viewer's queue. Falls back to a stale cache when offline. */
export async function loadQueue(opts: LoadQueueOptions): Promise<QueueResult> {
  const cacheKey = JSON.stringify({ repo: opts.repo ?? null, org: opts.org ?? null });

  let snapshot = opts.refresh ? null : readCache(cacheKey, opts.config.ui.cacheTtlSeconds);
  let staleReason: string | undefined;

  if (!snapshot) {
    try {
      snapshot = await fetchSnapshot({ repo: opts.repo, org: opts.org });
      writeCache(cacheKey, snapshot);
    } catch (err) {
      const stale = err instanceof GhAuthError ? null : readCache(cacheKey, Infinity);
      if (!stale) throw err;
      snapshot = stale;
      staleReason = (err as Error).message;
    }
  }

  return {
    viewer: snapshot.viewer,
    fetchedAt: snapshot.fetchedAt,
    staleReason,
    warnings: snapshot.warnings,
    items: classifySnapshot(snapshot, opts.config, opts.includeApproved),
  };
}
