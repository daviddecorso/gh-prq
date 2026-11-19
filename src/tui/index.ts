import { render } from "ink";
import React from "react";
import type { FilterFlags } from "../cli/filter.ts";
import { filterItems } from "../cli/filter.ts";
import type { Config } from "../core/config.ts";
import type { Scope } from "../core/github.ts";
import { loadCachedQueue, loadQueue } from "../core/queue.ts";
import type { ClassifiedPR, QueueResult } from "../core/types.ts";
import { defaultActions, runCheckout } from "./actions.ts";
import { App } from "./App.ts";

export interface RunTuiOptions {
  config: Config;
  scope: Scope;
  flags: FilterFlags & { refresh?: boolean };
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

  let checkout: ClassifiedPR | null = null;
  const app = render(
    React.createElement(App, {
      load,
      initial: cached && filtered(cached),
      actions: defaultActions,
      collapseWaitingByDefault: config.ui.collapseWaitingByDefault,
      autoRefreshSeconds: config.ui.autoRefreshSeconds,
      onCheckout: (pr) => {
        checkout = pr;
      },
    }),
  );
  await app.waitUntilExit();

  return checkout ? runCheckout(checkout) : 0;
}
