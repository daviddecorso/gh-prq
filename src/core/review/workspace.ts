import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstErrorLine, run, type Runner } from "../exec.ts";
import { createPRWorktree, hasCommit, remoteForRepo } from "../git.ts";
import type { ClassifiedPR } from "../types.ts";

/** What changed since the viewer's last reviewed commit. */
export type Delta =
  | { kind: "diff"; path: string }
  | { kind: "no-new-commits" }
  /** The old commit is gone (force-push), so only the full diff is available. */
  | { kind: "unreachable" };

export interface Workspace {
  /** The PR worktree when the cwd has the repo, otherwise `contextDir`. */
  cwd: string;
  contextDir: string;
  local: boolean;
  /** Absent for initial reviews. */
  delta?: Delta;
  /** The full PR diff, written only when asked for. */
  diffPath?: string;
  cleanup: () => void;
}

export interface WorkspaceDeps {
  exec: Runner;
  remoteForRepo: (repo: string) => string | null;
  createWorktree: typeof createPRWorktree;
}

const defaultDeps: WorkspaceDeps = { exec: run, remoteForRepo, createWorktree: createPRWorktree };

export const isReReview = (pr: ClassifiedPR): pr is ClassifiedPR & { lastReviewedCommitOid: string } =>
  pr.lastReviewedCommitOid != null;

/** Writes the delta diff into `contextDir`, preferring local git, then GitHub's compare API. */
export async function resolveDelta(
  pr: ClassifiedPR & { lastReviewedCommitOid: string },
  contextDir: string,
  worktree: string | null,
  exec: Runner,
  signal?: AbortSignal,
): Promise<Delta> {
  const old = pr.lastReviewedCommitOid;
  if (old === pr.headOid) return { kind: "no-new-commits" };

  let diff: string | null = null;
  if (worktree && (await hasCommit(old, exec, worktree, signal))) {
    const res = await exec("git", ["diff", old, pr.headOid], { cwd: worktree, signal });
    if (res.code === 0) diff = res.stdout;
  }
  if (diff == null) {
    const res = await exec(
      "gh",
      ["api", "-H", "Accept: application/vnd.github.diff", `repos/${pr.repo}/compare/${old}...${pr.headOid}`],
      { signal },
    );
    if (res.code === 0) diff = res.stdout;
  }
  if (diff == null) return { kind: "unreachable" };

  const path = join(contextDir, "since-last-review.diff");
  writeFileSync(path, diff);
  return { kind: "diff", path };
}

export async function prepareWorkspace(
  pr: ClassifiedPR,
  deps: WorkspaceDeps = defaultDeps,
  signal?: AbortSignal,
  { writeDiff = false }: { writeDiff?: boolean } = {},
): Promise<Workspace> {
  const contextDir = mkdtempSync(join(tmpdir(), "gh-prq-ctx-"));
  const cleanups = [() => rmSync(contextDir, { recursive: true, force: true })];
  const cleanup = () => {
    for (const fn of cleanups.splice(0).reverse()) fn();
  };

  try {
    const remote = deps.remoteForRepo(pr.repo);
    let worktree: string | null = null;
    if (remote) {
      const extra = isReReview(pr) ? [pr.lastReviewedCommitOid] : [];
      const wt = await deps.createWorktree(pr, remote, extra, deps.exec, signal);
      cleanups.push(wt.cleanup);
      worktree = wt.dir;
    }
    const delta = isReReview(pr) ? await resolveDelta(pr, contextDir, worktree, deps.exec, signal) : undefined;
    let diffPath: string | undefined;
    if (writeDiff) {
      const res = await deps.exec("gh", ["pr", "diff", pr.url], { signal });
      if (res.code !== 0) throw new Error(`Couldn't fetch the PR diff: ${firstErrorLine(res)}`);
      diffPath = join(contextDir, "pr.diff");
      writeFileSync(diffPath, res.stdout);
    }
    return { cwd: worktree ?? contextDir, contextDir, local: worktree != null, delta, diffPath, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
