import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_IDS, type AgentId } from "./review/agents.ts";

export const REVIEW_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReviewEffort = (typeof REVIEW_EFFORTS)[number];

/** The pre-`agent` config block, still read so existing config files keep working. */
interface LegacyClaudeConfig {
  model?: string;
  confirmBeforePosting?: boolean;
  maxConcurrent?: number;
}

export interface Config {
  agent: {
    default: AgentId;
    /** A missing entry uses the CLI's own default model. */
    models: Partial<Record<AgentId, string>>;
    confirmBeforePosting: boolean;
    /** Headless reviews that run at once; the rest queue. */
    maxConcurrent: number;
    /** Claude runs its bundled /code-review and /steward instead of our prompts. */
    claudeBuiltins: boolean;
    /** Effort level for /code-review; unset reuses the level last typed in Claude Code. */
    reviewEffort?: ReviewEffort;
  };
  filters: {
    ignoredBots: string[];
    ignoredBotPattern: string;
    includeTeamRequests: boolean;
    mutedTeams: string[];
    excludeRepos: string[];
  };
  ui: {
    cacheTtlSeconds: number;
    collapseWaitingByDefault: boolean;
    showDrafts: boolean;
    showDetailByDefault: "auto" | boolean;
    /** TUI background refresh interval; 0 disables. */
    autoRefreshSeconds: number;
  };
}

export const DEFAULT_CONFIG: Config = {
  agent: {
    default: "claude",
    models: { claude: "sonnet" },
    confirmBeforePosting: true,
    maxConcurrent: 2,
    claudeBuiltins: true,
  },
  filters: {
    ignoredBots: ["dependabot[bot]", "renovate[bot]", "vercel[bot]", "github-actions[bot]", "codecov[bot]", "claude[bot]"],
    ignoredBotPattern: "\\[bot\\]$",
    includeTeamRequests: true,
    mutedTeams: [],
    excludeRepos: [],
  },
  ui: {
    cacheTtlSeconds: 30,
    collapseWaitingByDefault: true,
    showDrafts: false,
    showDetailByDefault: "auto",
    autoRefreshSeconds: 300,
  },
};

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "gh-prq", "config.json");
}

export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) return DEFAULT_CONFIG;

  let user: Partial<{ [K in keyof Config]: Partial<Config[K]> }> & { claude?: LegacyClaudeConfig };
  try {
    user = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Invalid config at ${path}: ${(err as Error).message}`);
  }

  const { model: legacyModel, confirmBeforePosting, maxConcurrent } = user.claude ?? {};
  const config: Config = {
    agent: {
      ...DEFAULT_CONFIG.agent,
      ...(confirmBeforePosting !== undefined && { confirmBeforePosting }),
      ...(maxConcurrent !== undefined && { maxConcurrent }),
      ...user.agent,
      models: {
        ...DEFAULT_CONFIG.agent.models,
        ...(legacyModel !== undefined && { claude: legacyModel }),
        ...user.agent?.models,
      },
    },
    filters: { ...DEFAULT_CONFIG.filters, ...user.filters },
    ui: { ...DEFAULT_CONFIG.ui, ...user.ui },
  };
  if (!(AGENT_IDS as readonly string[]).includes(config.agent.default)) {
    throw new Error(`Invalid config: agent.default in ${path} must be one of ${AGENT_IDS.join(", ")}.`);
  }
  const effort = config.agent.reviewEffort;
  if (effort !== undefined && !(REVIEW_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`Invalid config: agent.reviewEffort in ${path} must be one of ${REVIEW_EFFORTS.join(", ")}.`);
  }
  if (typeof config.ui.showDetailByDefault !== "boolean" && config.ui.showDetailByDefault !== "auto") {
    throw new Error(`Invalid config: ui.showDetailByDefault in ${path} must be "auto", true, or false.`);
  }
  const list = (value: unknown, field: string) => toStringList(value, `${field} in ${path}`);
  config.filters.ignoredBots = list(config.filters.ignoredBots, "filters.ignoredBots");
  config.filters.mutedTeams = list(config.filters.mutedTeams, "filters.mutedTeams");
  config.filters.excludeRepos = list(config.filters.excludeRepos, "filters.excludeRepos");
  return config;
}

/** Accepts a bare string as a one-item list; spreading it would otherwise split it into characters. */
function toStringList(value: unknown, field: string): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
  throw new Error(`Invalid config: ${field} must be a string or an array of strings.`);
}
