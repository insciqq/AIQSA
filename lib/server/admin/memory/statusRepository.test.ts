import type { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
  MEMORY_RECALL_ROUND_PROJECTION_VERSION
} from "../../memory/history/rounds";
import { MEMORY_LEXICAL_CHUNKING_VERSION, MEMORY_LEXICAL_ANALYSIS_PROFILE, MEMORY_LEXICAL_NORMALIZATION_VERSION, MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION } from "../../memory/persistence/lexical";
import { createPrismaAdminMemoryStatusRepository } from "./statusRepository";

vi.mock("./processingRepository", () => ({
  readAdminMemoryProcessing: vi.fn(async () => ({ enabled: true, issues: [] }))
}));

function clientFixture(input: Readonly<{
  heartbeat?: Date | null;
  historyReindexing?: boolean;
  inProgress?: number;
  roundConfigurationStale?: boolean;
  selectedEmbeddingProviderModelId?: string | null;
  shadowRebuilding?: boolean;
  staleChunk?: boolean;
}> = {}) {
  const heartbeat = input.heartbeat === undefined
    ? new Date("2026-08-21T08:00:00.000Z")
    : input.heartbeat;
  const queryRaw = vi.fn()
    .mockResolvedValueOnce([{
      activeIndexGenerationId: "private-generation",
      embeddingProviderModelId: input.selectedEmbeddingProviderModelId ?? null,
      memoryRevision: 4,
      settingsRevision: 3,
      userId: "private-owner"
    }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(input.staleChunk ? [{ userId: "private-owner" }] : [])
    .mockResolvedValueOnce([{
      inProgress: BigInt(input.inProgress ?? 0),
      oldestQueuedAt: new Date("2026-08-21T07:59:50.000Z"),
      waiting: 2n
    }])
    .mockResolvedValueOnce(heartbeat ? [{ lastSeenAt: heartbeat, ready: true }] : [])
    .mockResolvedValueOnce([{ lastProgressAt: null, lastSuccessfulJobAt: null, activeStages: [], hasStalledClaims: false }])
    .mockResolvedValueOnce([{ eligible: 0n, scheduled: 0n, permanent: 0n, protected: 0n,
      exhausted: 0n, obsolete: 0n, configurationRequired: 0n, nextRetryAt: null }]);
  return {
    $queryRaw: queryRaw,
    memoryFactVersion: { findMany: vi.fn().mockResolvedValue([]) },
    memoryIndexGeneration: {
      findMany: vi.fn(async (args: { where?: { state?: unknown } }) =>
        args.where?.state
          ? input.shadowRebuilding ? [{ userId: "private-owner" }] : []
          : [{
              chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
              contextualKeyPolicyVersion: input.roundConfigurationStale
                ? null
                : MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
              embeddingProviderModelId: null,
              generation: 7,
              id: "private-generation",
              indexMode: "LEXICAL_ONLY",
              languageProfile: MEMORY_LEXICAL_ANALYSIS_PROFILE,
              normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
              retrievalPipelineVersion: MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
              roundProjectionVersion: input.roundConfigurationStale
                ? null
                : MEMORY_RECALL_ROUND_PROJECTION_VERSION,
              state: "ACTIVE",
              userId: "private-owner"
            }])
    },
    modelPolicy: {
      findUnique: vi.fn().mockResolvedValue({
        memoryAdmissionTimeoutSeconds: BigInt(15),
        version: 4
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    memoryJob: {
      findMany: vi.fn(async (args: { where: { kind: string } }) =>
        args.where.kind === "INDEX_HISTORY" && input.historyReindexing
          ? [{ userId: "private-owner" }]
          : [])
    },
    providerModel: {
      findMany: vi.fn().mockResolvedValue([{
        connection: { displayName: "Primary provider" },
        displayName: "Utility model",
        id: "private-system-model"
      }])
    },
    memoryUtilityModelPolicy: {
      findUnique: vi.fn().mockResolvedValue({ providerModelId: "private-system-model" })
    }
  } as unknown as PrismaClient;
}

describe("Prisma administrator Memory status repository", () => {
  it("projects aggregate runtime evidence without owner or model identifiers", async () => {
    const startRebuild = vi.fn().mockResolvedValue(undefined);
    const client = clientFixture({ inProgress: 3 });
    const repository = createPrismaAdminMemoryStatusRepository(
      client,
      startRebuild
    );
    const result = await repository.read(new Date("2026-08-21T08:00:00.000Z"));

    expect(result).toMatchObject({
      admissionTimeout: { seconds: 15, version: 4 },
      processing: { enabled: true, issues: [] },
      configuredTargets: [{ model: "Utility model", provider: "Primary provider" }],
      index: {
        activeGenerations: [7],
        ownerCount: 1,
        preparing: false,
        rebuildCandidates: [],
        rebuilding: false,
        requiresRebuild: false
      },
      inProgressCount: 3,
      oldestQueuedAt: new Date("2026-08-21T07:59:50.000Z"),
      queueLength: 2,
      workerLastSeenAt: new Date("2026-08-21T08:00:00.000Z")
    });
    const rawQueries = (client.$queryRaw as unknown as {
      mock: { calls: Array<[Prisma.Sql]> };
    }).mock.calls;
    const pendingClassificationSql = rawQueries[1]?.[0].strings.join("?") ?? "";
    expect(pendingClassificationSql).toContain('scope."scopeType" = \'GLOBAL_USER\'');
    expect(pendingClassificationSql).toContain('evidence_chat."projectId" IS NULL');
    const staleProjectionQuery = rawQueries[2]?.[0];
    const staleProjectionSql = staleProjectionQuery?.strings.join("?") ?? "";
    expect(staleProjectionSql).toContain('chunk."chunkingVersion" <>');
    expect(staleProjectionSql).toContain('chunk."sourceProjectionVersion" <>');
    expect(staleProjectionSql).toContain('checkpoint."pipelineVersion" <>');
    expect(JSON.stringify({
      processing: result.processing,
      configuredTargets: result.configuredTargets,
      inProgressCount: result.inProgressCount,
      queueLength: result.queueLength
    })).not.toMatch(/private-owner|private-generation|private-system-model/u);
  });

  it("marks a stale history projection for the bounded generation rebuild", async () => {
    const repository = createPrismaAdminMemoryStatusRepository(
      clientFixture({ staleChunk: true }),
      vi.fn().mockResolvedValue(undefined)
    );
    const result = await repository.read(new Date("2026-08-21T08:00:00.000Z"));

    expect(result.index.requiresRebuild).toBe(true);
    expect(result.index.rebuildCandidates).toEqual([{
      embeddingDeploymentId: null,
      expectedMemoryRevision: 4,
      expectedSettingsRevision: 3,
      operation: "REINDEX_HISTORY",
      userId: "private-owner"
    }]);
  });

  it("starts a shadow rebuild when the active generation lacks round pins", async () => {
    const repository = createPrismaAdminMemoryStatusRepository(
      clientFixture({ roundConfigurationStale: true }),
      vi.fn().mockResolvedValue(undefined)
    );
    const result = await repository.read(new Date("2026-08-21T08:00:00.000Z"));

    expect(result.index.requiresRebuild).toBe(true);
    expect(result.index.rebuildCandidates).toEqual([{
      embeddingDeploymentId: null,
      expectedMemoryRevision: 4,
      expectedSettingsRevision: 3,
      operation: "REBUILD_SEARCH_INDEX",
      userId: "private-owner"
    }]);
  });

  it("requires a Qwen-selected owner to rebuild a lexical generation as hybrid", async () => {
    const repository = createPrismaAdminMemoryStatusRepository(
      clientFixture({ selectedEmbeddingProviderModelId: "private-qwen-model" }),
      vi.fn().mockResolvedValue(undefined)
    );
    const result = await repository.read(new Date("2026-08-21T08:00:00.000Z"));

    expect(result.index.requiresRebuild).toBe(true);
    expect(result.index.rebuildCandidates).toEqual([{
      embeddingDeploymentId: "private-qwen-model",
      expectedMemoryRevision: 4,
      expectedSettingsRevision: 3,
      operation: "REEMBED",
      userId: "private-owner"
    }]);
  });

  it("reports an admitted bounded history reindex without offering a duplicate action", async () => {
    const repository = createPrismaAdminMemoryStatusRepository(
      clientFixture({ historyReindexing: true, staleChunk: true }),
      vi.fn().mockResolvedValue(undefined)
    );
    const result = await repository.read(new Date("2026-08-21T08:00:00.000Z"));

    expect(result.index).toMatchObject({
      rebuildCandidates: [],
      rebuilding: true,
      requiresRebuild: true
    });
  });

  it("keeps a shadow generation rebuilding between parent-job passes", async () => {
    const repository = createPrismaAdminMemoryStatusRepository(
      clientFixture({
        selectedEmbeddingProviderModelId: "private-qwen-model",
        shadowRebuilding: true
      }),
      vi.fn().mockResolvedValue(undefined)
    );
    const result = await repository.read(new Date("2026-08-21T08:00:00.000Z"));

    expect(result.index).toMatchObject({
      rebuildCandidates: [],
      rebuilding: true,
      requiresRebuild: true
    });
  });

  it("updates the installation timeout only at the expected policy version", async () => {
    const client = clientFixture();
    const repository = createPrismaAdminMemoryStatusRepository(
      client,
      vi.fn().mockResolvedValue(undefined)
    );

    await expect(repository.updateAdmissionTimeout({
      expectedVersion: 4,
      seconds: 30,
      userId: "admin-1"
    })).resolves.toBe(true);
    expect(client.modelPolicy.updateMany).toHaveBeenCalledWith({
      data: {
        memoryAdmissionTimeoutSeconds: BigInt(30),
        updatedByUserId: "admin-1",
        version: { increment: 1 }
      },
      where: { id: "installation", version: 4 }
    });
  });
});
