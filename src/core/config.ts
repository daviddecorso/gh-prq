import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  claude: {
    mode: "local" | "remote";
    model: string;
    remoteRepos: string[];
    confirmBeforePosting: boolean;
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
  };
}

export const DEFAULT_CONFIG: Config = {
  claude: {
    mode: "local",
    model: "sonnet",
    remoteRepos: [],
    confirmBeforePosting: true,
  },
  filters: {
    ignoredBots: [
      "dependabot[bot]",
      "renovate[bot]",
      "vercel[bot]",
      "github-actions[bot]",
      "codecov[bot]",
      "claude[bot]",
    ],
    ignoredBotPattern: "\\[bot\\]$",
    includeTeamRequests: true,
    mutedTeams: [],
    excludeRepos: [],
  },
  ui: {
    cacheTtlSeconds: 30,
    collapseWaitingByDefault: true,
    showDrafts: false,
  },
};

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "gh-prq", "config.json");
}

export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) return DEFAULT_CONFIG;

  let user: Partial<{ [K in keyof Config]: Partial<Config[K]> }>;
  try {
    user = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Invalid config at ${path}: ${(err as Error).message}`);
  }

  return {
    claude: { ...DEFAULT_CONFIG.claude, ...user.claude },
    filters: { ...DEFAULT_CONFIG.filters, ...user.filters },
    ui: { ...DEFAULT_CONFIG.ui, ...user.ui },
  };
}
