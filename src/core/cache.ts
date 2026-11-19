import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { QueueSnapshot } from "./types.ts";

interface CacheEntry {
  savedAt: number;
  snapshot: QueueSnapshot;
}

type CacheFile = Record<string, CacheEntry>;

export function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "gh-prq");
}

function cacheFile(): string {
  return join(cacheDir(), "state.json");
}

function readAll(): CacheFile {
  try {
    return JSON.parse(readFileSync(cacheFile(), "utf8")) as CacheFile;
  } catch {
    return {};
  }
}

/** Returns the snapshot for `key` if it's younger than `maxAgeSeconds` (pass Infinity for any age). */
export function readCache(key: string, maxAgeSeconds: number): QueueSnapshot | null {
  const entry = readAll()[key];
  if (!entry) return null;
  return Date.now() - entry.savedAt <= maxAgeSeconds * 1000 ? entry.snapshot : null;
}

const MAX_ENTRY_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function writeCache(key: string, snapshot: QueueSnapshot): void {
  const now = Date.now();
  // Drops entries for rotated tokens and abandoned scopes so the file doesn't grow forever.
  const all = Object.fromEntries(Object.entries(readAll()).filter(([, e]) => now - e.savedAt < MAX_ENTRY_AGE_MS));
  all[key] = { savedAt: now, snapshot };
  mkdirSync(cacheDir(), { recursive: true });
  const tmp = `${cacheFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all));
  renameSync(tmp, cacheFile());
}
