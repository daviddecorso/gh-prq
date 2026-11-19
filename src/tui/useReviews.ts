import React from "react";
import type { SavedDraft } from "../core/review/drafts.ts";
import type { ReviewDraft } from "../core/review/schema.ts";
import type { ClassifiedPR } from "../core/types.ts";

export interface Reviewer {
  run(pr: ClassifiedPR, signal: AbortSignal): Promise<ReviewDraft>;
  /** Resolves with a status message. */
  post(pr: ClassifiedPR, draft: ReviewDraft, headOid: string): Promise<string>;
  loadDrafts(): SavedDraft[];
  saveDraft(pr: ClassifiedPR, saved: SavedDraft): void;
  removeDraft(pr: ClassifiedPR): void;
}

export type ReviewJob =
  | { status: "queued" | "running"; pr: ClassifiedPR; startedAt: number }
  | { status: "failed"; pr: ClassifiedPR; error: string }
  | { status: "ready" | "posting"; headOid: string; draft: ReviewDraft };

export interface ReviewsState {
  jobs: ReadonlyMap<string, ReviewJob>;
  activeCount: number;
  start(pr: ClassifiedPR): string;
  /** Cancels a queued/running job or discards a draft or failure. */
  discard(pr: ClassifiedPR): string;
  post(pr: ClassifiedPR, onDone: (status: string, posted: boolean) => void): void;
  abortAll(): void;
}

const isActive = (job: ReviewJob | undefined) => job?.status === "queued" || job?.status === "running";

export function useReviews(reviewer: Reviewer, maxConcurrent: number): ReviewsState {
  const [jobs, setJobs] = React.useState<ReadonlyMap<string, ReviewJob>>(
    () => new Map(reviewer.loadDrafts().map((s) => [s.prId, { status: "ready", headOid: s.headOid, draft: s.draft }])),
  );
  const controllers = React.useRef(new Map<string, AbortController>());

  const update = React.useCallback((id: string, job: ReviewJob | null) => {
    setJobs((prev) => {
      const next = new Map(prev);
      if (job) next.set(id, job);
      else next.delete(id);
      return next;
    });
  }, []);

  React.useEffect(() => {
    let running = [...jobs.values()].filter((j) => j.status === "running").length;
    for (const [id, job] of jobs) {
      if (running >= maxConcurrent) break;
      if (job.status !== "queued") continue;
      running++;
      const { pr } = job;
      const controller = new AbortController();
      controllers.current.set(id, controller);
      update(id, { status: "running", pr, startedAt: Date.now() });
      reviewer
        .run(pr, controller.signal)
        .then((draft) => {
          if (controller.signal.aborted) return;
          reviewer.saveDraft(pr, { prId: pr.id, headOid: pr.headOid, createdAt: new Date().toISOString(), draft });
          update(id, { status: "ready", headOid: pr.headOid, draft });
        })
        .catch((err: Error) => {
          if (!controller.signal.aborted) update(id, { status: "failed", pr, error: err.message });
        })
        .finally(() => {
          if (controllers.current.get(id) === controller) controllers.current.delete(id);
        });
    }
  }, [jobs, maxConcurrent, reviewer, update]);

  const abortAll = React.useCallback(() => {
    for (const c of controllers.current.values()) c.abort();
  }, []);
  React.useEffect(() => abortAll, [abortAll]);

  const start = (pr: ClassifiedPR) => {
    const job = jobs.get(pr.id);
    if (isActive(job)) return "Claude is already reviewing this PR";
    if (job?.status === "ready" || job?.status === "posting") return "A draft already exists (x to discard it first)";
    update(pr.id, { status: "queued", pr, startedAt: Date.now() });
    return `Claude is reviewing ${pr.repo}#${pr.number}`;
  };

  const discard = (pr: ClassifiedPR) => {
    const job = jobs.get(pr.id);
    if (!job) return "Nothing to discard";
    if (job.status === "posting") return "Post in progress";
    controllers.current.get(pr.id)?.abort();
    if (job.status === "ready") reviewer.removeDraft(pr);
    update(pr.id, null);
    return isActive(job) ? "Review cancelled" : "Draft discarded";
  };

  const post = (pr: ClassifiedPR, onDone: (status: string, posted: boolean) => void) => {
    const job = jobs.get(pr.id);
    if (job?.status !== "ready") return onDone("No draft to post", false);
    update(pr.id, { ...job, status: "posting" });
    reviewer
      .post(pr, job.draft, job.headOid)
      .then((status) => {
        reviewer.removeDraft(pr);
        update(pr.id, null);
        onDone(status, true);
      })
      .catch((err: Error) => {
        update(pr.id, job);
        onDone(err.message, false);
      });
  };

  const activeCount = [...jobs.values()].filter(isActive).length;
  return { jobs, activeCount, start, discard, post, abortAll };
}
