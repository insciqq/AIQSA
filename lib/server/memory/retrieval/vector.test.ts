import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_EXACT_VECTOR_MAX_ELIGIBLE_ROWS,
  MEMORY_HNSW_MAX_CANDIDATES_PER_LANE,
  MEMORY_HNSW_OVERFETCH_MULTIPLIER,
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  memoryVectorCandidateSql,
  memoryVectorEligibleCountSql,
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
  minimumSimilarity: 0.55,
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
      factMode: "CURRENT",
      factTemporalAsOf: null,
      folderId: "folder-1",
      includePatterns: false,
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
  it("fences project history and same-conversation negative feedback in vector SQL", () => {
    const chunkSql = memoryVectorCandidateSql({
      input: input(),
      itemType: "RECALL_CHUNK",
      limit: 2
    }).strings.join("?");
    const factSql = memoryVectorCandidateSql({
      input: { ...input(), itemTypes: ["FACT_VERSION"] },
      itemType: "FACT_VERSION",
      limit: 2
    }).strings.join("?");

    expect(chunkSql).toContain('source_chat."projectId" IS NULL');
    expect(chunkSql).toContain('chunk."chunkingVersion" =');
    expect(chunkSql).toContain('chunk."sourceProjectionVersion" =');
    expect(chunkSql).toContain(
      '"ChatMemoryCheckpointMessage" AS authority_checkpoint_message'
    );
    expect(chunkSql).not.toContain(
      'checkpoint."sourceRevision" = chunk."sourceRevisionAtCreation"'
    );
    expect(chunkSql).not.toContain(
      'source_chat."memoryBranchGeneration" = chunk."branchGeneration"'
    );
    expect(chunkSql).toContain('negative_feedback."recallChunkId" = chunk."id"');
    expect(chunkSql).toContain('negative_run."chatId" =');
    expect(factSql).toContain('negative_feedback."memoryFactVersionId" = version."id"');
    expect(factSql).not.toContain('version."sensitivityClass" <> \'SENSITIVE\'');
    expect(factSql).toContain('evidence_chat."projectId" IS NULL');
    expect(factSql).toContain('evidence_chat."permanentDeletionAt" IS NULL');
    expect(factSql).toContain('current_chat."projectId" IS NULL');
    expect(factSql).toContain('current_chat."permanentDeletionAt" IS NULL');
    expect(factSql).toContain('current_chat."memoryMode" IN');
    expect(factSql).toContain("'EXCLUDED'::\"MemoryChatMode\"");
    expect(factSql).toContain('feedback_retraction."retractsFeedbackId" = negative_feedback."id"');
    expect(factSql).toContain('scope."scopeType" = \'GLOBAL_USER\'');
    expect(factSql).toContain('scope."targetIdSnapshot" IS NULL');
    expect(factSql).toContain('scope."targetDisplaySnapshot" IS NULL');
    expect(factSql).not.toMatch(/scope\."scopeType" = '(?:FOLDER|ASSISTANT|CHAT)'/u);
  });

  it("bounds the conservative strategy corpus without duplicating authority scans", () => {
    const count = memoryVectorEligibleCountSql({
      input: input(),
      itemType: "RECALL_CHUNK"
    });
    const sql = count.strings.join("?");

    expect(sql).toContain("AS bounded_eligible");
    expect(count.values).toContain(MEMORY_EXACT_VECTOR_MAX_ELIGIBLE_ROWS + 1);
    expect(sql).toContain('entry."indexGenerationId" =');
    expect(sql).toContain('entry."embeddingDimension" =');
    expect(sql).not.toContain("authority_source_map");
    expect(sql).not.toContain("MemoryFactVersion");
    expect(sql).not.toContain("MemoryRecallChunk");
  });

  it("allows bounded wide exploration without a hard per-chat chunk quota", async () => {
    const wide = input({ limit: 120 });
    const sql = memoryVectorCandidateSql({
      input: wide,
      itemType: "RECALL_CHUNK",
      limit: 120
    });
    expect(sql.strings.join("?")).not.toContain('PARTITION BY chunk."chatId"');
    expect(sql.values).toContain(120);

    const executor: MemoryVectorLaneExecutor = {
      candidateScan: vi.fn(async () => []),
      eligibleCount: vi.fn(async () => 0),
      rejoin: vi.fn(async () => []),
      resolveActiveProfile: vi.fn(async () => ({ profile, status: "READY" as const }))
    };
    await expect(searchMemoryVectorLanes(executor, wide)).resolves.toMatchObject({
      hits: [],
      status: "READY"
    });
    await expect(searchMemoryVectorLanes(executor, input({ limit: 121 })))
      .rejects.toThrow("memory_vector_query_invalid");
  });

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

  it("returns bounded nearest eligible candidates across the full cosine range", async () => {
    const candidateScan = vi.fn(async () => [{ entryId: "fact-low-similarity" }]);
    const rejoin = vi.fn(async (search: MemoryVectorSearchInput) => search.minimumScore <= 0.2
      ? [{
          distance: 0.8,
          entryId: "fact-low-similarity",
          itemId: "fact-saved-name",
          itemType: "FACT_VERSION" as const,
          score: 0.2
        }]
      : []);
    const executor: MemoryVectorLaneExecutor = {
      candidateScan,
      eligibleCount: vi.fn(async () => 1),
      rejoin,
      resolveActiveProfile: vi.fn(async () => ({ profile, status: "READY" as const }))
    };

    const result = await searchMemoryVectorLanes(executor, input({
      itemTypes: ["FACT_VERSION"],
      minimumScore: -1
    }));

    expect(candidateScan).toHaveBeenCalledWith(
      expect.objectContaining({ minimumScore: -1 }),
      "FACT_VERSION",
      "EXACT",
      2
    );
    expect(result).toMatchObject({
      hits: [{ itemId: "fact-saved-name", score: 0.2 }],
      lanes: [{ candidateCount: 1, resultCount: 1 }],
      status: "READY"
    });
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
