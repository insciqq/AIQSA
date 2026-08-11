import { describe, expect, it } from "vitest";
import {
  evaluateMemoryRecallRelease,
  memoryRecallReleaseEmbeddingTexts,
  type MemoryRecallReleaseCase
} from "./recallRelease";

function current(overrides: Partial<MemoryRecallReleaseCase> = {}): MemoryRecallReleaseCase {
  return {
    candidates: [{
      key: "candidate-1",
      kind: "HISTORY_CHUNK",
      sourceMessageIds: ["message-1"],
      text: "preferred editor zed"
    }],
    cohort: "preference",
    criticalCohort: true,
    forbiddenMessageIds: [],
    key: "case-1",
    language: "EN",
    lexicalTerms: ["editor", "prefer"],
    queryText: "which editor do i prefer",
    recallExpected: true,
    relevantMessageIds: ["message-1"],
    retrievalAllowed: true,
    ...overrides
  };
}

describe("Memory recall release evaluator", () => {
  it("deduplicates embedding input without returning raw case identities", () => {
    const texts = memoryRecallReleaseEmbeddingTexts([current(), current({ key: "case-2" })]);
    expect(texts).toEqual({
      documents: ["preferred editor zed"],
      queries: ["which editor do i prefer"]
    });
  });

  it("scores Recall@5, critical cohorts, diversity, and irrelevant injection", () => {
    const cases = [
      current(),
      current({
        candidates: [{
          key: "candidate-irrelevant",
          kind: "FACT",
          sourceMessageIds: ["message-tea"],
          text: "tea without sugar"
        }],
        cohort: "irrelevant-memory",
        criticalCohort: true,
        key: "case-2",
        queryText: "kubernetes readiness probe",
        recallExpected: false,
        relevantMessageIds: []
      })
    ];
    const result = evaluateMemoryRecallRelease({
      cases,
      documentVectors: new Map([
        ["preferred editor zed", [1, 0]],
        ["tea without sugar", [1, 0]]
      ]),
      lexicalScores: new Map(),
      minimumVectorScore: 0.5,
      queryVectors: new Map([
        ["which editor do i prefer", [1, 0]],
        ["kubernetes readiness probe", [1, 0]]
      ]),
      topK: 5
    });
    expect(result.binary.map(({ outcome }) => outcome.positive)).toEqual([false, true]);
    expect(result.ranked.filter(({ outcome }) =>
      outcome.metric === "CURATED_RECALL_AT_5"
    )).toHaveLength(2);
    expect(result.summary).toMatchObject({
      candidateKindsSelected: { FACT: 1, HISTORY_CHUNK: 1, RUN_SNAPSHOT: 0 },
      irrelevantInjections: { EN: 1, RU: 0 },
      queriesAdmitted: { EN: 2, RU: 0 },
      recallQueries: { EN: 1, RU: 0 },
      selectionModes: { HYBRID: 0, LEXICAL_ONLY: 0, VECTOR_ONLY: 2 }
    });
  });

  it("fails closed when admission or the vector threshold rejects a candidate", () => {
    const result = evaluateMemoryRecallRelease({
      cases: [current({ retrievalAllowed: false })],
      documentVectors: new Map([["preferred editor zed", [1, 0]]]),
      lexicalScores: new Map(),
      minimumVectorScore: 0.5,
      queryVectors: new Map([["which editor do i prefer", [1, 0]]]),
      topK: 5
    });
    expect(result.ranked.find(({ outcome }) =>
      outcome.metric === "CURATED_RECALL_AT_5" && outcome.cohort === "overall"
    )?.outcome.score).toBe(0);
    expect(result.summary.candidateKindsSelected).toEqual({
      FACT: 0,
      HISTORY_CHUNK: 0,
      RUN_SNAPSHOT: 0
    });
  });

  it("admits a lexical match when the vector score stays below threshold", () => {
    const result = evaluateMemoryRecallRelease({
      cases: [current()],
      documentVectors: new Map([["preferred editor zed", [0, 1]]]),
      lexicalScores: new Map([["case-1\u0000candidate-1", 0.4]]),
      minimumVectorScore: 0.5,
      queryVectors: new Map([["which editor do i prefer", [1, 0]]]),
      topK: 5
    });
    expect(result.ranked.find(({ outcome }) =>
      outcome.metric === "CURATED_RECALL_AT_5" && outcome.cohort === "overall"
    )?.outcome.score).toBe(1);
    expect(result.summary.selectionModes).toEqual({
      HYBRID: 0,
      LEXICAL_ONLY: 1,
      VECTOR_ONLY: 0
    });
  });
});
