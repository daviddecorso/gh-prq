import React from "react";
import { ACTIONABLE_BUCKETS, type ClassifiedPR, type QueueResult } from "../core/types.ts";

/** `refresh: true` bypasses the cache. */
export type QueueLoader = (refresh: boolean) => Promise<QueueResult>;

export type LoadTrigger = "initial" | "auto" | "manual";

/** Called with the PR ids a load moved into an actionable bucket or gave a newer `actionSince`. */
export type OnFresh = (ids: string[], trigger: LoadTrigger) => void;

export interface QueueState {
  result: QueueResult | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  /** Actionable PRs that are new or changed since the previous load and haven't been seen yet. */
  fresh: ReadonlySet<string>;
  markSeen: (id: string) => void;
  refresh: () => void;
}

const signature = (pr: ClassifiedPR) => `${pr.id}:${pr.bucket}:${pr.actionSince}`;

export function freshIds(prev: QueueResult | null, next: QueueResult): string[] {
  if (!prev) return [];
  const seen = new Set(prev.items.map(signature));
  return next.items.filter((pr) => ACTIONABLE_BUCKETS.has(pr.bucket) && !seen.has(signature(pr))).map((pr) => pr.id);
}

/** `initial` (e.g. a cached queue of any age) renders immediately while the first load runs, and is the baseline for `fresh`. */
export function useQueue(load: QueueLoader, autoRefreshSeconds: number, initial: QueueResult | null = null, onFresh?: OnFresh): QueueState {
  const [result, setResult] = React.useState<QueueResult | null>(initial);
  const [loading, setLoading] = React.useState(!initial);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fresh, setFresh] = React.useState<ReadonlySet<string>>(() => new Set());
  const inFlight = React.useRef(false);
  const resultRef = React.useRef(initial);
  const onFreshRef = React.useRef(onFresh);
  onFreshRef.current = onFresh;

  const run = React.useCallback(
    (trigger: LoadTrigger) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setRefreshing(true);
      load(trigger !== "initial")
        .then((next) => {
          const added = freshIds(resultRef.current, next);
          const stillListed = new Set(next.items.filter((pr) => ACTIONABLE_BUCKETS.has(pr.bucket)).map((pr) => pr.id));
          resultRef.current = next;
          setResult(next);
          setError(null);
          setFresh((prev) => new Set([...[...prev].filter((id) => stillListed.has(id)), ...added]));
          if (added.length > 0) onFreshRef.current?.(added, trigger);
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => {
          inFlight.current = false;
          setRefreshing(false);
          setLoading(false);
        });
    },
    [load],
  );

  React.useEffect(() => run("initial"), [run]);

  React.useEffect(() => {
    if (autoRefreshSeconds <= 0) return;
    const timer = setInterval(() => run("auto"), autoRefreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [run, autoRefreshSeconds]);

  const refresh = React.useCallback(() => run("manual"), [run]);
  const markSeen = React.useCallback(
    (id: string) =>
      setFresh((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      }),
    [],
  );
  return { result, loading, refreshing: refreshing && !loading, error, fresh, markSeen, refresh };
}
