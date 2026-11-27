import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function configFile(contents: unknown): string {
  dir = mkdtempSync(join(tmpdir(), "gh-prq-config-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe("loadConfig agent", () => {
  test("defaults to claude on sonnet", () => {
    expect(loadConfig(configFile({})).agent).toEqual(DEFAULT_CONFIG.agent);
  });

  test("a legacy claude block still applies", () => {
    const { agent } = loadConfig(configFile({ claude: { model: "opus", maxConcurrent: 4, confirmBeforePosting: false } }));
    expect(agent).toMatchObject({ default: "claude", models: { claude: "opus" }, maxConcurrent: 4, confirmBeforePosting: false });
  });

  test("the agent block wins over the legacy block and merges models", () => {
    const { agent } = loadConfig(
      configFile({
        claude: { model: "opus", maxConcurrent: 4 },
        agent: { default: "gemini", maxConcurrent: 1, models: { gemini: "pro" } },
      }),
    );
    expect(agent).toMatchObject({ default: "gemini", maxConcurrent: 1, models: { claude: "opus", gemini: "pro" } });
  });

  test("claude builtins default on and reviewEffort is validated", () => {
    expect(DEFAULT_CONFIG.agent.claudeBuiltins).toBe(true);
    expect(loadConfig(configFile({ agent: { reviewEffort: "high" } })).agent.reviewEffort).toBe("high");
    expect(() => loadConfig(configFile({ agent: { reviewEffort: "huge" } }))).toThrow("agent.reviewEffort");
  });

  test("an unknown default agent is rejected", () => {
    expect(() => loadConfig(configFile({ agent: { default: "gpt" } }))).toThrow("agent.default");
  });

  test("ui.showDetailByDefault accepts auto and booleans and rejects other values", () => {
    expect(loadConfig(configFile({})).ui.showDetailByDefault).toBe("auto");
    expect(loadConfig(configFile({ ui: { showDetailByDefault: true } })).ui.showDetailByDefault).toBe(true);
    expect(loadConfig(configFile({ ui: { showDetailByDefault: false } })).ui.showDetailByDefault).toBe(false);
    expect(() => loadConfig(configFile({ ui: { showDetailByDefault: "wide" } }))).toThrow("showDetailByDefault");
  });

  test("maxConcurrent must be a whole number of at least 1", () => {
    expect(() => loadConfig(configFile({ agent: { maxConcurrent: 0 } }))).toThrow("agent.maxConcurrent");
    expect(() => loadConfig(configFile({ agent: { maxConcurrent: 1.5 } }))).toThrow("agent.maxConcurrent");
    expect(() => loadConfig(configFile({ claude: { maxConcurrent: "2" } }))).toThrow("agent.maxConcurrent");
    expect(loadConfig(configFile({ agent: { maxConcurrent: 3 } })).agent.maxConcurrent).toBe(3);
  });
});

describe("loadConfig ui and filters", () => {
  test("refresh and cache intervals must be non-negative numbers", () => {
    expect(loadConfig(configFile({ ui: { autoRefreshSeconds: 0 } })).ui.autoRefreshSeconds).toBe(0);
    expect(() => loadConfig(configFile({ ui: { autoRefreshSeconds: "60" } }))).toThrow("ui.autoRefreshSeconds");
    expect(() => loadConfig(configFile({ ui: { cacheTtlSeconds: -1 } }))).toThrow("ui.cacheTtlSeconds");
  });

  test("an invalid ignoredBotPattern is reported at load", () => {
    expect(() => loadConfig(configFile({ filters: { ignoredBotPattern: "[bot" } }))).toThrow("not a valid regex");
    expect(loadConfig(configFile({ filters: { ignoredBotPattern: "^ci-" } })).filters.ignoredBotPattern).toBe("^ci-");
  });
});
