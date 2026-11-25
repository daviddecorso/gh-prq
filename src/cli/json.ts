import type { ClassifiedPR, QueueResult } from "../core/types.ts";

/** `--json --envelope`: the items plus what a non-TTY consumer needs to judge freshness. */
export interface JsonEnvelope {
  viewer: string;
  fetchedAt: string;
  /** Set when the API call failed and the items came from an expired cache entry. */
  staleReason: string | null;
  warnings: string[];
  items: ClassifiedPR[];
}

export function renderJson(result: QueueResult, items: ClassifiedPR[], opts: { envelope?: boolean } = {}): string {
  if (!opts.envelope) return JSON.stringify(items, null, 2);
  const envelope: JsonEnvelope = {
    viewer: result.viewer,
    fetchedAt: result.fetchedAt,
    staleReason: result.staleReason ?? null,
    warnings: result.warnings,
    items,
  };
  return JSON.stringify(envelope, null, 2);
}
