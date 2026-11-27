import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "../cache.ts";
import type { ClassifiedPR } from "../types.ts";
import type { AgentId } from "./agents.ts";
import type { ReviewDraft } from "./schema.ts";

export interface SavedDraft {
  prId: string;
  headOid: string;
  createdAt: string;
  /** Absent in drafts saved before other agents were supported, which were all Claude's. */
  agent?: AgentId;
  draft: ReviewDraft;
}

export interface DraftStore {
  load(): SavedDraft[];
  save(pr: ClassifiedPR, saved: SavedDraft): void;
  remove(pr: ClassifiedPR): void;
}

const MAX_DRAFT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const draftsDir = () => join(cacheDir(), "drafts");
const draftFile = (pr: ClassifiedPR) => join(draftsDir(), `${pr.repo.replace("/", "__")}#${pr.number}.json`);

export const fileDraftStore: DraftStore = {
  load() {
    let names: string[];
    try {
      names = readdirSync(draftsDir()).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const cutoff = Date.now() - MAX_DRAFT_AGE_MS;
    return names.flatMap((name) => {
      const path = join(draftsDir(), name);
      let saved: SavedDraft;
      try {
        saved = JSON.parse(readFileSync(path, "utf8")) as SavedDraft;
      } catch {
        return [];
      }
      // Closed or merged PRs never come back to discard their drafts, so age is the only signal.
      if (Date.parse(saved.createdAt) < cutoff) {
        rmSync(path, { force: true });
        return [];
      }
      return [saved];
    });
  },
  save(pr, saved) {
    mkdirSync(draftsDir(), { recursive: true });
    writeFileSync(draftFile(pr), JSON.stringify(saved));
  },
  remove(pr) {
    rmSync(draftFile(pr), { force: true });
  },
};
