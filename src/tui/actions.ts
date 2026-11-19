import { spawn, spawnSync } from "node:child_process";
import { remoteForRepo } from "../core/git.ts";
import type { ClassifiedPR } from "../core/types.ts";

export interface Actions {
  /** Each returns a footer status message. */
  open(pr: ClassifiedPR): string;
  /** Opens the PR's Files tab, where a pending review is submitted. */
  openFiles(pr: ClassifiedPR): void;
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

function spawnDetached(cmd: string, args: string[]) {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export const defaultActions: Actions = {
  open(pr) {
    spawnDetached("gh", ["pr", "view", pr.url, "--web"]);
    return `Opened ${ref(pr)}`;
  },

  openFiles(pr) {
    spawnDetached(process.platform === "darwin" ? "open" : "xdg-open", [`${pr.url}/files`]);
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
    if (remoteForRepo(pr.repo)) return null;
    return `cd into ${pr.repo} to check out #${pr.number}`;
  },
};

/** Runs after Ink unmounts so `gh` owns the terminal (it may prompt about local changes). */
export function runCheckout(pr: ClassifiedPR): number {
  const res = spawnSync("gh", ["pr", "checkout", String(pr.number)], { stdio: "inherit" });
  return res.status ?? 1;
}
