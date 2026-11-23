import { spawn, spawnSync } from "node:child_process";
import { firstErrorLine, run } from "../core/exec.ts";
import { stripControlChars } from "../core/format.ts";
import { remoteForRepo } from "../core/git.ts";
import type { Agent } from "../core/review/agents.ts";
import type { Feedback } from "../core/review/feedback.ts";
import { approvePR } from "../core/review/post.ts";
import type { ReviewDraft } from "../core/review/schema.ts";
import type { ClassifiedPR } from "../core/types.ts";

export interface LoadDetailsOptions {
  width?: number;
  signal?: AbortSignal;
}

export interface Actions {
  /** Each returns a footer status message. */
  open(pr: ClassifiedPR): string;
  /** Opens the PR's Files tab, where a pending review is submitted. */
  openFiles(pr: ClassifiedPR): void;
  copy(pr: ClassifiedPR): string;
  approve(pr: ClassifiedPR): Promise<string>;
  /** Loads `gh pr view` and inline review comments asynchronously for the in-TUI reader. */
  loadDetails(pr: ClassifiedPR, opts?: LoadDetailsOptions): Promise<string>;
  /** `null` means the PR can be checked out from the current directory. */
  checkoutBlocker(pr: ClassifiedPR): string | null;
  /** Comments posted since the PR's head commit, for `f`. */
  loadFeedback(pr: ClassifiedPR, viewer: string, signal?: AbortSignal): Promise<Feedback>;
  bell(): void;
}

const RULE = "─".repeat(40);

export interface DraftReview {
  draft: ReviewDraft;
  agent: Agent;
}

export function formatDraft({ draft, agent }: DraftReview): string {
  const lines = [
    `\x1b[1;35m${agent.label.toUpperCase()} DRAFT\x1b[0m  \x1b[2mSuggests: ${draft.suggestedVerdict.replace("_", " ")}\x1b[0m`,
    "",
    stripControlChars(draft.summary).trim(),
    "",
  ];
  if (draft.threadFollowUps.length) {
    lines.push("\x1b[1mYour open threads:\x1b[0m");
    for (const f of draft.threadFollowUps) {
      const color = f.status === "addressed" ? "32" : f.status === "partial" ? "33" : "31";
      lines.push(`  \x1b[${color}m[${f.status.replace("_", " ")}]\x1b[0m ${stripControlChars(f.path)}: ${stripControlChars(f.note)}`);
    }
    lines.push("");
  }
  for (const c of draft.comments) {
    lines.push(`\x1b[2m${RULE}\x1b[0m`, `\x1b[36m${stripControlChars(c.path)}:${c.line}\x1b[0m`, "", stripControlChars(c.body).trim(), "");
  }
  return lines.join("\n");
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

async function ghText(args: string[], { width, signal }: LoadDetailsOptions = {}) {
  try {
    const res = await run("gh", args, {
      signal,
      // A numeric GH_FORCE_TTY keeps gh's colors and markdown rendering at this width while piped.
      env: { ...process.env, GH_FORCE_TTY: String(width || process.stdout.columns || 100), GH_PAGER: "cat" },
    });
    if (res.code !== 0) return { ok: false, text: firstErrorLine(res) };
    return { ok: true, text: res.stdout };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ok: false, text: (err as Error).message };
  }
}

function spawnDetached(cmd: string, args: string[]) {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

/** `loadFeedback` needs the config's bot filters, so `runTui` supplies it. */
export const defaultActions: Omit<Actions, "loadFeedback"> = {
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

  async loadDetails(pr, opts) {
    const [view, comments] = await Promise.all([
      ghText(["pr", "view", pr.url], opts),
      ghText(["api", "--paginate", `repos/${pr.repo}/pulls/${pr.number}/comments`, "--jq", REVIEW_COMMENT_JQ], opts),
    ]);
    if (!view.ok) throw new Error(view.text);
    const commentsText = !comments.ok
      ? `Couldn't load review comments: ${comments.text}\n`
      : comments.text.trim()
        ? comments.text
        : "No inline review comments.\n";
    return `${view.text.trimEnd()}\n\n\x1b[1mREVIEW COMMENTS\x1b[0m\n${commentsText}`;
  },

  checkoutBlocker(pr) {
    if (remoteForRepo(pr.repo)) return null;
    return `cd into ${pr.repo} to check out #${pr.number}`;
  },

  bell() {
    process.stdout.write("\x07");
  },
};

/** Runs after Ink unmounts so `gh` owns the terminal (it may prompt about local changes). */
export function runCheckout(pr: ClassifiedPR): number {
  const res = spawnSync("gh", ["pr", "checkout", String(pr.number)], { stdio: "inherit" });
  return res.status ?? 1;
}
