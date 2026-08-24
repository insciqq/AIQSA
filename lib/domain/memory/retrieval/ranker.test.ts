import { describe, expect, it } from "vitest";
import { planMemoryRetrieval } from "./planner";
import { fuseMemoryRetrievalCandidates } from "./ranker";
import type { MemoryCandidateMetadata, MemoryLaneCandidate } from "./contracts";
import type { MemoryRetrievalLane } from "./config";

const now = new Date("2026-08-13T10:00:00.000Z");
const plan = planMemoryRetrieval({ currentUserText: "какие ответы я преподчитаю", now });
const profilePlan = planMemoryRetrieval({
  currentUserText: "what do you know about me",
  filters: { sourceKinds: ["FACT", "EVENT"] },
  now,
  profileRequested: true
});

function metadata(id: string): MemoryCandidateMetadata {
  return {
    canonicalKey: null, category: "memory", confidence: 0, conflict: false,
    coreEligible: false, coreSalience: "NONE", current: true, dedupeKey: id,
    directness: "DIRECT", dimensionKey: null, entityIds: [], expectedAt: null,
    expiresAt: null, factId: id, historical: false, historySafetyClass: null,
    importance: 0, identityKind: "PROPOSITION", languageCode: "und",
    lastConfirmedAt: null, lastUsedAt: null,
    lifecycleState: "ACTIVE", matchedEntityRole: null, modality: "PREFERENCE",
    observedAt: null, occurredAt: null, occurredFrom: null,
    occurredTo: null, pinned: false, scopeAffinity: 0, scopeType: "GLOBAL_USER",
    predicateKey: null, relationDepth: 0, sensitivityClass: "NORMAL",
    sourceAssistantId: null, sourceChatId: null, sourceFolderId: null,
    sourceMode: "AUTOMATIC", sourceAuthority: "DIRECT_AUTOMATIC", subjectKey: null,
    synthesisDepth: 0, systemFrom: now,
    temperatureClass: null, temperatureScore: 0, validFrom: null, validTo: null
  };
}

function candidate(id: string, lane: MemoryRetrievalLane, rawScore: number): MemoryLaneCandidate {
  return {
    entryId: `entry-${id}`, hardFilterPassed: true, itemId: id,
    itemType: "FACT_VERSION", lane, metadata: metadata(id), rawScore
  };
}

describe("relative-rank Memory fusion", () => {
  it("uses only lane position and RRF, never raw score scale", () => {
    const first = fuseMemoryRetrievalCandidates(plan, [
      { lane: "FACT_FTS_SIMPLE", candidates: [candidate("a", "FACT_FTS_SIMPLE", 0.0001), candidate("b", "FACT_FTS_SIMPLE", 999)] },
      { lane: "FACT_VECTOR", candidates: [candidate("a", "FACT_VECTOR", -0.9), candidate("b", "FACT_VECTOR", 1)] }
    ], now);
    expect(first.map(({ itemId }) => itemId)).toEqual(["a", "b"]);
    expect(first[0]?.finalScore).toBe(first[0]?.rrfScore);
  });

  it("uses versioned lane weights and authority only as deterministic tie-breakers", () => {
    const weighted = fuseMemoryRetrievalCandidates(plan, [{
      lane: "FACT_ENTITY",
      candidates: [candidate("entity", "FACT_ENTITY", -1)]
    }, {
      lane: "FACT_VECTOR",
      candidates: [candidate("vector", "FACT_VECTOR", 1_000_000)]
    }], now);
    expect(weighted.map(({ itemId }) => itemId)).toEqual(["entity", "vector"]);
    expect(weighted[0]!.rrfScore).toBeCloseTo(1.2 / 61);
    expect(weighted[1]!.rrfScore).toBeCloseTo(1 / 61);

    const explicit = candidate("explicit", "FACT_FTS_SIMPLE", 0);
    const tied = fuseMemoryRetrievalCandidates(plan, [{
      lane: "FACT_FTS_SIMPLE",
      candidates: [{
        ...explicit,
        metadata: {
          ...explicit.metadata,
          sourceAuthority: "EXPLICIT",
          sourceMode: "EXPLICIT"
        }
      }]
    }, {
      lane: "FACT_VECTOR",
      candidates: [candidate("automatic", "FACT_VECTOR", 999)]
    }], now);
    expect(tied.map(({ itemId }) => itemId)).toEqual(["explicit", "automatic"]);
    expect(tied[0]!.rrfScore).toBe(tied[1]!.rrfScore);
  });

  it("demotes inferred synthesis below equally ranked direct facts", () => {
    const synthesized = candidate("pattern", "FACT_FTS_SIMPLE", 1);
    const ranked = fuseMemoryRetrievalCandidates(plan, [{
      lane: "FACT_FTS_SIMPLE",
      candidates: [{
        ...synthesized,
        metadata: {
          ...synthesized.metadata,
          directness: "INFERRED",
          modality: "PATTERN",
          sourceAuthority: "SYNTHESIS",
          synthesisDepth: 1
        }
      }, candidate("direct", "FACT_FTS_SIMPLE", 0.9)]
    }], now);

    expect(ranked.map(({ itemId }) => itemId)).toEqual(["direct", "pattern"]);
    expect(ranked[1]!.finalScore).toBeCloseTo(ranked[1]!.rrfScore * 0.5);
  });

  it("deduplicates a logical fact after fusion", () => {
    const duplicate = candidate("version-b", "FACT_VECTOR", 0.5);
    const ranked = fuseMemoryRetrievalCandidates(plan, [{
      lane: "FACT_VECTOR",
      candidates: [candidate("version-a", "FACT_VECTOR", 0.6), {
        ...duplicate,
        metadata: { ...duplicate.metadata, dedupeKey: "version-a" }
      }]
    }], now);
    expect(ranked).toHaveLength(1);
  });

  it("runs for every non-empty query and only skips the empty query", () => {
    expect(fuseMemoryRetrievalCandidates(plan, [{
      lane: "FACT_VECTOR", candidates: [candidate("vector", "FACT_VECTOR", 0.8)]
    }], now)).toHaveLength(1);
    const empty = planMemoryRetrieval({ currentUserText: " ", now });
    expect(fuseMemoryRetrievalCandidates(empty, [{
      lane: "FACT_VECTOR", candidates: [candidate("vector", "FACT_VECTOR", 0.8)]
    }], now)).toEqual([]);
  });

  it("isolates profile candidates from targeted semantic fusion", () => {
    const targeted = fuseMemoryRetrievalCandidates(plan, [{
      lane: "FACT_PROFILE",
      candidates: [candidate("profile-only", "FACT_PROFILE", 1)]
    }, {
      lane: "FACT_VECTOR",
      candidates: [candidate("targeted", "FACT_VECTOR", 0.8)]
    }], now);
    expect(targeted.map(({ itemId }) => itemId)).toEqual(["targeted"]);

    const profile = fuseMemoryRetrievalCandidates(profilePlan, [{
      lane: "FACT_PROFILE",
      candidates: Array.from({ length: 25 }, (_, index) =>
        candidate(`profile-${index}`, "FACT_PROFILE", 1 - index / 100))
    }, {
      lane: "FACT_VECTOR",
      candidates: [candidate("semantic-contamination", "FACT_VECTOR", 1)]
    }], now);
    expect(profile).toHaveLength(20);
    expect(profile.map(({ itemId }) => itemId)).toEqual(
      Array.from({ length: 20 }, (_, index) => `profile-${index}`)
    );
    expect(profile.every(({ itemType, selectionReason }) =>
      itemType === "FACT_VERSION" && selectionReason === "fact_profile"))
      .toBe(true);
  });

  it("rejects a recall chunk smuggled through the fact-only profile lane", () => {
    const disguised = {
      ...candidate("history", "FACT_PROFILE", 1),
      itemType: "RECALL_CHUNK" as const
    };
    expect(fuseMemoryRetrievalCandidates(profilePlan, [{
      candidates: [disguised],
      lane: "FACT_PROFILE"
    }], now)).toEqual([]);
  });
});
