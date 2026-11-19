import type { Config } from "../config.ts";
import { firstErrorLine, run, type Runner } from "../exec.ts";
import type { ClassifiedPR } from "../types.ts";
import { buildReviewPrompt } from "./prompt.ts";
import { parseDraft, REVIEW_DRAFT_SCHEMA, type ReviewDraft } from "./schema.ts";
import { prepareWorkspace, type Workspace } from "./workspace.ts";

export const ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(gh pr diff:*)",
  "Bash(gh pr view:*)",
];
export const DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit"];

export interface RunReviewDeps {
  exec?: Runner;
  prepare?: (pr: ClassifiedPR, signal?: AbortSignal) => Promise<Workspace>;
  signal?: AbortSignal;
}

/** Flags shared by headless and interactive runs. The tool flags are variadic, so callers put positionals first. */
export function claudeArgs(prompt: { prompt: string; appendSystemPrompt: string }, model: string, ws: Workspace): string[] {
  return [
    "--model",
    model,
    "--append-system-prompt",
    prompt.appendSystemPrompt,
    "--add-dir",
    ws.contextDir,
    "--allowedTools",
    ...ALLOWED_TOOLS,
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
  ];
}

export async function runHeadlessReview(
  pr: ClassifiedPR,
  config: Config,
  { exec = run, prepare = (p, s) => prepareWorkspace(p, undefined, s), signal }: RunReviewDeps = {},
): Promise<ReviewDraft> {
  const ws = await prepare(pr, signal);
  try {
    signal?.throwIfAborted();
    const prompt = buildReviewPrompt(pr, ws);
    const args = [
      "-p",
      prompt.prompt,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(REVIEW_DRAFT_SCHEMA),
      ...claudeArgs(prompt, config.claude.model, ws),
    ];
    const res = await exec("claude", args, { cwd: ws.cwd, signal });

    let out: { is_error?: boolean; result?: string; structured_output?: unknown };
    try {
      out = JSON.parse(res.stdout);
    } catch {
      throw new Error(`claude failed: ${firstErrorLine(res)}`);
    }
    if (res.code !== 0 || out.is_error) throw new Error(`claude failed: ${out.result ?? firstErrorLine(res)}`);
    return parseDraft(out.structured_output);
  } finally {
    ws.cleanup();
  }
}
