import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "./cache.ts";
import type { BucketId, ClassifiedPR } from "./types.ts";

export interface SnoozeEntry {
  bucket: BucketId;
  actionSince: string;
  headOid: string;
  /** Epoch ms when snoozed. */
  at: number;
}

export type Snoozes = Readonly<Record<string, SnoozeEntry>>;

export interface SnoozeStore {
  load(): Snoozes;
  save(snoozes: Snoozes): void;
}

const MAX_SNOOZE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const snoozeEntry = (pr: ClassifiedPR, now = Date.now()): SnoozeEntry => ({
  bucket: pr.bucket,
  actionSince: pr.actionSince,
  headOid: pr.headOid,
  at: now,
});

const unchanged = (pr: ClassifiedPR, e: SnoozeEntry) =>
  e.bucket === pr.bucket && e.actionSince === pr.actionSince && e.headOid === pr.headOid;

/** A snooze lasts until the PR's bucket, activity time or head commit changes. */
export function isSnoozed(pr: ClassifiedPR, snoozes: Snoozes, now = Date.now()): boolean {
  const entry = snoozes[pr.id];
  return entry != null && now - entry.at < MAX_SNOOZE_AGE_MS && unchanged(pr, entry);
}

/** Drops expired entries and those for PRs in `items` that have changed; PRs missing from `items` may just be out of scope, so they're kept. */
export function pruneSnoozes(snoozes: Snoozes, items: readonly ClassifiedPR[], now = Date.now()): Snoozes {
  const byId = new Map(items.map((pr) => [pr.id, pr]));
  return Object.fromEntries(
    Object.entries(snoozes).filter(([id, e]) => {
      if (now - e.at >= MAX_SNOOZE_AGE_MS) return false;
      const pr = byId.get(id);
      return !pr || unchanged(pr, e);
    }),
  );
}

const snoozeFile = () => join(cacheDir(), "snoozed.json");

export const fileSnoozeStore: SnoozeStore = {
  load() {
    try {
      return JSON.parse(readFileSync(snoozeFile(), "utf8")) as Snoozes;
    } catch {
      return {};
    }
  },
  save(snoozes) {
    mkdirSync(cacheDir(), { recursive: true });
    const tmp = `${snoozeFile()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(snoozes));
    renameSync(tmp, snoozeFile());
  },
};
