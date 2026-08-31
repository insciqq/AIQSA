import { describe, expect, it } from "vitest";
import type { MemoryCandidateMetadata, MemoryRankedCandidate } from "./contracts";
import {
  applyMemoryDecay,
  memoryDecayFactor,
  MEMORY_DECAY_MAX_FACTOR,
  MEMORY_DECAY_MIN_FACTOR,
  MEMORY_DECAY_POLICY_VERSION
} from "./decay";

const NOW = new Date("2026-08-24T12:00:00.000Z");

function metadata(
  overrides: Partial<MemoryCandidateMetadata> = {}
): MemoryCandidateMetadata {
  return {
    canonicalKey: null,
    category: "memory",
    confidence: 0.9,
    conflict: false,
    coreEligible: false,
    coreSalience: "NONE",
    current: true,
    dedupeKey: "fact-1",
    directness: "DIRECT",
    dimensionKey: null,
    entityIds: [],
    expectedAt: null,
    expiresAt: null,
    factId: "fact-1",
    historical: false,
    historySafetyClass: null,
    importance: 0.7,
    identityKind: "PROPOSITION",
    languageCode: "und",
    lastConfirmedAt: null,
    lastUsedAt: null,
    lifecycleState: "ACTIVE",
    matchedEntityRole: null,
    modality: "PREFERENCE",
    observedAt: new Date("2025-08-24T12:00:00.000Z"),
    occurredAt: null,
    occurredFrom: null,
    occurredTo: null,
    pinned: false,
    predicateKey: null,
    relationDepth: 0,
    scopeAffinity: 1,
    scopeType: "GLOBAL_USER",
    sensitivityClass: "NORMAL",
    sourceAssistantId: null,
    sourceAuthority: "DIRECT_AUTOMATIC",
    sourceChatId: null,
    sourceFolderId: null,
    sourceMode: "AUTOMATIC",
    subjectKey: null,
    synthesisDepth: 0,
    systemFrom: new Date("2025-08-24T12:00:00.000Z"),
    temperatureClass: "WARM",
    temperatureScore: 0,
    validFrom: null,
    validTo: null,
    ...overrides
  };
}

function candidate(
  id: string,
  finalScore: number,
  overrides: Partial<MemoryCandidateMetadata> = {}
): MemoryRankedCandidate {
  return {
    entryId: `entry-${id}`,
    featureSnapshot: {
      authorityRank: 2,
      fusionVersion: "test-rrf",
      laneCount: 1,
      temporalFit: 1,
      tier: "DYNAMIC"
    },
    finalScore,
    itemId: id,
    itemType: "FACT_VERSION",
    laneRanks: { FACT_LEXICAL_UNICODE: 1 },
    metadata: metadata({ dedupeKey: id, factId: id, ...overrides }),
    rrfScore: 0.1,
    selectionReason: "semantic_relevance"
  };
}

describe("Memory ranking decay v1", () => {
  it("is byte-for-byte and reference equivalent while disabled or policy-incompatible", () => {
    const baseline = [candidate("first", 0.7), candidate("second", 0.8)];
    const serialized = JSON.stringify(baseline);
    const disabled = applyMemoryDecay(baseline, {
      enabled: false,
      mode: "TARGETED_CURRENT",
      now: NOW,
      policyVersion: MEMORY_DECAY_POLICY_VERSION
    });
    const incompatible = applyMemoryDecay(baseline, {
      enabled: true,
      mode: "TARGETED_CURRENT",
      now: NOW,
      policyVersion: "memory-decay-future"
    });
    expect(disabled).toBe(baseline);
    expect(incompatible).toBe(baseline);
    expect(JSON.stringify(disabled)).toBe(serialized);
  });

  it("stays within policy bounds for bounded age and retained-use combinations", () => {
    for (const ageDays of [0, 1, 30, 180, 1_000, 100_000]) {
      for (const temperatureScore of [0, 0.05, 0.5, 1]) {
        for (const sourceAuthority of ["DIRECT_AUTOMATIC", "EXPLICIT", "SYNTHESIS"] as const) {
          const result = memoryDecayFactor(metadata({
            lastUsedAt: new Date(NOW.getTime() - ageDays * 86_400_000),
            modality: sourceAuthority === "SYNTHESIS" ? "PATTERN" : "PREFERENCE",
            sourceAuthority,
            temperatureScore
          }), { historical: false, now: NOW });
          expect(result.factor).toBeGreaterThanOrEqual(MEMORY_DECAY_MIN_FACTOR);
          expect(result.factor).toBeLessThanOrEqual(MEMORY_DECAY_MAX_FACTOR);
        }
      }
    }
  });

  it("reorders but never removes already-relevant candidates", () => {
    const oldUnused = candidate("old-unused", 0.9, {
      observedAt: new Date("2020-01-01T00:00:00.000Z")
    });
    const reused = candidate("reused", 0.7, {
      lastUsedAt: new Date("2026-08-24T11:00:00.000Z"),
      temperatureScore: 1
    });
    const ranked = applyMemoryDecay([oldUnused, reused], {
      enabled: true,
      mode: "TARGETED_CURRENT",
      now: NOW,
      policyVersion: MEMORY_DECAY_POLICY_VERSION
    });
    expect(ranked.map(({ itemId }) => itemId)).toEqual(["reused", "old-unused"]);
    expect(new Set(ranked.map(({ itemId }) => itemId))).toEqual(
      new Set(["old-unused", "reused"])
    );
    expect(ranked.every(({ finalScore }) => finalScore === 0.7 || finalScore === 0.9))
      .toBe(true);
  });

  it("keeps explicit or pinned current SLOT at a neutral floor", () => {
    for (const authority of [
      { pinned: false, sourceAuthority: "EXPLICIT" as const },
      { pinned: true, sourceAuthority: "DIRECT_AUTOMATIC" as const }
    ]) {
      const result = memoryDecayFactor(metadata({
        identityKind: "SLOT",
        observedAt: new Date("2000-01-01T00:00:00.000Z"),
        pinned: authority.pinned,
        sourceAuthority: authority.sourceAuthority
      }), { historical: false, now: NOW });
      expect(result.factor).toBeGreaterThanOrEqual(1);
    }
  });

  it("dampens old direct memories less in explicit historical mode", () => {
    const old = metadata({
      current: false,
      historical: true,
      lifecycleState: "SUPERSEDED",
      observedAt: new Date("2018-01-01T00:00:00.000Z")
    });
    expect(memoryDecayFactor(old, { historical: true, now: NOW }).factor)
      .toBeGreaterThan(memoryDecayFactor(old, { historical: false, now: NOW }).factor);
  });

  it("ignores future expectedAt and makes enable-disable-re-enable deterministic", () => {
    const baseline = [candidate("future", 0.8, {
      expectedAt: new Date("2099-01-01T00:00:00.000Z"),
      observedAt: null,
      systemFrom: null
    })];
    expect(memoryDecayFactor(baseline[0]!.metadata, {
      historical: false,
      now: NOW
    })).toEqual({ anchor: null, factor: 1 });
    const enabled = applyMemoryDecay(baseline, {
      enabled: true,
      mode: "TARGETED_CURRENT",
      now: NOW,
      policyVersion: MEMORY_DECAY_POLICY_VERSION
    });
    expect(applyMemoryDecay(enabled, {
      enabled: false,
      mode: "TARGETED_CURRENT",
      now: NOW,
      policyVersion: MEMORY_DECAY_POLICY_VERSION
    })).toBe(enabled);
    expect(applyMemoryDecay(baseline, {
      enabled: true,
      mode: "TARGETED_CURRENT",
      now: NOW,
      policyVersion: MEMORY_DECAY_POLICY_VERSION
    })).toEqual(enabled);
  });
});
