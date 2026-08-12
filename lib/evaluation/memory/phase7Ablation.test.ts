import { describe, expect, it } from "vitest";
import {
  evaluateMemoryPhase7AblationStage,
  memoryPhase7AblationPairKey,
  type MemoryPhase7AblationCandidate,
  type MemoryPhase7AblationCase
} from "./phase7Ablation";

function candidate(
  key: string,
  sourceMessageIds: readonly string[],
  overrides: Partial<MemoryPhase7AblationCandidate> = {}
): MemoryPhase7AblationCandidate {
  return {
    category: "preference",
    current: true,
    explicit: false,
    key,
    kind: "HISTORY_CHUNK",
    language: "EN",
    modality: null,
    occurredFrom: "2026-08-01T12:00:00.000Z",
    occurredTo: "2026-08-01T12:00:01.000Z",
    scopeTargetId: null,
    scopeType: null,
    sensitivity: null,
    sourceChatId: "chat-source",
    sourceFixtureId: `fixture-${key}`,
    sourceFolderId: null,
    sourceMessageIds,
    sourceMode: null,
    text: key,
    validFrom: null,
    validTo: null,
    ...overrides
  };
}

function current(
  candidates: readonly MemoryPhase7AblationCandidate[],
  overrides: Partial<MemoryPhase7AblationCase> = {}
): MemoryPhase7AblationCase {
  return {
    candidates,
    cohort: "mixed-language-terms",
    contextChatId: "chat-source",
    contextFolderId: null,
    criticalCohort: true,
    forbiddenMessageIds: [],
    key: "case-1",
    language: "EN",
    lexicalTerms: ["editor"],
    queryText: "Which editor do I prefer?",
    recallExpected: true,
    relevantMessageIds: ["message-relevant"],
    retrievalAllowed: true,
    sourceFixtureId: "fixture-case",
    variant: 1,
    ...overrides
  };
}

describe("Phase 7 staged retrieval ablation", () => {
  it("measures lexical and vector lift against the active-branch-only baseline", () => {
    const relevant = candidate("relevant editor", ["message-relevant"]);
    const input = {
      cases: [current([relevant])],
      documentVectors: new Map([[relevant.text, [1, 0]]]),
      lexicalScores: new Map<string, number>(),
      queryVectors: new Map([["Which editor do I prefer?", [1, 0]]])
    };
    expect(evaluateMemoryPhase7AblationStage({
      ...input,
      stage: "ACTIVE_BRANCH"
    }).score.EN.recallAt5).toBe(0);
    expect(evaluateMemoryPhase7AblationStage({
      ...input,
      stage: "MULTILINGUAL_VECTOR_CHUNKS"
    }).score.EN.recallAt5).toBe(1);
  });

  it("applies production scope eligibility before feature-aware fusion", () => {
    const relevant = candidate("relevant fact", ["message-relevant"], {
      kind: "FACT",
      modality: "PREFERENCE",
      scopeTargetId: "folder-current",
      scopeType: "FOLDER",
      sensitivity: "NORMAL",
      sourceMode: "AUTOMATIC",
      validFrom: "2026-08-01T12:00:00.000Z"
    });
    const wrongScope = candidate("wrong fact", ["message-other"], {
      kind: "FACT",
      modality: "PREFERENCE",
      scopeTargetId: "folder-other",
      scopeType: "FOLDER",
      sensitivity: "NORMAL",
      sourceMode: "AUTOMATIC",
      validFrom: "2026-08-01T12:00:00.000Z"
    });
    const result = evaluateMemoryPhase7AblationStage({
      cases: [current([relevant, wrongScope], {
        cohort: "scoped-project-preference",
        contextFolderId: "folder-current"
      })],
      documentVectors: new Map([
        [relevant.text, [0.8, 0.6]],
        [wrongScope.text, [1, 0]]
      ]),
      lexicalScores: new Map(),
      queryVectors: new Map([["Which editor do I prefer?", [1, 0]]]),
      stage: "TEMPORAL_SCOPE_TEMPERATURE"
    });
    expect(result.score.EN).toMatchObject({
      hardInvariantFailures: 0,
      recallAt5: 1,
      scopeAccuracy: 1
    });
    expect(result.irrelevantInjections.EN).toBe(0);
  });

  it("reports unrelated top-five context without mislabeling it as forbidden injection", () => {
    const relevant = candidate("a-relevant", ["message-relevant"]);
    const unrelated = candidate("z-unrelated", ["message-other"]);
    const result = evaluateMemoryPhase7AblationStage({
      cases: [current([relevant, unrelated])],
      documentVectors: new Map([
        [relevant.text, [1, 0]],
        [unrelated.text, [1, 0]]
      ]),
      lexicalScores: new Map(),
      queryVectors: new Map([["Which editor do I prefer?", [1, 0]]]),
      stage: "MULTILINGUAL_VECTOR_CHUNKS"
    });
    expect(result.retrievalContamination.EN).toBe(1);
    expect(result.irrelevantInjections.EN).toBe(0);
    expect(result.score.EN.recallAt5).toBe(1);
  });

  it("exposes a stable pair key for PostgreSQL lexical evidence", () => {
    expect(memoryPhase7AblationPairKey("case", "candidate"))
      .toBe("case\u0000candidate");
  });
});
