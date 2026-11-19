import type { ClassifiedPR } from "../types.ts";
import { REVIEW_DRAFT_SCHEMA } from "./schema.ts";
import type { Workspace } from "./workspace.ts";

export type PromptWorkspace = Pick<Workspace, "local" | "delta" | "diffPath">;

const SYSTEM_PROMPT = `You're drafting a pull request review for the user, who'll edit and post it themselves.
Never modify files, commit, push, or post anything to GitHub.
Write the way a pragmatic senior engineer talks in review: direct, short sentences, contractions, no praise or hedging, no em dashes. Use "we" for shared code.
One issue per inline comment: the problem, then the fix. Skip style nits a linter would catch and anything that's fine.`;

const MAX_QUOTED_COMMENT = 600;

function quote(body: string): string {
  const text = body.length > MAX_QUOTED_COMMENT ? `${body.slice(0, MAX_QUOTED_COMMENT)}…` : body;
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
