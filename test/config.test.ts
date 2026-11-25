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
});
