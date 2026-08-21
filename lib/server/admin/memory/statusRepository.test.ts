import type { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MEMORY_LEXICAL_CHUNKING_VERSION, MEMORY_LEXICAL_LANGUAGE_PROFILE, MEMORY_LEXICAL_NORMALIZATION_VERSION, MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION } from "../../memory/persistence/lexical";
import { createPrismaAdminMemoryStatusRepository } from "./statusRepository";

function clientFixture(input: Readonly<{
  heartbeat?: Date | null;
  historyReindexing?: boolean;
  selectedEmbeddingProviderModelId?: string | null;
  staleChunk?: boolean;
}> = {}) {
  const heartbeat = input.heartbeat === undefined
    ? new Date("2026-08-21T08:00:00.000Z")
    : input.heartbeat;
  const queryRaw = vi.fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(input.staleChunk ? [{ userId: "private-owner" }] : [])
    .mockResolvedValueOnce(heartbeat ? [{ lastSeenAt: heartbeat }] : []);
  const memoryJobFindFirst = vi.fn(async (args: {
    select: Record<string, boolean>;
  }) => args.select.createdAt
    ? { createdAt: new Date("2026-08-21T07:59:50.000Z") }
    : { errorCode: "memory_job_failed", updatedAt: new Date("2026-08-21T07:58:00.000Z") });
  const deletionFindFirst = vi.fn(async (args: {
    select: Record<string, boolean>;
  }) => args.select.createdAt
    ? null
    : null);
  return {
    $queryRaw: queryRaw,
    memoryDeletionOutbox: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: deletionFindFirst
    },
    memoryFactVersion: { findMany: vi.fn().mockResolvedValue([]) },
    memoryIndexGeneration: {
      findMany: vi.fn().mockResolvedValue([{
        chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
        embeddingProviderModelId: null,
        generation: 7,
        id: "private-generation",
        indexMode: "LEXICAL_ONLY",
        languageProfile: MEMORY_LEXICAL_LANGUAGE_PROFILE,
        normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
        retrievalPipelineVersion: MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
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
      count: vi.fn().mockResolvedValue(2),
      findFirst: memoryJobFindFirst,
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
    systemModelPolicy: {
      findUnique: vi.fn().mockResolvedValue({ providerModelId: "private-system-model" })
    },
    userMemorySettings: {
      findMany: vi.fn().mockResolvedValue([{
        activeIndexGenerationId: "private-generation",
        embeddingProviderModelId: input.selectedEmbeddingProviderModelId ?? null,
        memoryRevision: 4,
        settingsRevision: 3,
        userId: "private-owner"
      }])
    }
  } as unknown as PrismaClient;
}

describe("Prisma administrator Memory status repository", () => {
  it("projects aggregate runtime evidence without owner or model identifiers", async () => {
    const startRebuild = vi.fn().mockResolvedValue(undefined);
    const client = clientFixture();
    const repository = createPrismaAdminMemoryStatusRepository(
      client,
      startRebuild
    );
    const result = await repository.read(new Date("2026-08-21T08:00:00.000Z"));

    expect(result).toMatchObject({
      admissionTimeout: { seconds: 15, version: 4 },
      activeIssueCode: "memory_job_failed",
      configuredTargets: [{ model: "Utility model", provider: "Primary provider" }],
      index: {
        activeGenerations: [7],
        ownerCount: 1,
        preparing: false,
        rebuildCandidates: [],
        rebuilding: false,
        requiresRebuild: false
      },
      queueLength: 2,
      workerLastSeenAt: new Date("2026-08-21T08:00:00.000Z")
    });
    expect(client.userMemorySettings.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { referenceChatHistory: true },
            { useMemoryFacts: true }
          ]
        }
      })
    );
    const rawQueries = (client.$queryRaw as unknown as {
      mock: { calls: Array<[Prisma.Sql]> };
    }).mock.calls;
    const pendingClassificationSql = rawQueries[0]?.[0].strings.join("?") ?? "";
    expect(pendingClassificationSql).toContain('scope."scopeType" = \'GLOBAL_USER\'');
    expect(pendingClassificationSql).toContain('evidence_chat."projectId" IS NULL');
    const staleProjectionQuery = rawQueries[1]?.[0];
    const staleProjectionSql = staleProjectionQuery?.strings.join("?") ?? "";
    expect(staleProjectionSql).toContain('chunk."chunkingVersion" <>');
    expect(staleProjectionSql).toContain('chunk."sourceProjectionVersion" <>');
    expect(staleProjectionSql).toContain('checkpoint."pipelineVersion" <>');
    expect(JSON.stringify({
      activeIssueCode: result.activeIssueCode,
      configuredTargets: result.configuredTargets,
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
