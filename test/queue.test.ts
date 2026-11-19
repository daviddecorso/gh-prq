import { describe, expect, test } from "vitest";
import { repoMatcher } from "../src/core/queue.ts";

describe("repoMatcher", () => {
  const matches = (patterns: string[], repo: string) => repoMatcher(patterns)(repo);

  test("exact owner/name", () => {
    expect(matches(["acme/api"], "acme/api")).toBe(true);
    expect(matches(["acme/api"], "acme/api-gateway")).toBe(false);
  });

  test("owner glob", () => {
    expect(matches(["acme/*"], "Acme/web")).toBe(true);
    expect(matches(["acme/*"], "other/web")).toBe(false);
  });

  test("a bare name matches under any owner", () => {
    expect(matches(["legacy-*"], "acme/legacy-billing")).toBe(true);
    expect(matches(["web"], "acme/web")).toBe(true);
    expect(matches(["web"], "acme/website")).toBe(false);
  });

  test("regex characters are literal", () => {
    expect(matches(["a.b"], "acme/axb")).toBe(false);
  });
});
