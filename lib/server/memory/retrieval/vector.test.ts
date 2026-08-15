import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_EXACT_VECTOR_MAX_ELIGIBLE_ROWS,
  MEMORY_HNSW_MAX_CANDIDATES_PER_LANE,
  MEMORY_HNSW_OVERFETCH_MULTIPLIER,
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  searchMemoryVectorLanes,
  type MemoryVectorHit,
  type MemoryVectorLaneExecutor,
  type MemoryVectorProfile,
  type MemoryVectorSearchInput
} from "./vector";

const profile: MemoryVectorProfile = Object.freeze({
  configurationFingerprint: "c".repeat(64),
  connectionId: "connection-1",
  dimension: 1_024,
  generationId: "generation-1",
  providerModelId: "model-1",
  retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  vectorSpaceFingerprint: "d".repeat(64)
});

function input(overrides: Partial<MemoryVectorSearchInput> = {}): MemoryVectorSearchInput {
  return {
    eligibility: {
      allowedFactSensitivity: ["NORMAL", "SENSITIVE"],
      allowedHistorySafety: ["NORMAL", "SENSITIVE"],
      assistantId: null,
      chatId: "chat-1",
      folderId: "folder-1",
      occurredFrom: null,
      occurredTo: null,
      sourceAssistantId: null,
      sourceChatIds: null,
      sourceFolderId: null
    },
    itemTypes: ["RECALL_CHUNK"],
    limit: 2,
    minimumScore: 0.4,
    profile,
    userId: "user-1",
    vector: Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0),
    ...overrides
  };
}

function hit(entryId: string): MemoryVectorHit {
  return {
    distance: entryId.endsWith("1") ? 0.1 : 0.2,
    entryId,
    itemId: `item-${entryId}`,
    itemType: "RECALL_CHUNK",
    score: entryId.endsWith("1") ? 0.9 : 0.8
  };
}

describe("Memory vector lane orchestration", () => {
  it("uses bounded HNSW overfetch and exact fallback after authoritative underfill", async () => {
    const scans: Array<readonly [string, string, number]> = [];
    const executor: MemoryVectorLaneExecutor = {
      async candidateScan(_input, itemType, strategy, limit) {
        scans.push([itemType, strategy, limit]);
        return strategy === "HNSW"
          ? [{ entryId: "chunk-filtered-1" }]
          : [{ entryId: "chunk-1" }, { entryId: "chunk-2" }];
      },
      async eligibleCount() {
        return MEMORY_EXACT_VECTOR_MAX_ELIGIBLE_ROWS + 1;
      },
      async rejoin(_input, _itemType, candidateIds) {
        return candidateIds
          .filter((id) => !id.includes("filtered"))
          .map((id) => hit(id));
      },
      async resolveActiveProfile() {
        return { profile, status: "READY" };
      }
    };

    const result = await searchMemoryVectorLanes(executor, input());

    expect(result).toMatchObject({
      lanes: [{ exactFallbackUsed: true, strategy: "HNSW" }],
      status: "READY"
    });
    expect(scans).toEqual([
      [
        "RECALL_CHUNK",
        "HNSW",
        Math.min(
          2 * MEMORY_HNSW_OVERFETCH_MULTIPLIER,
          MEMORY_HNSW_MAX_CANDIDATES_PER_LANE
        )
      ],
      ["RECALL_CHUNK", "EXACT", 2]
    ]);
    expect(result.hits.map((value) => value.entryId)).toEqual([
      "chunk-1",
      "chunk-2"
    ]);
  });

  it("degrades before scanning when the active generation no longer matches", async () => {
    const eligibleCount = vi.fn(async () => 1);
    const executor: MemoryVectorLaneExecutor = {
      candidateScan: vi.fn(async () => []),
      eligibleCount,
      rejoin: vi.fn(async () => []),
      resolveActiveProfile: vi.fn(async () => ({
        profile: { ...profile, generationId: "generation-2" },
        status: "READY" as const
      }))
    };
    await expect(searchMemoryVectorLanes(executor, input())).resolves.toEqual({
      hits: [],
      lanes: [],
      reason: "memory_vector_generation_stale",
      status: "DEGRADED"
    });
    expect(eligibleCount).not.toHaveBeenCalled();
  });

  it("rejects malformed dimensions, caller-expanded scope lists, and thresholds", async () => {
    const executor = {} as MemoryVectorLaneExecutor;
    const invalid = [
      input({ vector: [1] }),
      input({ minimumScore: -1.1 }),
      input({
        eligibility: {
          ...input().eligibility,
          sourceChatIds: Array.from({ length: 51 }, (_, index) => `chat-${index}`)
        }
      })
    ];
    for (const value of invalid) {
      await expect(searchMemoryVectorLanes(executor, value))
        .rejects.toThrow("memory_vector_query_invalid");
    }
  });
});
