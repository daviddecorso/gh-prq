import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ClassifiedPR } from "../core/types.ts";

export interface Actions {
  /** Each returns a footer status message. */
  open(pr: ClassifiedPR): string;
  copy(pr: ClassifiedPR): string;
  /** `null` means the PR can be checked out from the current directory. */
  checkoutBlocker(pr: ClassifiedPR): string | null;
}

const ref = (pr: ClassifiedPR) => `${pr.repo}#${pr.number}`;

const CLIPBOARD_COMMANDS: [string, string[]][] =
  process.platform === "darwin"
    ? [["pbcopy", []]]
    : [
        ["wl-copy", []],
        ["xclip", ["-selection", "clipboard"]],
        ["xsel", ["--clipboard", "--input"]],
      ];

const REMOTE_REPO_RE = /^(?:https?:\/\/[^/]+\/|ssh:\/\/[^/]+\/|[^@/\s]+@[^:/\s]+:)([^/\s]+\/[^/\s]+?)(?:\.git)?$/;

let localRepos: ReadonlySet<string> | undefined;

function localReposInCwd(): ReadonlySet<string> {
  if (localRepos) return localRepos;
  const repos = new Set<string>();
  try {
    const out = execFileSync("git", ["remote", "-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split(/\r?\n/)) {
      const url = line.split(/\s+/)[1];
      const match = url?.match(REMOTE_REPO_RE);
      if (match) repos.add(match[1]!.toLowerCase());
    }
  } catch {}
  localRepos = repos;
  return repos;
}

export const defaultActions: Actions = {
  open(pr) {
    const child = spawn("gh", ["pr", "view", pr.url, "--web"], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return `Opened ${ref(pr)}`;
  },

  copy(pr) {
    for (const [cmd, args] of CLIPBOARD_COMMANDS) {
      const res = spawnSync(cmd, args, { input: pr.url, stdio: ["pipe", "ignore", "ignore"] });
      if (!res.error && res.status === 0) return `Copied ${pr.url}`;
    }
    // OSC 52 lets the terminal (including over SSH/tmux) set the clipboard when no clipboard binary exists.
    process.stdout.write(`\x1b]52;c;${Buffer.from(pr.url).toString("base64")}\x07`);
    return `Copied ${pr.url} (via terminal)`;
  },

  checkoutBlocker(pr) {
    if (localReposInCwd().has(pr.repo.toLowerCase())) return null;
    return `cd into ${pr.repo} to check out #${pr.number}`;
  },
};

/** Runs after Ink unmounts so `gh` owns the terminal (it may prompt about local changes). */
export function runCheckout(pr: ClassifiedPR): number {
  const res = spawnSync("gh", ["pr", "checkout", String(pr.number)], { stdio: "inherit" });
  return res.status ?? 1;
}
