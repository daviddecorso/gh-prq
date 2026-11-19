import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "../cache.ts";
import type { ClassifiedPR } from "../types.ts";
import type { ReviewDraft } from "./schema.ts";

export interface SavedDraft {
  prId: string;
  headOid: string;
  createdAt: string;
  draft: ReviewDraft;
}

export interface DraftStore {
  load(): SavedDraft[];
  save(pr: ClassifiedPR, saved: SavedDraft): void;
  remove(pr: ClassifiedPR): void;
}

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
    return names.flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(draftsDir(), name), "utf8")) as SavedDraft];
      } catch {
        return [];
      }
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
