import { describe, expect, it } from "vitest";
import { memoryHistoryRelevanceTarget, rejectedMemoryHistoryHandles, type MemoryHistoryRelevanceResult } from "./historyRelevancePolicy";
import { emptyMemoryHistoryRelevanceDiagnostics } from "./historyRelevanceRuntime";

const passages = [{ handle: "a", text: "First synthetic excerpt" }, { handle: "b", text: "Second synthetic excerpt" }];
const ready: MemoryHistoryRelevanceResult = { status: "READY", reason: null,
  scores: [{ handle: "a", usefulness: 0.02 }, { handle: "b", usefulness: 0.1 }],
  diagnostics: emptyMemoryHistoryRelevanceDiagnostics(2) };

describe("Memory history relevance coverage and protection", () => {
  it("suppresses only a clear rejection, preserving uncertainty at the boundary", () => {
    expect([...rejectedMemoryHistoryHandles(passages, ready)!]).toEqual(["a"]);
    expect(rejectedMemoryHistoryHandles(passages, { ...ready, status: "UNAVAILABLE" })).toBeNull();
  });

  it.each([
    [], [ready.scores[0]!], [ready.scores[0]!, ready.scores[0]!],
    [ready.scores[0]!, { handle: "foreign", usefulness: 0 }],
    [ready.scores[0]!, { handle: "b", usefulness: NaN }],
    [ready.scores[0]!, { handle: "b", usefulness: -0.1 }],
    [ready.scores[0]!, { handle: "b", usefulness: 1.1 }]
  ])("rejects the whole invalid score set (%#)", (...scores) => {
    expect(rejectedMemoryHistoryHandles(passages, { ...ready, scores })).toBeNull();
  });

  it.each(["FACT", "EVENT", "TOOL_OBSERVATION", "HISTORY"])("protects facts irrespective of declared source kind %s", sourceKind => {
    expect(memoryHistoryRelevanceTarget({ sourceKind, candidate: { itemType: "FACT_VERSION", featureSnapshot: {} } })).toBe(false);
  });

  it.each(["EXACT_TEXT", "EXACT_ALIAS_SINGLE_ROOT", "PROFILE"])("protects the %s anchor from semantic suppression", anchor => {
    expect(memoryHistoryRelevanceTarget({ sourceKind: "HISTORY", candidate: {
      itemType: "RECALL_CHUNK", featureSnapshot: { deterministicMatches: [anchor] }
    } })).toBe(false);
    expect(memoryHistoryRelevanceTarget({ sourceKind: "HISTORY", candidate: { itemType: "RECALL_CHUNK", featureSnapshot: {} } })).toBe(true);
  });
});
