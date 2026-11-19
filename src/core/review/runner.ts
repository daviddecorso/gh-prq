import type { Config } from "../config.ts";
import { run, type Runner } from "../exec.ts";
import type { ClassifiedPR } from "../types.ts";
import type { Agent, AgentRun } from "./agents.ts";
import { buildReviewPrompt } from "./prompt.ts";
import { parseDraft, type ReviewDraft } from "./schema.ts";
import { prepareWorkspace, type Workspace } from "./workspace.ts";

export interface RunReviewDeps {
  exec?: Runner;
  prepare?: (pr: ClassifiedPR, signal: AbortSignal | undefined, opts: { writeDiff: boolean }) => Promise<Workspace>;
  signal?: AbortSignal;
}

export function agentRun(
  pr: ClassifiedPR,
  agent: Agent,
  config: Config,
  ws: Workspace,
  interactive = false,
): AgentRun {
  const prompt = buildReviewPrompt(pr, ws, { interactive, inlineSchema: agent.inlineSchema });
  return { prompt: prompt.prompt, systemPrompt: prompt.appendSystemPrompt, model: config.agent.models[agent.id], ws };
}

export async function runHeadlessReview(
  pr: ClassifiedPR,
  config: Config,
  agent: Agent,
  { exec = run, prepare = (p, s, o) => prepareWorkspace(p, undefined, s, o), signal }: RunReviewDeps = {},
): Promise<ReviewDraft> {
  const ws = await prepare(pr, signal, { writeDiff: agent.needsDiffFile });
  try {
    signal?.throwIfAborted();
    const { args, read } = agent.headless(agentRun(pr, agent, config, ws));
    const res = await exec(agent.id, args, { cwd: ws.cwd, signal });
    return parseDraft(read(res));
  } finally {
    ws.cleanup();
  }
}
