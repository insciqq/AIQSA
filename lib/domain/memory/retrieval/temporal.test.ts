import { describe, expect, it } from "vitest";
import type {
  MemoryCandidateMetadata,
  MemoryRankedCandidate,
  MemoryRetrievalPlan
} from "./contracts";
import { planMemoryRetrieval } from "./planner";
import { resolveMemoryTemporalCandidate } from "./temporal";

const now = new Date("2026-08-10T12:00:00.000Z");

function plan(text: string): MemoryRetrievalPlan {
  return planMemoryRetrieval({ currentUserText: text, now });
}

function metadata(overrides: Partial<MemoryCandidateMetadata> = {}): MemoryCandidateMetadata {
  return {
    canonicalKey: "travel.plan",
    category: "travel",
    confidence: 0.9,
    conflict: false,
    current: true,
    dedupeKey: "travel",
    directness: "DIRECT",
    factId: "fact-travel",
    historical: false,
    historySafetyClass: null,
    importance: 0.6,
    languageCode: "ru",
    modality: "STATE",
    occurredFrom: null,
    occurredTo: null,
    pinned: false,
    scopeAffinity: 1,
    scopeType: "GLOBAL_USER",
    sensitivityClass: "NORMAL",
    sourceAssistantId: null,
    sourceChatId: null,
    sourceFolderId: null,
    sourceMode: "AUTOMATIC",
    systemFrom: new Date("2025-01-01T00:00:00.000Z"),
    temperatureClass: "WARM",
    validFrom: new Date("2025-07-01T00:00:00.000Z"),
    validTo: new Date("2025-08-01T00:00:00.000Z"),
    ...overrides
  };
}

function ranked(overrides: Partial<MemoryCandidateMetadata> = {}): MemoryRankedCandidate {
  return {
    entryId: null,
    featureSnapshot: {
      conflictPenalty: 0,
      currentness: 1,
      directness: 1,
      exactCanonical: 1,
      exactEntity: 0,
      explicitAuthority: 0,
      featureVersion: "test",
      importance: 0.6,
      languageMatch: 1,
      pinned: 0,
      scopeAffinity: 1,
      sensitivityPenalty: 0,
      sourceRecency: 0.5,
      temporalFit: 1,
      temperature: 0.6
    },
    finalScore: 1,
    itemId: "version-travel",
    itemType: "FACT_VERSION",
    laneRanks: { FACT_TEMPORAL: 1 },
    metadata: metadata(overrides),
    rrfScore: 1 / 61,
    selectionReason: "fact_temporal"
  };
}

describe("Memory temporal resolver", () => {
  it("omits historical versions for a current-state query", () => {
    expect(resolveMemoryTemporalCandidate(
      plan("Какой мой текущий план поездки?"),
      ranked({ current: false, historical: true })
    )).toMatchObject({ disposition: "OMIT", reason: "historical_not_requested" });
  });

  it("includes only versions overlapping an exact requested interval", () => {
    const temporalPlan = plan("Что я планировал на 2025-07-14?");
    expect(resolveMemoryTemporalCandidate(
      temporalPlan,
      ranked({ current: false, historical: true })
    )).toMatchObject({ disposition: "INCLUDE_QUALIFIED", reason: "historical_qualified" });
    expect(resolveMemoryTemporalCandidate(
      temporalPlan,
      ranked({
        current: false,
        historical: true,
        validFrom: new Date("2025-08-01T00:00:00.000Z"),
        validTo: new Date("2025-09-01T00:00:00.000Z")
      })
    )).toMatchObject({ disposition: "OMIT", reason: "outside_requested_time" });
    expect(resolveMemoryTemporalCandidate(
      temporalPlan,
      ranked({ current: true, historical: false, validFrom: null, validTo: null })
    )).toMatchObject({ disposition: "OMIT", reason: "outside_requested_time" });
  });

  it("does not substitute an undated current fact for historical intent", () => {
    expect(resolveMemoryTemporalCandidate(
      plan("Что я предпочитал раньше?"),
      ranked({ current: true, historical: false, validFrom: null, validTo: null })
    )).toMatchObject({ disposition: "OMIT", reason: "current_fact_not_historical" });
  });

  it("does not guess historical truth from an ambiguous month", () => {
    expect(resolveMemoryTemporalCandidate(
      plan("Что я планировал в июле?"),
      ranked({ current: false, historical: true })
    )).toMatchObject({ disposition: "OMIT", reason: "temporal_time_ambiguous" });
    expect(resolveMemoryTemporalCandidate(
      plan("Что я планировал в июле?"),
      ranked({ current: true, historical: false })
    )).toMatchObject({ disposition: "OMIT", reason: "temporal_time_ambiguous" });
  });

  it("qualifies plans and unresolved conflicts instead of asserting completion", () => {
    const currentPlan = plan("Какой мой текущий план поездки?");
    const unconfirmed = resolveMemoryTemporalCandidate(
      currentPlan,
      ranked({ modality: "PLAN" })
    );
    expect(unconfirmed).toMatchObject({
      disposition: "INCLUDE_QUALIFIED",
      reason: "unconfirmed_modality"
    });
    expect(unconfirmed.qualification).toContain("подтверждения исполнения нет");

    const conflict = resolveMemoryTemporalCandidate(
      currentPlan,
      ranked({ conflict: true })
    );
    expect(conflict).toMatchObject({ disposition: "INCLUDE_QUALIFIED", reason: "unresolved_conflict" });
    expect(conflict.qualification).toContain("нерешённое противоречие");
  });
});
