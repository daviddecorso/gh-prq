import React from "react";
import type { QueueResult } from "../core/types.ts";

/** `refresh: true` bypasses the cache. */
export type QueueLoader = (refresh: boolean) => Promise<QueueResult>;

export interface QueueState {
  result: QueueResult | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
}

/** `initial` (e.g. a cached queue of any age) renders immediately while the first load runs. */
export function useQueue(load: QueueLoader, autoRefreshSeconds: number, initial: QueueResult | null = null): QueueState {
  const [result, setResult] = React.useState<QueueResult | null>(initial);
  const [loading, setLoading] = React.useState(!initial);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inFlight = React.useRef(false);

  const run = React.useCallback(
    (bypassCache: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setRefreshing(true);
      load(bypassCache)
        .then((next) => {
          setResult(next);
          setError(null);
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

  React.useEffect(() => run(false), [run]);

  React.useEffect(() => {
    if (autoRefreshSeconds <= 0) return;
    const timer = setInterval(() => run(true), autoRefreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [run, autoRefreshSeconds]);

  const refresh = React.useCallback(() => run(true), [run]);
  return { result, loading, refreshing: refreshing && !loading, error, refresh };
}
