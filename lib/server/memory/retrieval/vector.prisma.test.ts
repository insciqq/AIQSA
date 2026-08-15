import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import {
  MEMORY_EXACT_VECTOR_MAX_ELIGIBLE_ROWS,
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
  createPrismaMemoryVectorRepository,
  memoryVectorAuthoritativeRejoinSql,
  memoryVectorCandidateSql,
  memoryVectorEligibleCountSql,
  type MemoryVectorProfile,
  type MemoryVectorSearchInput
} from "./vector";

const now = new Date("2026-08-10T13:00:00.000Z");
const suffix = randomUUID();
const connectionId = `memory-vector-connection-${suffix}`;
const modelId = `memory-vector-model-${suffix}`;
const ownerIds: string[] = [];

type HistoryFixture = Readonly<{
  chatId: string;
  generationId: string;
  profile: MemoryVectorProfile;
  userId: string;
}>;

let annFixture: HistoryFixture;
let exactFixture: HistoryFixture;
let foreignFixture: HistoryFixture;
let stalePipelineFixture: HistoryFixture;

const embeddingConfiguration = {
  adapterKind: "openai_embeddings_compatible",
  answerSelectable: false,
  capabilities: {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    vision: false
  },
  defaultParams: {},
  embedding: {
    nativeDimension: 1_024,
    providerFamily: "openai_compatible",
    queryInstructionTemplate: null,
    supportsMrl: false,
    targetDimension: 1_024
  },
  modelClass: "embedding",
  upstreamModelId: "memory-vector-fixture-v1"
} as const;

function queryVector(dimension: 1_024 | 1_536 = 1_024): number[] {
  return Array.from({ length: dimension }, (_, index) => index === 0 ? 1 : 0);
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) throw new Error("memory_vector_latency_sample_missing");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

function explainExecutionTimeMs(rows: readonly unknown[]): number {
  const first = rows[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    throw new Error("memory_vector_explain_invalid");
  }
  const payload = (first as Record<string, unknown>)["QUERY PLAN"];
  if (!Array.isArray(payload) || !payload[0] || typeof payload[0] !== "object") {
    throw new Error("memory_vector_explain_invalid");
  }
  const value = (payload[0] as Record<string, unknown>)["Execution Time"];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("memory_vector_explain_invalid");
  }
  return value;
}

async function createHistoryFixture(
  prefix: string,
  configurationFingerprint: string,
  vectorSpaceFingerprint: string,
  retrievalPipelineVersion = MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
): Promise<HistoryFixture> {
  const userId = `${prefix}-user-${suffix}`;
  ownerIds.push(userId);
  await prisma.user.create({
    data: {
      displayName: `Memory vector ${prefix}`,
      email: `${prefix}-${suffix}@example.test`,
      id: userId,
      status: "active"
    }
  });
  const chat = await prisma.chat.create({
    data: {
      memorySourceRevision: 1,
      title: `Memory vector ${prefix}`,
      userId
    }
  });
  const leaf = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent(`Memory vector ${prefix} source`),
      role: "user"
    }
  });
  await prisma.chat.update({
    data: { activeLeafMessageId: leaf.id },
    where: { id: chat.id }
  });
  await prisma.chatMemoryCheckpoint.create({
    data: {
      activeLeafMessageId: leaf.id,
      branchGeneration: 0,
      chatId: chat.id,
      lastIndexedMessageId: leaf.id,
      lastSucceededAt: now,
      sourceContentHash: "a".repeat(64),
      sourceRevision: 1,
      status: "READY",
      userId
    }
  });
  const generation = await prisma.memoryIndexGeneration.create({
    data: {
      chunkingVersion: "memory-history-chunking-v1",
      embeddingConfigurationFingerprint: configurationFingerprint,
      embeddingConnectionId: connectionId,
      embeddingDimension: 1_024,
      embeddingProviderModelId: modelId,
      generation: 0,
      indexMode: "HYBRID",
      indexedThroughMemoryRevision: 0,
      languageProfile: "RU_EN_MULTILINGUAL_V1",
      normalizationVersion: "memory-search-normalization-v1",
      readyAt: now,
      retrievalPipelineVersion,
      state: "READY",
      targetMemoryRevision: 0,
      userId,
      vectorSpaceFingerprint
    }
  });
  await prisma.$transaction(async (tx) => {
    await tx.userMemorySettings.update({
      data: {
        activeIndexGenerationId: generation.id,
        embeddingProviderModelId: modelId,
        referenceChatHistory: true
      },
      where: { userId }
    });
    await tx.memoryIndexGeneration.update({
      data: { activatedAt: now, state: "ACTIVE" },
      where: { id: generation.id }
    });
  });
  return {
    chatId: chat.id,
    generationId: generation.id,
    profile: {
      configurationFingerprint,
      connectionId,
      dimension: 1_024,
      generationId: generation.id,
      providerModelId: modelId,
      retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
      vectorSpaceFingerprint
    },
    userId
  };
}

async function insertReadyChunks(
  fixture: HistoryFixture,
  prefix: string,
  count: number,
  divisor: number
): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "MemoryRecallChunk" (
      "id", "userId", "chatId", "branchGeneration",
      "sourceRevisionAtCreation", "chunkOrdinal", "contentHash",
      "safeProjectedText", "normalizedSafeSearchText", "languageCode",
      "occurredFrom", "occurredTo", "state", "chunkingVersion",
      "sourceProjectionVersion", "safetyClass", "redactionState"
    )
    SELECT
      ${prefix} || '-chunk-' || n,
      ${fixture.userId},
      ${fixture.chatId},
      0,
      1,
      n,
      repeat(md5(${prefix} || '-chunk-' || n), 2),
      'Safe vector fixture ' || n,
      'safe vector fixture ' || n,
      'en',
      ${now} - interval '1 day',
      ${now},
      'ACTIVE'::"MemoryHistoryItemState",
      'memory-history-chunking-v1',
      'memory-history-source-projection-v1',
      'NORMAL'::"MemoryDerivedSafetyClass",
      'NOT_NEEDED'::"MemoryRedactionState"
    FROM generate_series(1, ${count}) AS n
  `);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "MemorySearchEntry" (
      "id", "userId", "indexGenerationId", "itemType", "recallChunkId",
      "safeSearchText", "safeSearchTextYoNormalized", "safeContentHash",
      "languageCode", "safetyIdentitySnapshot", "sourceIdentitySnapshot",
      "suppressionIdentitySnapshot", "embedding", "embeddingDimension",
      "embeddingState"
    )
    SELECT
      ${prefix} || '-entry-' || n,
      ${fixture.userId},
      ${fixture.generationId},
      'RECALL_CHUNK'::"MemorySearchItemType",
      ${prefix} || '-chunk-' || n,
      'safe vector fixture ' || n,
      'safe vector fixture ' || n,
      repeat(md5(${prefix} || '-chunk-' || n), 2),
      'en',
      repeat(md5(${prefix} || '-safety-' || n), 2),
      repeat(md5(${prefix} || '-source-' || n), 2),
      repeat(md5(${prefix} || '-suppression-' || n), 2),
      (
        ARRAY[1::real] ||
        array_fill((n::real / ${divisor}), ARRAY[1023])
      )::vector,
      1024,
      'READY'::"MemoryEmbeddingState"
    FROM generate_series(1, ${count}) AS n
  `);
}

function searchInput(
  fixture: HistoryFixture,
  overrides: Partial<MemoryVectorSearchInput> = {}
): MemoryVectorSearchInput {
  return {
    eligibility: {
      allowedFactSensitivity: ["NORMAL", "SENSITIVE"],
      allowedHistorySafety: ["NORMAL", "SENSITIVE"],
      assistantId: null,
      chatId: fixture.chatId,
      folderId: null,
      occurredFrom: null,
      occurredTo: null,
      sourceAssistantId: null,
      sourceChatIds: null,
      sourceFolderId: null
    },
    itemTypes: ["RECALL_CHUNK"],
    limit: 5,
    minimumScore: 0,
    profile: fixture.profile,
    userId: fixture.userId,
    vector: queryVector(),
    ...overrides
  };
}

describe("Memory vector retrieval on PostgreSQL 16.14 and pgvector 0.8.5", () => {
  beforeAll(async () => {
    // Repeated qualification runs delete their owned fixture rows, but HNSW
    // can retain dead graph tuples until vacuum. Start from a maintained index
    // so recall evidence is about the pinned query/profile rather than debris
    // from an earlier local test invocation.
    await prisma.$executeRawUnsafe(
      'VACUUM (ANALYZE) "MemorySearchEntry"'
    );
    await prisma.providerConnection.create({
      data: {
        activeConfig: {
          allowPrivateNetwork: false,
          apiRoot: "https://memory-vector.example.test/v1",
          responseTimeoutMs: 30_000
        },
        activeVersion: 1,
        activatedAt: now,
        displayName: "Memory vector fixture provider",
        draftConfig: {
          allowPrivateNetwork: false,
          apiRoot: "https://memory-vector.example.test/v1",
          responseTimeoutMs: 30_000
        },
        draftVersion: 1,
        enabled: true,
        family: "openai_compatible",
        id: connectionId
      }
    });
    await prisma.providerModel.create({
      data: {
        activeConfig: embeddingConfiguration,
        activeVersion: 1,
        activatedAt: now,
        capabilities: embeddingConfiguration.capabilities,
        connectionId,
        defaultParams: {},
        displayName: "Memory vector fixture model",
        draftConfig: embeddingConfiguration,
        draftVersion: 1,
        enabled: true,
        id: modelId,
        modelClass: "embedding",
        modelId: embeddingConfiguration.upstreamModelId,
        provider: "openai_compatible"
      }
    });

    annFixture = await createHistoryFixture(
      "memory-vector-ann",
      "b".repeat(64),
      "c".repeat(64)
    );
    exactFixture = await createHistoryFixture(
      "memory-vector-exact",
      "d".repeat(64),
      "e".repeat(64)
    );
    foreignFixture = await createHistoryFixture(
      "memory-vector-foreign",
      "f".repeat(64),
      "0".repeat(64)
    );
    stalePipelineFixture = await createHistoryFixture(
      "memory-vector-stale-pipeline",
      "4".repeat(64),
      "5".repeat(64),
      "memory-vector-retrieval-obsolete"
    );
    await insertReadyChunks(
      annFixture,
      `memory-vector-ann-${suffix}`,
      MEMORY_EXACT_VECTOR_MAX_ELIGIBLE_ROWS + 1,
      100_000
    );
    await insertReadyChunks(
      exactFixture,
      `memory-vector-exact-${suffix}`,
      32,
      10_000
    );
    await insertReadyChunks(
      foreignFixture,
      `memory-vector-foreign-${suffix}`,
      MEMORY_EXACT_VECTOR_MAX_ELIGIBLE_ROWS + 1,
      10_000_000
    );

    const incompatible = await prisma.memoryIndexGeneration.create({
      data: {
        activatedAt: now,
        chunkingVersion: "memory-history-chunking-v1",
        embeddingConfigurationFingerprint: "1".repeat(64),
        embeddingConnectionId: connectionId,
        embeddingDimension: 1_536,
        embeddingProviderModelId: modelId,
        generation: 1,
        indexMode: "HYBRID",
        indexedThroughMemoryRevision: 0,
        languageProfile: "RU_EN_MULTILINGUAL_V1",
        normalizationVersion: "memory-search-normalization-v1",
        readyAt: now,
        retrievalPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
        state: "SUPERSEDED",
        supersededAt: now,
        targetMemoryRevision: 0,
        userId: annFixture.userId,
        vectorSpaceFingerprint: "2".repeat(64)
      }
    });
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "MemorySearchEntry" (
        "id", "userId", "indexGenerationId", "itemType", "recallChunkId",
        "safeSearchText", "safeSearchTextYoNormalized", "safeContentHash",
        "languageCode", "safetyIdentitySnapshot", "sourceIdentitySnapshot",
        "suppressionIdentitySnapshot", "embedding", "embeddingDimension",
        "embeddingState"
      )
      SELECT
        ${`memory-vector-incompatible-${suffix}`} || '-entry-' || n,
        ${annFixture.userId},
        ${incompatible.id},
        'RECALL_CHUNK'::"MemorySearchItemType",
        ${`memory-vector-ann-${suffix}`} || '-chunk-' || n,
        'safe vector fixture ' || n,
        'safe vector fixture ' || n,
        repeat(md5(${`memory-vector-ann-${suffix}`} || '-chunk-' || n), 2),
        'en',
        repeat(md5('incompatible-safety-' || n), 2),
        repeat(md5('incompatible-source-' || n), 2),
        repeat(md5('incompatible-suppression-' || n), 2),
        (ARRAY[1::real] || array_fill(0::real, ARRAY[1535]))::vector,
        1536,
        'READY'::"MemoryEmbeddingState"
      FROM generate_series(1, 16) AS n
    `);
    await prisma.$executeRaw`ANALYZE "MemorySearchEntry"`;
  }, 120_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: ownerIds } } });
    await prisma.providerModel.deleteMany({ where: { id: modelId } });
    await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    await prisma.$disconnect();
  }, 120_000);

  it("keeps ANN results inside the exact owner/generation/dimension and preserves Recall@5", async () => {
    const repository = createPrismaMemoryVectorRepository(prisma);
    const result = await repository.search(searchInput(annFixture));
    expect(result.status).toBe("READY");
    if (result.status !== "READY") throw new Error(result.reason);
    expect(result.lanes).toEqual([
      expect.objectContaining({
        eligibleCount: MEMORY_EXACT_VECTOR_MAX_ELIGIBLE_ROWS + 1,
        itemType: "RECALL_CHUNK",
        strategy: "HNSW"
      })
    ]);
    const expected = Array.from(
      { length: 5 },
      (_, index) => `memory-vector-ann-${suffix}-entry-${index + 1}`
    );
    expect(result.hits.map((hit) => hit.entryId)).toEqual(expected);
    expect(result.hits).toHaveLength(5);
    expect(result.hits.every((hit) =>
      hit.itemId.startsWith(`memory-vector-ann-${suffix}-chunk-`))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("memory-vector-foreign");
    expect(JSON.stringify(result)).not.toContain("memory-vector-incompatible");
  }, 60_000);

  it("uses bounded exact retrieval and degrades on stale vector authority", async () => {
    const repository = createPrismaMemoryVectorRepository(prisma);
    const exact = await repository.search(searchInput(exactFixture));
    expect(exact).toMatchObject({
      lanes: [{ eligibleCount: 32, exactFallbackUsed: false, strategy: "EXACT" }],
      status: "READY"
    });
    const stale = await repository.search(searchInput(exactFixture, {
      profile: {
        ...exactFixture.profile,
        vectorSpaceFingerprint: "3".repeat(64)
      }
    }));
    expect(stale).toEqual({
      hits: [],
      lanes: [],
      reason: "memory_vector_generation_stale",
      status: "DEGRADED"
    });
    await expect(repository.search(searchInput(stalePipelineFixture)))
      .resolves.toEqual({
        hits: [],
        lanes: [],
        reason: "memory_vector_generation_stale",
        status: "DEGRADED"
      });
  }, 60_000);

  it("proves the production HNSW plan, bounded exact plan, and pinned database profile", async () => {
    const versions = await prisma.$queryRaw<Array<{
      pgvector: string;
      postgres: string;
    }>>(Prisma.sql`
      SELECT
        current_setting('server_version') AS postgres,
        (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS pgvector
    `);
    expect(versions[0]).toMatchObject({ pgvector: "0.8.5" });
    expect(versions[0]?.postgres).toMatch(/^16\.14(?:\D|$)/u);

    const annStatement = memoryVectorCandidateSql({
      input: searchInput(annFixture),
      itemType: "RECALL_CHUNK",
      limit: 40
    });
    const annPlan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL plan_cache_mode = force_custom_plan`;
      await tx.$executeRaw`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
      await tx.$executeRaw`SET LOCAL hnsw.ef_search = 100`;
      await tx.$executeRaw`SET LOCAL hnsw.max_scan_tuples = 20000`;
      return tx.$queryRaw<unknown[]>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${annStatement}
      `);
    });
    expect(JSON.stringify(annPlan)).toContain(
      "MemorySearchEntry_embedding_1024_hnsw_idx"
    );
    const annRejoinPlan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL plan_cache_mode = force_custom_plan`;
      await tx.$executeRaw`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
      await tx.$executeRaw`SET LOCAL hnsw.ef_search = 100`;
      await tx.$executeRaw`SET LOCAL hnsw.max_scan_tuples = 20000`;
      const candidates = await tx.$queryRaw<Array<{ entryId: string }>>(
        annStatement
      );
      return tx.$queryRaw<unknown[]>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        ${memoryVectorAuthoritativeRejoinSql({
          candidateIds: candidates.map(({ entryId }) => entryId),
          input: searchInput(annFixture),
          itemType: "RECALL_CHUNK"
        })}
      `);
    });
    const annCountPlan = await prisma.$queryRaw<unknown[]>(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${memoryVectorEligibleCountSql({
        input: searchInput(annFixture),
        itemType: "RECALL_CHUNK"
      })}
    `);
    const exactStatement = memoryVectorCandidateSql({
      input: searchInput(exactFixture),
      itemType: "RECALL_CHUNK",
      limit: 5
    });
    const exactPlan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_indexscan = off`;
      return tx.$queryRaw<unknown[]>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${exactStatement}
      `);
    });
    const annPlanJson = JSON.stringify(annPlan);
    const exactPlanJson = JSON.stringify(exactPlan);
    expect(exactPlanJson).not.toContain(
      "MemorySearchEntry_embedding_1024_hnsw_idx"
    );
    expect(exactPlanJson).toMatch(/Sort|Seq Scan/u);

    const repository = createPrismaMemoryVectorRepository(prisma);
    await repository.search(searchInput(annFixture));
    await repository.search(searchInput(exactFixture));
    const sampleCount = 12;
    const annLatenciesMs: number[] = [];
    const exactLatenciesMs: number[] = [];
    let qualifiedAnnResult: Awaited<ReturnType<typeof repository.search>> | null = null;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      let startedAt = performance.now();
      qualifiedAnnResult = await repository.search(searchInput(annFixture));
      annLatenciesMs.push(performance.now() - startedAt);
      startedAt = performance.now();
      await repository.search(searchInput(exactFixture));
      exactLatenciesMs.push(performance.now() - startedAt);
    }
    if (!qualifiedAnnResult || qualifiedAnnResult.status !== "READY") {
      throw new Error("memory_vector_qualification_result_unavailable");
    }
    const expected = new Set(Array.from(
      { length: 5 },
      (_, index) => `memory-vector-ann-${suffix}-entry-${index + 1}`
    ));
    const recallAt5 = qualifiedAnnResult.hits.filter(({ entryId }) =>
      expected.has(entryId)).length / expected.size;
    const crossTenantLeakageCount = qualifiedAnnResult.hits.filter(({ itemId }) =>
      !itemId.startsWith(`memory-vector-ann-${suffix}-chunk-`)).length;
    const incompatibleSpaceLeakageCount = qualifiedAnnResult.hits.filter(({ entryId }) =>
      entryId.includes("incompatible")).length;
    const annLane = qualifiedAnnResult.lanes[0];
    if (!annLane) throw new Error("memory_vector_qualification_lane_missing");
    const evidence = Object.freeze({
      annEligibleRows: MEMORY_EXACT_VECTOR_MAX_ELIGIBLE_ROWS + 1,
      annCandidateExecutionMs: explainExecutionTimeMs(annPlan),
      annCountExecutionMs: explainExecutionTimeMs(annCountPlan),
      annRejoinExecutionMs: explainExecutionTimeMs(annRejoinPlan),
      annExactFallbackUsed: annLane.exactFallbackUsed,
      annP95LatencyMs: Math.round(percentile95(annLatenciesMs) * 100) / 100,
      crossTenantLeakageCount,
      evidenceVersion: "memory-vector-qualification-v1",
      exactEligibleRows: 32,
      exactP95LatencyMs: Math.round(percentile95(exactLatenciesMs) * 100) / 100,
      exactPlanBounded: !exactPlanJson.includes(
        "MemorySearchEntry_embedding_1024_hnsw_idx"
      ),
      hnswIndexUsed: annPlanJson.includes(
        "MemorySearchEntry_embedding_1024_hnsw_idx"
      ),
      incompatibleSpaceLeakageCount,
      pgvectorVersion: versions[0]!.pgvector,
      postgresqlMajorMinor: "16.14",
      recallAt5,
      sampleCount,
      sanitizedAggregatesOnly: true
    });
    expect(evidence).toMatchObject({
      annExactFallbackUsed: false,
      crossTenantLeakageCount: 0,
      exactPlanBounded: true,
      hnswIndexUsed: true,
      incompatibleSpaceLeakageCount: 0,
      recallAt5: 1,
      sanitizedAggregatesOnly: true
    });
    console.info("memory_vector_qualification", evidence);
    expect(evidence.annP95LatencyMs).toBeLessThan(150);
    expect(evidence.exactP95LatencyMs).toBeLessThan(150);
    expect(JSON.stringify(evidence)).not.toContain(suffix);
  }, 120_000);
});
