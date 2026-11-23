import type { ClassifiedPR } from "../types.ts";
import type { Feedback } from "./feedback.ts";
import { REVIEW_DRAFT_SCHEMA } from "./schema.ts";
import type { Workspace } from "./workspace.ts";

export type PromptWorkspace = Pick<Workspace, "local" | "delta" | "diffPath">;

const SYSTEM_PROMPT = `You're drafting a pull request review for the user, who'll edit and post it themselves.
Never modify files, commit, push, or post anything to GitHub.
Write the way a pragmatic senior engineer talks in review: direct, short sentences, contractions, no praise or hedging, no em dashes. Use "we" for shared code.
One issue per inline comment: the problem, then the fix. Skip style nits a linter would catch and anything that's fine.`;

const MAX_QUOTED_COMMENT = 600;

function quote(body: string, maxChars: number | null = MAX_QUOTED_COMMENT): string {
  const text = maxChars != null && body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
  return text.replace(/\r?\n/g, "\n     ");
}

function threadsSection(pr: ClassifiedPR, interactive: boolean): string[] {
  if (pr.viewerThreads.length === 0) return [];
  const lines = ["", "Unresolved threads from the user's earlier review:"];
  pr.viewerThreads.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.path}${t.isOutdated ? " (outdated)" : ""}`);
    for (const c of t.comments) lines.push(`   @${c.author}: ${quote(c.body)}`);
  });
  lines.push(
    interactive
      ? "Tell me whether each thread was addressed."
      : "Add one threadFollowUps entry per thread (by number) saying whether the code now addresses it.",
  );
  return lines;
}

export function buildReviewPrompt(
  pr: ClassifiedPR,
  ws: PromptWorkspace,
  { interactive = false, inlineSchema = false }: { interactive?: boolean; inlineSchema?: boolean } = {},
): { prompt: string; appendSystemPrompt: string } {
  const fullDiff = ws.diffPath ?? `\`gh pr diff ${pr.url}\``;
  const lines = [
    `Review ${pr.repo}#${pr.number} "${pr.title}" by @${pr.author} (${pr.url}), head ${pr.headOid}.`,
    ws.local
      ? "The working directory is a detached checkout of the PR head. Read surrounding code when the diff isn't enough."
      : ws.diffPath
        ? `There's no local checkout. The PR diff is in ${ws.diffPath}.`
        : `There's no local checkout. Use \`gh pr diff ${pr.url}\` and \`gh pr view ${pr.url}\` for context.`,
  ];

  const lastReviewed = pr.lastReviewedCommitOid?.slice(0, 7);
  switch (ws.delta?.kind) {
    case undefined:
      lines.push(`Get the full diff with ${fullDiff}.`);
      break;
    case "diff":
      lines.push(`This is a re-review. The user last reviewed ${lastReviewed}. Review only the changes since then, in ${ws.delta.path}.`);
      break;
    case "no-new-commits":
      lines.push(`This is a re-review. There are no new commits since ${lastReviewed}, so focus on the thread replies.`);
      break;
    case "unreachable":
      lines.push(
        `This is a re-review, but the user's last reviewed commit ${lastReviewed} is gone (likely a force-push). Review the full diff (${fullDiff}), focusing on the code around the threads below.`,
      );
      break;
  }

  lines.push(...threadsSection(pr, interactive));
  lines.push(
    "",
    interactive
      ? "Walk me through what you find. Don't post anything to GitHub."
      : "Inline comments must target lines inside the diff: `line` is the new-file line with side RIGHT, or the old-file line with side LEFT for removed lines. Keep `summary` to a few sentences; it can be empty when the inline comments cover everything.",
  );
  if (inlineSchema && !interactive) {
    lines.push("", `Reply with only a JSON object matching this schema, no prose:\n${JSON.stringify(REVIEW_DRAFT_SCHEMA)}`);
  }

  return { prompt: lines.join("\n"), appendSystemPrompt: SYSTEM_PROMPT };
}

const FIX_SYSTEM_PROMPT = `You're helping the user address review feedback on their pull request.
Don't commit, push, or post anything to GitHub unless the user asks.`;

export function buildFixPrompt(pr: ClassifiedPR, feedback: Feedback): { prompt: string; appendSystemPrompt: string } {
  const lines = [
    `The working directory is checked out on the branch for ${pr.repo}#${pr.number} "${pr.title}" (${pr.url}).`,
    `Address the feedback below, posted since the last commit ${feedback.since.oid.slice(0, 7)} (${feedback.since.at}).`,
    "For each item, make the fix or tell me why you wouldn't. Read the surrounding code first; outdated threads may point at lines that moved.",
  ];
  let n = 0;
  if (feedback.threads.length) {
    lines.push("", "Inline review threads:");
    for (const t of feedback.threads) {
      lines.push(`${++n}. ${t.path}${t.line != null ? `:${t.line}` : ""}${t.isOutdated ? " (outdated)" : ""}`);
      for (const c of t.comments) lines.push(`   @${c.author}${c.isNew ? " (new)" : ""}: ${quote(c.body, null)}`);
    }
  }
  if (feedback.reviews.length) {
    lines.push("", "Review summaries:");
    for (const r of feedback.reviews) lines.push(`${++n}. @${r.author} (${r.state.toLowerCase().replace("_", " ")}): ${quote(r.body, null)}`);
  }
  if (feedback.comments.length) {
    lines.push("", "Discussion comments:");
    for (const c of feedback.comments) lines.push(`${++n}. @${c.author}: ${quote(c.body, null)}`);
  }
  lines.push("", "Start by listing what you plan to change for each item, then make the changes.");
  return { prompt: lines.join("\n"), appendSystemPrompt: FIX_SYSTEM_PROMPT };
}
