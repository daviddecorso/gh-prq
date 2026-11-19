import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstErrorLine, run, type Runner } from "./exec.ts";

const REMOTE_REPO_RE = /^(?:https?:\/\/[^/]+\/|ssh:\/\/[^/]+\/|[^@/\s]+@[^:/\s]+:)([^/\s]+\/[^/\s]+?)(?:\.git)?$/;

let localRemotes: ReadonlyMap<string, string> | undefined;

/** Lowercased "owner/repo" → the cwd's git remote name that points at it. */
export function localRemotesInCwd(): ReadonlyMap<string, string> {
  if (localRemotes) return localRemotes;
  const remotes = new Map<string, string>();
  try {
    const out = execFileSync("git", ["remote", "-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split(/\r?\n/)) {
      const [name, url] = line.split(/\s+/);
      const match = url?.match(REMOTE_REPO_RE);
      if (name && match && !remotes.has(match[1]!.toLowerCase())) remotes.set(match[1]!.toLowerCase(), name);
    }
  } catch {}
  localRemotes = remotes;
  return remotes;
}

export function remoteForRepo(repo: string): string | null {
  return localRemotesInCwd().get(repo.toLowerCase()) ?? null;
}

export async function hasCommit(oid: string, exec: Runner = run, cwd?: string, signal?: AbortSignal): Promise<boolean> {
  const res = await exec("git", ["cat-file", "-e", `${oid}^{commit}`], { cwd, signal });
  return res.code === 0;
}

export interface PRWorktree {
  dir: string;
  cleanup: () => void;
}

/** Detached worktree at the PR head, created from the cwd's clone; also fetches `extraOids` best-effort. */
export async function createPRWorktree(
  pr: { number: number; headOid: string },
  remote: string,
  extraOids: string[] = [],
  exec: Runner = run,
  signal?: AbortSignal,
): Promise<PRWorktree> {
  const fetched = await exec("git", ["fetch", "--quiet", remote, `pull/${pr.number}/head`], { signal });
  if (fetched.code !== 0) throw new Error(`git fetch failed: ${firstErrorLine(fetched)}`);
  for (const oid of extraOids) {
    if (!(await hasCommit(oid, exec, undefined, signal))) await exec("git", ["fetch", "--quiet", remote, oid], { signal });
  }
  signal?.throwIfAborted();

  const parent = mkdtempSync(join(tmpdir(), "gh-prq-"));
  const dir = join(parent, "worktree");
  const added = await exec("git", ["worktree", "add", "--quiet", "--detach", dir, pr.headOid], { signal }).catch((err) => {
    rmSync(parent, { recursive: true, force: true });
    throw err;
  });
  if (added.code !== 0) {
    rmSync(parent, { recursive: true, force: true });
    throw new Error(`git worktree add failed: ${firstErrorLine(added)}`);
  }

  return {
    dir,
    cleanup: () => {
      try {
        execFileSync("git", ["worktree", "remove", "--force", dir], { stdio: "ignore" });
      } catch {}
      rmSync(parent, { recursive: true, force: true });
    },
  };
}
