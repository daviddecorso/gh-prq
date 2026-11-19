#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig } from "../core/config.ts";
import { resolveCurrentRepo } from "../core/github.ts";
import { loadQueue } from "../core/queue.ts";
import type { BucketId, ClassifiedPR } from "../core/types.ts";
import { renderPlain } from "./plain.ts";

const HELP = `gh prq — turn-based pull request queue

Usage: gh prq [flags]

  --plain            Grouped table on stdout (default until the TUI lands)
  --json             ClassifiedPR[] as JSON
  --repo <o/r|.>     Scope to one repo ("." = current git repo)
  --org <org>        Scope to an organization
  --reviews          Only reviewer buckets
  --mine             Only your own PRs
  --all              Include PRs you've approved and drafts
  --refresh          Bypass the local cache
  -h, --help         Show this help
`;

const REVIEWER_BUCKETS: ReadonlySet<BucketId> = new Set([
  "NEEDS_REREVIEW",
  "NEEDS_INITIAL_REVIEW",
  "WAITING_ON_AUTHOR",
]);

async function main() {
  const { values: args } = parseArgs({
    options: {
      plain: { type: "boolean" },
      json: { type: "boolean" },
      repo: { type: "string" },
      org: { type: "string" },
      reviews: { type: "boolean" },
      mine: { type: "boolean" },
      all: { type: "boolean" },
      refresh: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.reviews && args.mine) throw new Error("--reviews and --mine can't be combined.");

  const config = loadConfig();
  const result = await loadQueue({
    config,
    repo: args.repo === "." ? resolveCurrentRepo() : args.repo,
    org: args.org,
    refresh: args.refresh,
    includeApproved: args.all,
  });

  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);

  const isMine = (pr: ClassifiedPR) => pr.author === result.viewer;
  let items = result.items;
  if (args.reviews) items = items.filter((pr) => !isMine(pr) && (REVIEWER_BUCKETS.has(pr.bucket) || pr.bucket === "DRAFTS"));
  if (args.mine) items = items.filter(isMine);

  if (!args.all && !config.ui.showDrafts) items = items.filter((pr) => pr.bucket !== "DRAFTS");

  if (args.json) {
    if (result.staleReason) process.stderr.write(`warning: stale cache (${result.staleReason})\n`);
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }

  // TODO(phase 2): launch the Ink TUI when stdout is a TTY and --plain isn't set.
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  process.stdout.write(`${renderPlain({ ...result, items }, { color })}\n`);
}

main().catch((err: Error) => {
  process.stderr.write(`gh-prq: ${err.message}\n`);
  process.exit(1);
});
