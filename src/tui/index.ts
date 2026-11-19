import { spawnSync } from "node:child_process";
import { render } from "ink";
import React from "react";
import type { FilterFlags } from "../cli/filter.ts";
import { filterItems } from "../cli/filter.ts";
import type { Config } from "../core/config.ts";
import type { Scope } from "../core/github.ts";
import { loadCachedQueue, loadQueue } from "../core/queue.ts";
import { fileDraftStore } from "../core/review/drafts.ts";
import { postDraft } from "../core/review/post.ts";
import { buildReviewPrompt } from "../core/review/prompt.ts";
import { claudeArgs, runHeadlessReview } from "../core/review/runner.ts";
import { prepareWorkspace } from "../core/review/workspace.ts";
import type { ClassifiedPR, QueueResult } from "../core/types.ts";
import { defaultActions, runCheckout } from "./actions.ts";
import { App } from "./App.ts";
import type { Reviewer } from "./useReviews.ts";

export interface RunTuiOptions {
  config: Config;
  scope: Scope;
  flags: FilterFlags & { refresh?: boolean };
}

function makeReviewer(config: Config): Reviewer {
  return {
    run: (pr, signal) => runHeadlessReview(pr, config, { signal }),
    post: (pr, draft, headOid) => postDraft(pr, draft, undefined, headOid),
    loadDrafts: () => fileDraftStore.load(),
    saveDraft: (pr, saved) => fileDraftStore.save(pr, saved),
    removeDraft: (pr) => fileDraftStore.remove(pr),
  };
}

/** Runs after Ink unmounts so `claude` owns the terminal. */
async function runHandoff(pr: ClassifiedPR, config: Config): Promise<number> {
  process.stderr.write(`Preparing ${pr.repo}#${pr.number} for Claude…\n`);
  const ws = await prepareWorkspace(pr);
  try {
    const prompt = buildReviewPrompt(pr, ws, { interactive: true });
    const res = spawnSync("claude", [prompt.prompt, ...claudeArgs(prompt, config.claude.model, ws)], {
      cwd: ws.cwd,
      stdio: "inherit",
    });
    if (res.error) throw new Error(`Couldn't start claude: ${res.error.message}`);
    return res.status ?? 1;
  } finally {
    ws.cleanup();
  }
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
  let after = null as { kind: "checkout" | "handoff"; pr: ClassifiedPR } | null;
  const app = render(
    React.createElement(App, {
      load,
      initial: cached && filtered(cached),
      actions: defaultActions,
      reviewer: makeReviewer(config),
      claude: config.claude,
      collapseWaitingByDefault: config.ui.collapseWaitingByDefault,
      autoRefreshSeconds: config.ui.autoRefreshSeconds,
      onCheckout: (pr) => {
        after = { kind: "checkout", pr };
      },
      onHandoff: (pr) => {
        after = { kind: "handoff", pr };
      },
    }),
  );
  await app.waitUntilExit();

  if (after?.kind === "checkout") return runCheckout(after.pr);
  if (after?.kind === "handoff") return runHandoff(after.pr, config);
  return 0;
}
