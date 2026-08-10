import { describe, expect, it } from "vitest";
import {
  MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES,
  MEMORY_RETRIEVAL_RRF_K,
  type MemoryRetrievalLane
} from "./config";
import type {
  MemoryCandidateMetadata,
  MemoryLaneCandidate,
  MemoryLaneResult,
  MemoryRetrievalPlan
} from "./contracts";
import { planMemoryRetrieval } from "./planner";
import { fuseMemoryRetrievalCandidates } from "./ranker";

const now = new Date("2026-08-10T12:00:00.000Z");

function metadata(overrides: Partial<MemoryCandidateMetadata> = {}): MemoryCandidateMetadata {
  return {
    canonicalKey: "profile.preferred_editor",
    category: "preference",
    confidence: 1,
    conflict: false,
    current: true,
    dedupeKey: "fact:editor",
    directness: "DIRECT",
    factId: "fact-1",
    historical: false,
    historySafetyClass: null,
    importance: 0.8,
    languageCode: "en",
    modality: "PREFERENCE",
    occurredFrom: null,
    occurredTo: null,
    pinned: false,
    scopeAffinity: 1,
    scopeType: "GLOBAL_USER",
    sensitivityClass: "NORMAL",
    sourceAssistantId: null,
    sourceChatId: null,
    sourceFolderId: null,
    sourceMode: "EXPLICIT",
    systemFrom: new Date("2026-01-01T00:00:00.000Z"),
    temperatureClass: "WARM",
    validFrom: null,
    validTo: null,
    ...overrides
  };
}

function candidate(
  lane: MemoryRetrievalLane,
  id: string,
  overrides: Partial<MemoryLaneCandidate> = {}
): MemoryLaneCandidate {
  return {
    entryId: `entry-${id}`,
    hardFilterPassed: true,
    itemId: id,
    itemType: "FACT_VERSION",
    lane,
    metadata: metadata({ dedupeKey: `fact:${id}`, factId: `fact-${id}` }),
    rawScore: 1,
    ...overrides
  };
}

function plan(text = "What is my preferred editor?"): MemoryRetrievalPlan {
  return planMemoryRetrieval({ currentUserText: text, now });
}

describe("Memory retrieval fusion", () => {
  it("never restores a candidate rejected by a hard filter", () => {
    const ranked = fuseMemoryRetrievalCandidates(plan(), [{
      candidates: [
        candidate("FACT_EXACT", "foreign", { hardFilterPassed: false, rawScore: 100 }),
        candidate("FACT_FTS_ENGLISH", "eligible")
      ],
      lane: "FACT_FTS_ENGLISH"
    }], now);
    expect(ranked.map((item) => item.itemId)).toEqual(["eligible"]);
  });

  it("uses one-based reciprocal ranks with k=60 and combines independent lanes", () => {
    const ranked = fuseMemoryRetrievalCandidates(plan(), [
      { candidates: [candidate("FACT_FTS_ENGLISH", "editor")], lane: "FACT_FTS_ENGLISH" },
      { candidates: [candidate("FACT_EXACT", "editor")], lane: "FACT_EXACT" }
    ], now);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.rrfScore).toBeCloseTo(2 / (MEMORY_RETRIEVAL_RRF_K + 1), 12);
    expect(ranked[0]?.laneRanks).toEqual({ FACT_EXACT: 1, FACT_FTS_ENGLISH: 1 });
  });

  it("fails closed when lanes disagree about the same authoritative identity", () => {
    const ranked = fuseMemoryRetrievalCandidates(plan(), [
      { candidates: [candidate("FACT_EXACT", "same")], lane: "FACT_EXACT" },
      {
        candidates: [candidate("FACT_FTS_ENGLISH", "same", {
          metadata: metadata({
            dedupeKey: "fact:same",
            factId: "fact-same",
            validFrom: new Date("2025-01-01T00:00:00.000Z")
          })
        })],
        lane: "FACT_FTS_ENGLISH"
      }
    ], now);
    expect(ranked).toEqual([]);
  });

  it("bounds pre-fusion work and produces no injection for a NONE plan", () => {
    const lanes: MemoryLaneResult[] = [
      "FACT_EXACT",
      "FACT_CANONICAL",
      "FACT_FTS_ENGLISH",
      "FACT_FTS_SIMPLE",
      "FACT_VECTOR",
      "HISTORY_RECALL_FTS_ENGLISH",
      "HISTORY_RECALL_FTS_SIMPLE"
    ].map((lane, laneIndex) => ({
      candidates: Array.from({ length: 60 }, (_, index) =>
        candidate(lane as MemoryRetrievalLane, `${laneIndex}-${index}`)),
      lane: lane as MemoryRetrievalLane
    }));
    const ranked = fuseMemoryRetrievalCandidates(plan(), lanes, now);
    expect(ranked.length).toBeLessThanOrEqual(25);
    expect(MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES).toBe(150);

    const none = planMemoryRetrieval({ currentUserText: "What is PostgreSQL?", now });
    expect(fuseMemoryRetrievalCandidates(none, lanes, now)).toEqual([]);
  });

  it.each([
    ["Какой мой предпочтительный редактор?", "FACT_FTS_RUSSIAN"],
    ["What is my preferred editor?", "FACT_FTS_ENGLISH"]
  ] as const)("keeps a relevant RU/EN result inside Recall@5 (%s)", (query, lane) => {
    const distractors = Array.from({ length: 8 }, (_, index) =>
      candidate(lane, `noise-${index}`, {
        metadata: metadata({
          canonicalKey: null,
          dedupeKey: `noise:${index}`,
          factId: `noise-fact-${index}`,
          importance: 0.1,
          languageCode: lane.endsWith("RUSSIAN") ? "ru" : "en",
          scopeAffinity: 0.2,
          sourceMode: "AUTOMATIC"
        })
      }));
    const relevant = candidate("FACT_CANONICAL", "relevant", {
      metadata: metadata({
        dedupeKey: "relevant",
        factId: "relevant-fact",
        languageCode: lane.endsWith("RUSSIAN") ? "ru" : "en"
      })
    });
    const ranked = fuseMemoryRetrievalCandidates(plan(query), [
      { candidates: distractors, lane },
      { candidates: [relevant], lane: "FACT_CANONICAL" }
    ], now);
    expect(ranked.slice(0, 5).map((item) => item.itemId)).toContain("relevant");
  });
});
