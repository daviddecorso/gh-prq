import { describe, expect, test } from "vitest";
import { renderJson } from "../src/cli/json.ts";
import { item, result } from "./fixtures.ts";

describe("renderJson", () => {
  const items = [item("a", "NEEDS_INITIAL_REVIEW"), item("b", "MY_PR_READY")];

  test("without --envelope prints the bare item array", () => {
    expect(JSON.parse(renderJson(result(items), items))).toEqual(JSON.parse(JSON.stringify(items)));
  });

  test("--envelope wraps the items with freshness and warnings", () => {
    const res = result(items, { warnings: ["SAML blocked acme"], staleReason: "network down" });
    const out = JSON.parse(renderJson(res, items.slice(1), { envelope: true }));
    expect(out).toEqual({
      viewer: res.viewer,
      fetchedAt: res.fetchedAt,
      staleReason: "network down",
      warnings: ["SAML blocked acme"],
      items: JSON.parse(JSON.stringify(items.slice(1))),
    });
  });

  test("--envelope reports a fresh result as staleReason null", () => {
    expect(JSON.parse(renderJson(result(items), items, { envelope: true })).staleReason).toBeNull();
  });
});
