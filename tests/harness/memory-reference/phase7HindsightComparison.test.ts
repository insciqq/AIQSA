import { describe, expect, it } from "vitest";
import type { MemoryCorpusFixture } from
  "../../fixtures/memory-evaluation/shared/corpusTypes";
import {
  scoreMemoryPhase7HindsightCases,
  selectMemoryPhase7HindsightFixtures
} from "./phase7HindsightComparison";

function fixture(input: Readonly<{
  cohort?: string;
  id: string;
  language?: "EN" | "RU";
  remoteCallsAllowed?: boolean;
  temporal?: boolean;
}>): MemoryCorpusFixture {
  const cohort = input.temporal ? "temporal-correction" : input.cohort ?? "slang-typo";
  const sourceId = `${input.id}-source`;
  return {
    actions: [],
    adjudicationId: `${input.id}-adjudication`,
    chats: [],
    cohort,
    corpusVersion: "memory-corpus-v2",
    dataClass: "SYNTHETIC",
    expectedEgress: {
      allowedDestinations: input.remoteCallsAllowed === false ? ["LOCAL_ONLY"] : ["EMBEDDING"],
      remoteCallsAllowed: input.remoteCallsAllowed !== false,
      requiresAcceptedFingerprint: input.remoteCallsAllowed !== false
    },
    expectedFacts: [{
      category: "preference",
      displayText: input.temporal ? "The user now prefers Helix." : "The user prefers small commits.",
      modality: "PREFERENCE",
      scope: { targetId: null, type: "GLOBAL_USER" },
      sensitivity: "NORMAL",
      sourceMessageIds: [sourceId],
      state: "ACTIVE",
      validFrom: null,
      validTo: null
    }],
    expectedLifecycle: {
      events: [],
      sourceEligible: true,
      terminalFactState: "ACTIVE"
    },
    expectedSafety: {
      automaticPromotionAllowed: true,
      hardInvariantCodes: [],
      toolEgress: input.remoteCallsAllowed === false ? "DENY" : "REQUIRE_ACCEPTED_DESTINATION"
    },
    forbiddenFacts: [{
      reason: "NOT_ESTABLISHED",
      sourceMessageIds: [sourceId],
      text: input.temporal ? "The user now prefers Vim." : "The user prefers huge commits."
    }],
    groupId: `${input.id}-group`,
    id: input.id,
    language: input.language ?? "EN",
    queries: [{
      expectedOutcome: "RECALL",
      forbiddenMessageIds: [],
      id: `${input.id}-query`,
      language: input.language ?? "EN",
      relevantMessageIds: [sourceId],
      requestingUserId: `${input.id}-user`,
      text: "What do I prefer?"
    }],
    schemaVersion: "memory-corpus-schema-v2",
    split: "HOLDOUT",
    tags: [],
    users: [`${input.id}-user`]
  } as MemoryCorpusFixture;
}

describe("Phase 7 Hindsight comparison", () => {
  it("selects one stable fixture per cohort and language", () => {
    const fixtures = ["EN", "RU"].flatMap((language) =>
      [1, 2, 3].map((index) => fixture({
        id: `${language.toLowerCase()}-${index}`,
        language: language as "EN" | "RU"
      }))
    );
    const first = selectMemoryPhase7HindsightFixtures({
      criticalCohorts: ["slang-typo"], fixtures, randomSeed: 73471
    });
    const second = selectMemoryPhase7HindsightFixtures({
      criticalCohorts: ["slang-typo"], fixtures: [...fixtures].reverse(), randomSeed: 73471
    });
    expect(first.map(({ id }) => id)).toEqual(second.map(({ id }) => id));
    expect(first).toHaveLength(2);
  });

  it("uses document grounding and temporal lexical contrast", () => {
    const current = fixture({ id: "temporal", temporal: true });
    const russian = fixture({ id: "temporal-ru", language: "RU", temporal: true });
    const scored = scoreMemoryPhase7HindsightCases([current, russian].map((value) => ({
      fixture: value,
      providerCallPerformed: true,
      results: [{ documentId: value.id, text: "The user now prefers Helix." }]
    })));
    expect(scored.metrics).toMatchObject({
      factPrecision: 1,
      factRecall: 1,
      temporalAccuracy: 1
    });
    expect(scoreMemoryPhase7HindsightCases([current, russian].map((value) => ({
      fixture: value,
      providerCallPerformed: true,
      results: [{ documentId: value.id, text: "The user now prefers Vim." }]
    }))).metrics).toMatchObject({
      factPrecision: 0,
      factRecall: 0,
      temporalAccuracy: 0
    });
  });

  it("rejects provider egress for a local-only case", () => {
    const current = fixture({ id: "local-only", remoteCallsAllowed: false });
    expect(() => scoreMemoryPhase7HindsightCases([{
      fixture: current,
      providerCallPerformed: true,
      results: []
    }])).toThrow("memory_phase7_hindsight_local_only_egress");
  });
});
