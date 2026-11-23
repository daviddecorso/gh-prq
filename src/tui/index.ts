import { spawnSync } from "node:child_process";
import { render } from "ink";
import React from "react";
import type { FilterFlags } from "../cli/filter.ts";
import { filterItems } from "../cli/filter.ts";
import type { Config } from "../core/config.ts";
import type { Scope } from "../core/github.ts";
import { loadCachedQueue, loadQueue } from "../core/queue.ts";
import { fileDraftStore } from "../core/review/drafts.ts";
import { availableAgents, type Agent } from "../core/review/agents.ts";
import { feedbackCount, loadFeedback, type Feedback } from "../core/review/feedback.ts";
import { postDraft } from "../core/review/post.ts";
import { buildFixPrompt } from "../core/review/prompt.ts";
import { agentRun, runHeadlessReview } from "../core/review/runner.ts";
import { prepareWorkspace } from "../core/review/workspace.ts";
import type { ClassifiedPR, QueueResult } from "../core/types.ts";
import { defaultActions, runCheckout } from "./actions.ts";
import { runInAltScreen } from "./altScreen.ts";
import { App } from "./App.ts";
import type { Reviewer } from "./useReviews.ts";

export interface RunTuiOptions {
  config: Config;
  scope: Scope;
  flags: FilterFlags & { refresh?: boolean };
}

function makeReviewer(config: Config): Reviewer {
  return {
    run: (pr, agent, signal) => runHeadlessReview(pr, config, agent, { signal }),
    post: (pr, draft, headOid, event) => postDraft(pr, draft, undefined, headOid, event),
    loadDrafts: () => fileDraftStore.load(),
    saveDraft: (pr, saved) => fileDraftStore.save(pr, saved),
    removeDraft: (pr) => fileDraftStore.remove(pr),
  };
}

/** Runs after Ink unmounts so the agent owns the terminal. */
async function runHandoff(pr: ClassifiedPR, agent: Agent, config: Config): Promise<number> {
  process.stderr.write(`Preparing ${pr.repo}#${pr.number} for ${agent.label}…\n`);
  const ws = await prepareWorkspace(pr, undefined, undefined, { writeDiff: agent.needsDiffFile });
  try {
    const res = spawnSync(agent.id, agent.interactive(agentRun(pr, agent, config, ws, true)), {
      cwd: ws.cwd,
      stdio: "inherit",
    });
    if (res.error) throw new Error(`Couldn't start ${agent.id}: ${res.error.message}`);
    return res.status ?? 1;
  } finally {
    ws.cleanup();
  }
}

/** Runs after Ink unmounts: checks out the branch, then hands the terminal to the agent with write access. */
function runFix(pr: ClassifiedPR, agent: Agent, feedback: Feedback, config: Config): number {
  const checkedOut = runCheckout(pr);
  if (checkedOut !== 0) return checkedOut;
  const { prompt, appendSystemPrompt } = buildFixPrompt(pr, feedback);
  const n = feedbackCount(feedback);
  process.stderr.write(`Handing ${n} item${n === 1 ? "" : "s"} of feedback on ${pr.repo}#${pr.number} to ${agent.label}…\n`);
  const res = spawnSync(agent.id, agent.fix({ prompt, systemPrompt: appendSystemPrompt, model: config.agent.models[agent.id] }), {
    stdio: "inherit",
  });
  if (res.error) throw new Error(`Couldn't start ${agent.id}: ${res.error.message}`);
  return res.status ?? 1;
}

/** Resolves with the process exit code. */
export async function runTui({ config, scope, flags }: RunTuiOptions): Promise<number> {
  const filtered = (result: QueueResult) => ({ ...result, items: filterItems(result, flags, config) });
  const cached = loadCachedQueue({ config, ...scope, includeApproved: flags.all });

  let isFirstLoad = true;
  const load = async (bypassCache: boolean) => {
    const result = await loadQueue({
      config,
      ...scope,
      refresh: bypassCache || (isFirstLoad && flags.refresh),
      includeApproved: flags.all,
    });
    isFirstLoad = false;
    return filtered(result);
  };

  // Assigned from callbacks, which TS's control-flow narrowing can't see.
  let after = null as
    | { kind: "checkout"; pr: ClassifiedPR }
    | { kind: "handoff"; pr: ClassifiedPR; agent: Agent }
    | { kind: "fix"; pr: ClassifiedPR; agent: Agent; feedback: Feedback }
    | null;

  await runInAltScreen(() =>
    render(
      React.createElement(App, {
        load,
        initial: cached && filtered(cached),
        actions: {
          ...defaultActions,
          loadFeedback: (pr, viewer, signal) => loadFeedback(pr, viewer, config.filters, undefined, signal),
        },
        reviewer: makeReviewer(config),
        review: config.agent,
        agents: availableAgents(config.agent.default),
        collapseWaitingByDefault: config.ui.collapseWaitingByDefault,
        showDetailByDefault: config.ui.showDetailByDefault,
        autoRefreshSeconds: config.ui.autoRefreshSeconds,
        onCheckout: (pr) => {
          after = { kind: "checkout", pr };
        },
        onHandoff: (pr, agent) => {
          after = { kind: "handoff", pr, agent };
        },
        onFix: (pr, agent, feedback) => {
          after = { kind: "fix", pr, agent, feedback };
        },
      }),
    ),
  );

  if (after?.kind === "checkout") return runCheckout(after.pr);
  if (after?.kind === "handoff") return runHandoff(after.pr, after.agent, config);
  if (after?.kind === "fix") return runFix(after.pr, after.agent, after.feedback, config);
  return 0;
}
