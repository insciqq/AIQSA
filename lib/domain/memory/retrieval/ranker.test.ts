import { describe, expect, it } from "vitest";
import { planMemoryRetrieval } from "./planner";
import { fuseMemoryRetrievalCandidates } from "./ranker";
import {
  orderMemoryCandidatesWithLinkedEvidenceCoverage,
  orderMemoryCandidatesWithSoftSourceDiversity
} from "./sourceDiversity";
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
const pastChatPlan = planMemoryRetrieval({
  currentUserText: "deployment rehearsals before launch day",
  filters: { sourceKinds: ["HISTORY"] },
  mode: "PAST_CHAT_SEARCH",
  now,
  temporalIntent: "ANY"
});
const aggregationPlan = planMemoryRetrieval({
  aggregationRequested: true,
  currentUserText: "all deployment rehearsals completed before launch day",
  filters: { sourceKinds: ["HISTORY"] },
  mode: "PAST_CHAT_SEARCH",
  now,
  temporalIntent: "ANY"
});

describe("soft source diversity", () => {
  it("keeps relevance-ranked repeats reachable at the 25 percent prefix boundary", () => {
    const ranked = [
      "a-1", "a-2", "a-3", "b-1", "c-1", "d-1",
      "e-1", "f-1", "g-1", "h-1", "i-1", "j-1"
    ];

    const ordered = orderMemoryCandidatesWithSoftSourceDiversity(
      ranked,
      (candidate) => candidate.slice(0, 1)
    );

    expect(ordered).toEqual([
      "a-1", "b-1", "c-1", "d-1", "e-1", "f-1",
      "g-1", "a-2", "h-1", "i-1", "j-1", "a-3"
    ]);
    for (const prefixLength of [4, 8, 12]) {
      const prefix = ordered.slice(0, prefixLength);
      expect(prefix.filter((candidate) => candidate.startsWith("a-"))).toHaveLength(
        prefixLength / 4
      );
    }
  });

  it("relaxes the share when fewer than four distinct sources exist", () => {
    expect(orderMemoryCandidatesWithSoftSourceDiversity(
      ["a-1", "a-2", "b-1"],
      (candidate) => candidate.slice(0, 1)
    )).toEqual(["a-1", "b-1", "a-2"]);
  });
});

describe("linked source evidence coverage", () => {
  it("pairs one linked child with each source anchor before the global tail", () => {
    const candidates = [
      { id: "a-anchor", linked: false, source: "a" },
      { id: "fact", linked: false, source: null },
      { id: "a-tail", linked: false, source: "a" },
      { id: "b-anchor", linked: false, source: "b" },
      { id: "c-anchor", linked: false, source: "c" },
      { id: "a-user", linked: true, source: "a" },
      { id: "b-user", linked: true, source: "b" },
      { id: "c-user", linked: true, source: "c" }
    ];

    const ordered = orderMemoryCandidatesWithLinkedEvidenceCoverage(
      candidates,
      ({ source }) => source,
      ({ linked }) => linked
    );

    expect(ordered.map(({ id }) => id)).toEqual([
      "a-anchor",
      "fact",
      "a-user",
      "b-anchor",
      "b-user",
      "c-anchor",
      "c-user",
      "a-tail"
    ]);
    expect(new Set(ordered)).toEqual(new Set(candidates));
  });

  it("keeps the original order when no linked evidence exists", () => {
    const candidates = ["a-1", "b-1", "a-2"];
    expect(orderMemoryCandidatesWithLinkedEvidenceCoverage(
      candidates,
      (candidate) => candidate.slice(0, 1),
      () => false
    )).toBe(candidates);
  });

  it("uses a provenance-novel linked child for the coverage slot", () => {
    const candidates = [
      { id: "anchor", linked: false, messages: ["message-shared"], source: "a" },
      {
        id: "same-episode-user-view",
        linked: true,
        messages: ["message-user", "message-shared"],
        source: "a"
      },
      {
        id: "novel-user-episode",
        linked: true,
        messages: ["message-novel"],
        source: "a"
      },
      { id: "tail", linked: false, messages: ["message-tail"], source: "a" }
    ];

    const ordered = orderMemoryCandidatesWithLinkedEvidenceCoverage(
      candidates,
      ({ source }) => source,
      ({ linked }) => linked,
      (anchor, linked) => {
        const anchorMessages = new Set(anchor.messages);
        return !linked.messages.some((messageId) => anchorMessages.has(messageId));
      }
    );

    expect(ordered.map(({ id }) => id)).toEqual([
      "anchor",
      "novel-user-episode",
      "same-episode-user-view",
      "tail"
    ]);
  });

  it("traverses a bounded multi-child neighborhood best-first", () => {
    const candidates = [
      { id: "a-anchor", linked: false, source: "a" },
      { id: "b-anchor", linked: false, source: "b" },
      { id: "c-anchor", linked: false, source: "c" },
      { id: "a-user-1", linked: true, source: "a" },
      { id: "b-user-1", linked: true, source: "b" },
      { id: "a-user-2", linked: true, source: "a" },
      { id: "c-user-1", linked: true, source: "c" }
    ];

    const ordered = orderMemoryCandidatesWithLinkedEvidenceCoverage(
      candidates,
      ({ source }) => source,
      ({ linked }) => linked,
      undefined,
      2
    );

    expect(ordered.map(({ id }) => id)).toEqual([
      "a-anchor",
      "b-anchor",
      "a-user-1",
      "c-anchor",
      "a-user-2",
      "b-user-1",
      "c-user-1"
    ]);
  });
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

function historyCandidate(id: string, rawScore: number): MemoryLaneCandidate {
  const base = candidate(id, "HISTORY_RECALL_VECTOR", rawScore);
  return {
    ...base,
    itemType: "RECALL_CHUNK",
    metadata: {
      ...base.metadata,
      category: null,
      coreSalience: "NONE",
      directness: null,
      factId: null,
      historySafetyClass: "NORMAL",
      identityKind: null,
      lifecycleState: null,
      modality: null,
      scopeType: null,
      sensitivityClass: null,
      sourceAuthority: "PAST_CHAT",
      sourceChatId: `chat-${id}`,
      sourceMode: null
    }
  };
}

function toolEventCandidate(id: string, rawScore: number): MemoryLaneCandidate {
  const base = historyCandidate(id, rawScore);
  return {
    ...base,
    itemType: "TOOL_EVENT",
    metadata: {
      ...base.metadata,
      confidence: 1,
      modality: "EVENT",
      observedAt: now,
      occurredAt: now,
      occurredFrom: now,
      occurredTo: now,
      sourceAuthority: "TOOL_OBSERVATION"
    }
  };
}

describe("relative-rank Memory fusion", () => {
  it("uses only lane position and RRF, never raw score scale", () => {
    const first = fuseMemoryRetrievalCandidates(plan, [
      { lane: "FACT_LEXICAL_UNICODE", candidates: [candidate("a", "FACT_LEXICAL_UNICODE", 0.0001), candidate("b", "FACT_LEXICAL_UNICODE", 999)] },
      { lane: "FACT_VECTOR", candidates: [candidate("a", "FACT_VECTOR", -0.9), candidate("b", "FACT_VECTOR", 1)] }
    ], now);
    expect(first.map(({ itemId }) => itemId)).toEqual(["a", "b"]);
    expect(first[0]?.finalScore).toBe(first[0]?.rrfScore);
  });

  it("fuses generic Unicode, n-gram, and dense ranks as independent signals", () => {
    const multilingual = candidate("multilingual", "FACT_LEXICAL_UNICODE", 0.000001);
    const ranked = fuseMemoryRetrievalCandidates(plan, [{
      candidates: [multilingual],
      lane: "FACT_LEXICAL_UNICODE"
    }, {
      candidates: [{ ...multilingual, lane: "FACT_VECTOR", rawScore: 1_000_000 }],
      lane: "FACT_VECTOR"
    }, {
      candidates: [{ ...multilingual, lane: "FACT_LEXICAL_NGRAM", rawScore: -1_000_000 }],
      lane: "FACT_LEXICAL_NGRAM"
    }, {
      candidates: [candidate("raw-scale-decoy", "FACT_ENTITY", Number.MAX_VALUE)],
      lane: "FACT_ENTITY"
    }], now);

    expect(ranked.map(({ itemId }) => itemId)).toEqual([
      "multilingual", "raw-scale-decoy"
    ]);
    expect(ranked[0]?.rrfScore).toBeCloseTo((1 + 1 + 0.85) / 61);
    expect(ranked[0]?.laneRanks).toEqual({
      FACT_LEXICAL_NGRAM: 1,
      FACT_LEXICAL_UNICODE: 1,
      FACT_VECTOR: 1
    });
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

    const explicit = candidate("explicit", "FACT_LEXICAL_UNICODE", 0);
    const tied = fuseMemoryRetrievalCandidates(plan, [{
      lane: "FACT_LEXICAL_UNICODE",
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

  it("uses deterministic temporal overlap only as a confidence-aware tie-break", () => {
    const temporalPlan = planMemoryRetrieval({
      currentUserText: "2026-08-12",
      now,
      temporalIntent: "ANY",
      timeZone: "UTC"
    });
    const inside = {
      ...historyCandidate("inside", 0),
      lane: "HISTORY_RECALL_LEXICAL_UNICODE" as const
    };
    const outside = {
      ...historyCandidate("outside", 999),
      lane: "HISTORY_RECALL_VECTOR" as const
    };
    const endedAtStart = {
      ...historyCandidate("ended-at-start", 10),
      lane: "HISTORY_DIGEST_FTS_SIMPLE" as const
    };
    const ranked = fuseMemoryRetrievalCandidates(temporalPlan, [{
      candidates: [{
        ...outside,
        metadata: {
          ...outside.metadata,
          occurredFrom: new Date("2026-07-01T00:00:00.000Z"),
          occurredTo: new Date("2026-07-01T01:00:00.000Z")
        }
      }],
      lane: "HISTORY_RECALL_VECTOR"
    }, {
      candidates: [{
        ...inside,
        metadata: {
          ...inside.metadata,
          occurredFrom: new Date("2026-08-12T12:00:00.000Z"),
          occurredTo: new Date("2026-08-12T13:00:00.000Z")
        }
      }],
      lane: "HISTORY_RECALL_LEXICAL_UNICODE"
    }, {
      candidates: [{
        ...endedAtStart,
        metadata: {
          ...endedAtStart.metadata,
          occurredFrom: new Date("2026-08-01T00:00:00.000Z"),
          occurredTo: new Date("2026-08-12T00:00:00.000Z")
        }
      }],
      lane: "HISTORY_DIGEST_FTS_SIMPLE"
    }], now);

    expect(ranked.map(({ itemId }) => itemId)).toEqual([
      "inside", "ended-at-start", "outside"
    ]);
    expect(ranked[0]?.rrfScore).toBe(ranked[2]?.rrfScore);
    expect(ranked.map(({ featureSnapshot }) => featureSnapshot.temporalFit))
      .toEqual([1, 0.5, 0.5]);
  });

  it("demotes inferred synthesis below equally ranked direct facts", () => {
    const synthesized = candidate("pattern", "FACT_LEXICAL_UNICODE", 1);
    const ranked = fuseMemoryRetrievalCandidates(plan, [{
      lane: "FACT_LEXICAL_UNICODE",
      candidates: [{
        ...synthesized,
        metadata: {
          ...synthesized.metadata,
          directness: "INFERRED",
          modality: "PATTERN",
          sourceAuthority: "SYNTHESIS",
          synthesisDepth: 1
        }
      }, candidate("direct", "FACT_LEXICAL_UNICODE", 0.9)]
    }], now);

    expect(ranked.map(({ itemId }) => itemId)).toEqual(["direct", "pattern"]);
    expect(ranked[1]!.finalScore).toBeCloseTo(ranked[1]!.rrfScore * 0.5);
  });

  it("keeps supporting observations retrievable below equal HIGH authority", () => {
    const high = candidate("high", "FACT_LEXICAL_UNICODE", 0.1);
    const supporting = candidate("supporting", "FACT_VECTOR", 0.9);
    const ranked = fuseMemoryRetrievalCandidates(plan, [{
      lane: "FACT_LEXICAL_UNICODE",
      candidates: [{
        ...high,
        metadata: { ...high.metadata, confidence: 1 }
      }]
    }, {
      lane: "FACT_VECTOR",
      candidates: [{
        ...supporting,
        metadata: { ...supporting.metadata, confidence: 0.6 }
      }]
    }], now);

    expect(ranked.map(({ itemId }) => itemId)).toEqual(["high", "supporting"]);
    expect(ranked[1]!.finalScore).toBeCloseTo(ranked[1]!.rrfScore * 0.65);
    expect(ranked[1]!.featureSnapshot.authorityRank).toBe(1);
  });

  it("keeps typed tool observations retrievable at supporting authority", () => {
    const ranked = fuseMemoryRetrievalCandidates(plan, [{
      lane: "HISTORY_RECALL_VECTOR",
      candidates: [toolEventCandidate("tool-event", 0.9)]
    }], now);

    expect(ranked.map(({ itemId, itemType }) => ({ itemId, itemType }))).toEqual([{
      itemId: "tool-event",
      itemType: "TOOL_EVENT"
    }]);
    expect(ranked[0]!.finalScore).toBeCloseTo(ranked[0]!.rrfScore * 0.65);
    expect(ranked[0]!.featureSnapshot.authorityRank).toBe(1);
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

  it("groups an exact message-set root and prefers the raw round representation", () => {
    const evidenceRootHash = "a".repeat(64);
    const chunk = {
      ...historyCandidate("chunk-1", 0.8),
      lane: "HISTORY_RECALL_LEXICAL_UNICODE" as const
    };
    const roundBase = historyCandidate("round-1", 0.9);
    const round = {
      ...roundBase,
      itemType: "RECALL_ROUND" as const,
      metadata: {
        ...roundBase.metadata,
        evidenceRootHash,
        parentChunkId: "chunk-1",
        sourceChatId: "chat-shared-root"
      }
    };
    const ranked = fuseMemoryRetrievalCandidates(pastChatPlan, [{
      candidates: [{
        ...chunk,
        metadata: {
          ...chunk.metadata,
          evidenceRootHash,
          sourceChatId: "chat-shared-root"
        }
      }],
      lane: "HISTORY_RECALL_LEXICAL_UNICODE"
    }, {
      candidates: [round],
      lane: "HISTORY_RECALL_VECTOR"
    }], now);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({
      featureSnapshot: { laneCount: 2 },
      itemId: "round-1",
      itemType: "RECALL_ROUND",
      laneRanks: {
        HISTORY_RECALL_LEXICAL_UNICODE: 1,
        HISTORY_RECALL_VECTOR: 1
      }
    });
  });

  it("does not spend one lane's bounded slots twice on an equivalent history root", () => {
    const evidenceRootHash = "b".repeat(64);
    const chunk = historyCandidate("chunk-same-lane", 0.9);
    const roundBase = historyCandidate("round-same-lane", 0.8);
    const other = historyCandidate("other-root", 0.7);
    const sourceChatId = "chat-same-lane";
    const ranked = fuseMemoryRetrievalCandidates(pastChatPlan, [{
      candidates: [{
        ...chunk,
        metadata: { ...chunk.metadata, evidenceRootHash, sourceChatId }
      }, {
        ...roundBase,
        itemType: "RECALL_ROUND" as const,
        metadata: {
          ...roundBase.metadata,
          evidenceRootHash,
          parentChunkId: chunk.itemId,
          sourceChatId
        }
      }, other],
      lane: "HISTORY_RECALL_VECTOR"
    }], now);

    expect(ranked.map(({ itemId }) => itemId)).toEqual([
      "round-same-lane",
      "other-root"
    ]);
    expect(ranked[0]?.laneRanks).toEqual({ HISTORY_RECALL_VECTOR: 1 });
  });

  it("prefers an exact round segment over legacy round and chunk representations", () => {
    const evidenceRootHash = "c".repeat(64);
    const sourceChatId = "chat-segment-root";
    const chunk = historyCandidate("segment-parent-chunk", 1);
    const legacy = historyCandidate("segment-parent-round", 0.9);
    const segment = historyCandidate("segment-parent-round", 0.8);
    const ranked = fuseMemoryRetrievalCandidates(pastChatPlan, [{
      candidates: [{
        ...chunk,
        metadata: { ...chunk.metadata, evidenceRootHash, sourceChatId }
      }, {
        ...legacy,
        itemType: "RECALL_ROUND" as const,
        metadata: {
          ...legacy.metadata,
          evidenceRootHash,
          parentChunkId: chunk.itemId,
          sourceChatId
        }
      }, {
        ...segment,
        itemType: "RECALL_ROUND" as const,
        matchedSegmentId: "segment-middle",
        matchedSegmentPosition: "MIDDLE" as const,
        metadata: {
          ...segment.metadata,
          evidenceRootHash,
          parentChunkId: chunk.itemId,
          sourceChatId
        }
      }],
      lane: "HISTORY_RECALL_VECTOR"
    }], now);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({
      itemId: "segment-parent-round",
      itemType: "RECALL_ROUND",
      matchedSegmentId: "segment-middle",
      matchedSegmentPosition: "MIDDLE"
    });
  });

  it("collapses overlapping segment hits by parent evidence root before packing", () => {
    const evidenceRootHash = "d".repeat(64);
    const sourceChatId = "chat-overlapping-segments";
    const base = historyCandidate("overlap-round", 1);
    const segment = (id: string, lane: MemoryRetrievalLane): MemoryLaneCandidate => ({
      ...base,
      itemType: "RECALL_ROUND",
      lane,
      matchedSegmentId: id,
      matchedSegmentPosition: "MIDDLE",
      metadata: {
        ...base.metadata,
        evidenceRootHash,
        parentChunkId: "overlap-parent-chunk",
        sourceChatId
      }
    });
    const ranked = fuseMemoryRetrievalCandidates(pastChatPlan, [{
      candidates: [segment("overlap-segment-a", "HISTORY_RECALL_LEXICAL_UNICODE")],
      lane: "HISTORY_RECALL_LEXICAL_UNICODE"
    }, {
      candidates: [segment("overlap-segment-b", "HISTORY_RECALL_VECTOR")],
      lane: "HISTORY_RECALL_VECTOR"
    }], now);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.matchedSegmentId).toMatch(/^overlap-segment-[ab]$/u);
    expect(ranked[0]?.laneRanks).toEqual({
      HISTORY_RECALL_LEXICAL_UNICODE: 1,
      HISTORY_RECALL_VECTOR: 1
    });
    expect(ranked[0]?.featureSnapshot.laneCount).toBe(2);
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

  it("uses the widened targeted lane and the larger aggregation lane", () => {
    const candidates = Array.from({ length: 61 }, (_, index) =>
      historyCandidate(`history-${index}`, 1 - index / 100));
    const results = [{ candidates, lane: "HISTORY_RECALL_VECTOR" as const }];

    expect(fuseMemoryRetrievalCandidates(pastChatPlan, results, now)).toHaveLength(60);
    expect(fuseMemoryRetrievalCandidates(aggregationPlan, results, now)).toHaveLength(61);
  });

  it("lets aggregation coverage candidates from a second history lane reach fusion", () => {
    const ftsCandidates = Array.from({ length: 30 }, (_, index) => {
      const value = historyCandidate(`fts-${index}`, 1 - index / 100);
      return { ...value, lane: "HISTORY_RECALL_LEXICAL_UNICODE" as const };
    });
    const vectorCandidates = Array.from({ length: 30 }, (_, index) => {
      const value = historyCandidate(`vector-${index}`, 1 - index / 100);
      return { ...value, lane: "HISTORY_RECALL_VECTOR" as const };
    });
    const ranked = fuseMemoryRetrievalCandidates(aggregationPlan, [{
      candidates: ftsCandidates,
      lane: "HISTORY_RECALL_LEXICAL_UNICODE"
    }, {
      candidates: vectorCandidates,
      lane: "HISTORY_RECALL_VECTOR"
    }], now);

    expect(ranked).toHaveLength(60);
    expect(ranked.filter(({ itemId }) => itemId.startsWith("fts-"))).toHaveLength(30);
    expect(ranked.filter(({ itemId }) => itemId.startsWith("vector-"))).toHaveLength(30);
  });

  it("preserves identical aggregation evidence from independent source chats", () => {
    const first = historyCandidate("first", 0.9);
    const second = historyCandidate("second", 0.8);
    const sharedDedupe = "same-safe-projection";
    const ranked = fuseMemoryRetrievalCandidates(aggregationPlan, [{
      candidates: [{
        ...first,
        metadata: { ...first.metadata, dedupeKey: sharedDedupe, sourceChatId: "chat-a" }
      }, {
        ...second,
        metadata: { ...second.metadata, dedupeKey: sharedDedupe, sourceChatId: "chat-b" }
      }],
      lane: "HISTORY_RECALL_VECTOR"
    }], now);

    expect(ranked.map(({ itemId }) => itemId)).toEqual(["first", "second"]);
    expect(fuseMemoryRetrievalCandidates(pastChatPlan, [{
      candidates: [{
        ...first,
        metadata: { ...first.metadata, dedupeKey: sharedDedupe, sourceChatId: "chat-a" }
      }, {
        ...second,
        metadata: { ...second.metadata, dedupeKey: sharedDedupe, sourceChatId: "chat-b" }
      }],
      lane: "HISTORY_RECALL_VECTOR"
    }], now)).toHaveLength(2);
    expect(fuseMemoryRetrievalCandidates(pastChatPlan, [{
      candidates: [{
        ...first,
        metadata: { ...first.metadata, dedupeKey: sharedDedupe, sourceChatId: "chat-a" }
      }, {
        ...second,
        metadata: { ...second.metadata, dedupeKey: sharedDedupe, sourceChatId: "chat-a" }
      }],
      lane: "HISTORY_RECALL_VECTOR"
    }], now)).toHaveLength(1);
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
