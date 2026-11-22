import React from "react";
import { AGENTS, type Agent } from "../core/review/agents.ts";
import type { SavedDraft } from "../core/review/drafts.ts";
import type { ReviewEvent } from "../core/review/post.ts";
import type { ReviewDraft } from "../core/review/schema.ts";
import type { ClassifiedPR } from "../core/types.ts";

export interface Reviewer {
  run(pr: ClassifiedPR, agent: Agent, signal: AbortSignal): Promise<ReviewDraft>;
  /** Resolves with a status message. */
  post(pr: ClassifiedPR, draft: ReviewDraft, headOid: string, event: ReviewEvent): Promise<string>;
  loadDrafts(): SavedDraft[];
  saveDraft(pr: ClassifiedPR, saved: SavedDraft): void;
  removeDraft(pr: ClassifiedPR): void;
}

type ReadyJob = { agent: Agent; status: "ready"; headOid: string; draft: ReviewDraft };

export type ReviewJob = { agent: Agent } & (
  | { status: "queued" | "running"; pr: ClassifiedPR; startedAt: number; previous?: ReadyJob }
  | { status: "failed"; pr: ClassifiedPR; error: string }
  | { status: "ready"; headOid: string; draft: ReviewDraft }
  | { status: "posting"; headOid: string; draft: ReviewDraft }
);

export interface ReviewsState {
  jobs: ReadonlyMap<string, ReviewJob>;
  activeCount: number;
  start(pr: ClassifiedPR, agent: Agent, opts?: { replace?: boolean }): string;
  /** Cancels a queued/running job or discards a draft or failure. */
  discard(pr: ClassifiedPR): string;
  post(pr: ClassifiedPR, event: ReviewEvent, onDone: (status: string, posted: boolean) => void): void;
  abortAll(): void;
}

const isActive = (job: ReviewJob | undefined): job is Extract<ReviewJob, { status: "queued" | "running" }> =>
  job?.status === "queued" || job?.status === "running";

export type ReviewSettled = (pr: ClassifiedPR, agent: Agent, outcome: { ok: true } | { ok: false; error: string }) => void;

/** `onSettled` fires when a background run finishes or fails, not when it's cancelled. */
export function useReviews(reviewer: Reviewer, maxConcurrent: number, onSettled?: ReviewSettled): ReviewsState {
  const [jobs, setJobs] = React.useState<ReadonlyMap<string, ReviewJob>>(
    () =>
      new Map(
        reviewer.loadDrafts().map((s) => [
          s.prId,
          { status: "ready", agent: AGENTS[s.agent ?? "claude"] ?? AGENTS.claude, headOid: s.headOid, draft: s.draft },
        ]),
      ),
  );
  const controllers = React.useRef(new Map<string, AbortController>());
  const settledRef = React.useRef(onSettled);
  settledRef.current = onSettled;

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
      const { pr, agent, previous } = job;
      const controller = new AbortController();
      controllers.current.set(id, controller);
      update(id, { status: "running", agent, pr, startedAt: Date.now(), ...(previous && { previous }) });
      reviewer
        .run(pr, agent, controller.signal)
        .then((draft) => {
          if (controller.signal.aborted) return;
          reviewer.saveDraft(pr, { prId: pr.id, headOid: pr.headOid, createdAt: new Date().toISOString(), agent: agent.id, draft });
          update(id, { status: "ready", agent, headOid: pr.headOid, draft });
          settledRef.current?.(pr, agent, { ok: true });
        })
        .catch((err: Error) => {
          if (controller.signal.aborted) return;
          update(id, previous ?? { status: "failed", agent, pr, error: err.message });
          settledRef.current?.(pr, agent, { ok: false, error: err.message });
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

  const start = (pr: ClassifiedPR, agent: Agent, { replace = false } = {}) => {
    const job = jobs.get(pr.id);
    if (isActive(job)) return `${job.agent.label} is already reviewing this PR`;
    if (job?.status === "posting") return "Post in progress";
    let previous: ReadyJob | undefined;
    if (job?.status === "ready") {
      if (!replace) return "A draft already exists (x to discard it first)";
      previous = job;
    }
    update(pr.id, { status: "queued", agent, pr, startedAt: Date.now(), ...(previous && { previous }) });
    return `${agent.label} is reviewing ${pr.repo}#${pr.number}`;
  };

  const discard = (pr: ClassifiedPR) => {
    const job = jobs.get(pr.id);
    if (!job) return "Nothing to discard";
    if (job.status === "posting") return "Post in progress";
    controllers.current.get(pr.id)?.abort();
    if (job.status === "ready") reviewer.removeDraft(pr);
    update(pr.id, isActive(job) && job.previous ? job.previous : null);
    return isActive(job) ? "Review cancelled" : "Draft discarded";
  };

  const post = (pr: ClassifiedPR, event: ReviewEvent, onDone: (status: string, posted: boolean) => void) => {
    const job = jobs.get(pr.id);
    if (job?.status !== "ready") return onDone("No draft to post", false);
    update(pr.id, { ...job, status: "posting" });
    reviewer
      .post(pr, job.draft, job.headOid, event)
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
