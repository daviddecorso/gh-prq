#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig } from "../core/config.ts";
import { resolveCurrentRepo } from "../core/github.ts";
import { loadQueue } from "../core/queue.ts";
import { filterItems } from "./filter.ts";
import { renderJson } from "./json.ts";
import { renderPlain } from "./plain.ts";

const HELP = `gh prq — turn-based pull request queue

Usage: gh prq [flags]

  --plain            Grouped table on stdout (default when not a TTY)
  --json             ClassifiedPR[] as JSON
  --envelope         With --json, wrap the items as { viewer, fetchedAt, staleReason, warnings, items }
  --repo <o/r|.>     Scope to one repo ("." = current git repo)
  --org <org>        Scope to an organization
  --exclude <glob>   Hide repos matching a name or glob, repeatable ("legacy-*", "acme/*")
  --reviews          Only reviewer buckets
  --mine             Only your own PRs (add --all for your drafts)
  --all              Include PRs you've approved and drafts
  --refresh          Bypass the local cache
  -h, --help         Show this help
`;

function parseFlags() {
  try {
    return parseArgs({
      options: {
        plain: { type: "boolean" },
        json: { type: "boolean" },
        envelope: { type: "boolean" },
        repo: { type: "string" },
        org: { type: "string" },
        exclude: { type: "string", multiple: true },
        reviews: { type: "boolean" },
        mine: { type: "boolean" },
        all: { type: "boolean" },
        refresh: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }).values;
  } catch (err) {
    throw new Error(`${(err as Error).message}\nRun \`gh prq --help\` for usage.`);
  }
}

async function main(): Promise<number> {
  const args = parseFlags();

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.reviews && args.mine) throw new Error("--reviews and --mine can't be combined.");
  if (args.envelope && !args.json) throw new Error("--envelope only applies to --json.");

  const baseConfig = loadConfig();
  const config = {
    ...baseConfig,
    filters: { ...baseConfig.filters, excludeRepos: [...baseConfig.filters.excludeRepos, ...(args.exclude ?? [])] },
  };
  const scope = { repo: args.repo === "." ? resolveCurrentRepo() : args.repo, org: args.org };

  if (!args.json && !args.plain && process.stdout.isTTY && process.stdin.isTTY) {
    const { runTui } = await import("../tui/index.ts");
    return runTui({ config, scope, flags: args });
  }

  const result = await loadQueue({ config, ...scope, refresh: args.refresh, includeApproved: args.all });
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
  const items = filterItems(result, args, config);

  if (args.json) {
    if (result.staleReason) process.stderr.write(`warning: stale cache (${result.staleReason})\n`);
    process.stdout.write(`${renderJson(result, items, { envelope: args.envelope })}\n`);
    return 0;
  }

  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  process.stdout.write(`${renderPlain({ ...result, items }, { color })}\n`);
  return 0;
}

// A closed downstream pipe (`gh prq | head`) isn't an error worth a stack trace.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: Error) => {
    process.stderr.write(`gh-prq: ${err.message}\n`);
    process.exit(1);
  });
