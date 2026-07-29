import { describe, expect, it } from "vitest";
import {
  decodeSearchPlan,
  legacySearchStrategyFromPlan,
  mergeSearchEvidence
} from "./search";

describe("search plans", () => {
  it("normalizes Off and the legacy singleton request", () => {
    expect(decodeSearchPlan(undefined, "search-disabled")).toEqual({
      ok: true,
      plan: { mode: "all_selected", optionIds: [] }
    });
    expect(decodeSearchPlan(undefined, "perplexity-tool-search")).toEqual({
      ok: true,
      plan: { mode: "all_selected", optionIds: ["perplexity-tool-search"] }
    });
    expect(decodeSearchPlan(undefined, " search-disabled ")).toEqual({
      ok: true,
      plan: { mode: "all_selected", optionIds: [] }
    });
  });

  it("keeps order while rejecting duplicate, malformed, and oversized plans", () => {
    expect(decodeSearchPlan({ mode: "model_choice", optionIds: ["b", "a"] })).toEqual({
      ok: true,
      plan: { mode: "model_choice", optionIds: ["b", "a"] }
    });
    expect(decodeSearchPlan({ mode: "all_selected", optionIds: ["a", "a"] })).toMatchObject({
      code: "search_plan_duplicate_option",
      ok: false
    });
    expect(decodeSearchPlan({ mode: "all_selected", optionIds: ["a", "b", "c", "d"] })).toMatchObject({
      code: "search_plan_too_many_options",
      ok: false
    });
    expect(decodeSearchPlan({ mode: "automatic", optionIds: [] })).toMatchObject({
      code: "search_plan_invalid",
      ok: false
    });
  });

  it("projects the first option for old inspection consumers", () => {
    expect(legacySearchStrategyFromPlan({ mode: "all_selected", optionIds: [] })).toBe("search-disabled");
    expect(legacySearchStrategyFromPlan({ mode: "model_choice", optionIds: ["one", "two"] })).toBe("one");
  });
});

describe("fan-out evidence", () => {
  it("uses plan/local order, drops unsafe URLs, and deduplicates with attribution", () => {
    expect(mergeSearchEvidence(["second", "first"], [
      {
        invocationId: "inv-1",
        optionId: "first",
        sources: [
          { rank: 1, title: "Shared later", url: "https://example.test/shared#fragment" },
          { rank: 2, title: "Unsafe", url: "data:text/html,bad" }
        ]
      },
      {
        invocationId: "inv-2",
        optionId: "second",
        sources: [
          { rank: 1, title: "Second-only", url: "https://example.test/two" },
          { rank: 2, title: "Shared first", url: "https://example.test/shared" }
        ]
      }
    ])).toEqual([
      {
        engines: [{ optionId: "second", rank: 1 }],
        title: "Second-only",
        url: "https://example.test/two"
      },
      {
        engines: [
          { optionId: "second", rank: 2 },
          { optionId: "first", rank: 1 }
        ],
        title: "Shared first",
        url: "https://example.test/shared"
      }
    ]);
  });
});
