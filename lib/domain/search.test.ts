import { describe, expect, it } from "vitest";
import {
  decodeSearchPlan,
  mergeSearchEvidence
} from "./search";

describe("search plans", () => {
  it("rejects an omitted plan instead of inventing Off", () => {
    expect(decodeSearchPlan(undefined)).toEqual({
      code: "search_plan_invalid",
      ok: false
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
