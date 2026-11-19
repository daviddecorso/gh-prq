import { spawn, spawnSync } from "node:child_process";
import { remoteForRepo } from "../core/git.ts";
import { approvePR } from "../core/review/post.ts";
import type { ClassifiedPR } from "../core/types.ts";

export interface Actions {
  /** Each returns a footer status message. */
  open(pr: ClassifiedPR): string;
  /** Opens the PR's Files tab, where a pending review is submitted. */
  openFiles(pr: ClassifiedPR): void;
  copy(pr: ClassifiedPR): string;
  approve(pr: ClassifiedPR): Promise<string>;
  /** Pages `gh pr view` plus inline review comments, blocking until the pager quits. Returns an error message or null. */
  viewDetails(pr: ClassifiedPR): string | null;
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

const REVIEW_COMMENT_JQ =
  '.[] | "----------------------------------------\\nFile: \\(.path):\\(.line // .original_line)\\nAuthor: @\\(.user.login)\\n\\n\\(.body)\\n"';

function ghText(args: string[]) {
  const res = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // A numeric GH_FORCE_TTY keeps gh's colors and markdown rendering at this width while piped.
    env: { ...process.env, GH_FORCE_TTY: String(process.stdout.columns || 100), GH_PAGER: "cat" },
  });
  if (res.error) return { ok: false, text: res.error.message };
  if (res.status !== 0) return { ok: false, text: res.stderr.trim() || `gh exited ${res.status}` };
  return { ok: true, text: res.stdout };
}

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

  approve: (pr) => approvePR(pr),

  viewDetails(pr) {
    const view = ghText(["pr", "view", pr.url]);
    if (!view.ok) return view.text.split(/\r?\n/, 1)[0]!;
    const comments = ghText(["api", "--paginate", `repos/${pr.repo}/pulls/${pr.number}/comments`, "--jq", REVIEW_COMMENT_JQ]);
    const commentsText = !comments.ok
      ? `Couldn't load review comments: ${comments.text}\n`
      : comments.text.trim()
        ? comments.text
        : "No inline review comments.\n";
    // Pinned LESS so a user's -F/-X can't print into the main screen and corrupt Ink's frame.
    const res = spawnSync("less", [], {
      input: `${view.text}\n\nREVIEW COMMENTS\n${commentsText}`,
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...process.env, LESS: "-R" },
    });
    return res.error ? `Couldn't start less: ${res.error.message}` : null;
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
