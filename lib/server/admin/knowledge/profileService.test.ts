import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeVectorSpacePin } from "../../knowledge/indexProfile";
import {
  AdminKnowledgeProfileServiceError,
  createAdminKnowledgeProfileService
} from "./profileService";

const NOW = new Date("2026-08-18T02:00:00.000Z");

const pin: KnowledgeVectorSpacePin = {
  configuration: {
    adapterKind: "openai_embeddings_compatible",
    deploymentId: "embedding-1",
    nativeDimension: 1024,
    providerFamily: "openai_compatible",
    queryInstructionTemplate: null,
    schemaVersion: 1,
    supportsMrl: false,
    targetDimension: 1024,
    upstreamModelId: "multilingual-embed"
  },
  fingerprint: "a".repeat(64),
  indexSupported: true,
  targetDimension: 1024
};

function revision(overrides: Record<string, unknown> = {}) {
  return {
    activatedAt: NOW,
    chunkingProfileVersion: 1,
    createdAt: NOW,
    egressPolicy: {
      operations: [{
        operation: "embeddings",
        representations: ["document_text_chunks", "search_queries"]
      }],
      policyVersion: "knowledge-profile-egress-v1"
    },
    embeddingConfiguration: pin.configuration,
    embeddingProviderModel: {
      activeConfig: pin.configuration,
      activeVersion: 1,
      connection: { displayName: "Embedding route" },
      displayName: "Multilingual embed",
      enabled: true,
      id: "embedding-1",
      provider: "openai_compatible"
    },
    embeddingProviderModelId: "embedding-1",
    executionAuthority: "installation",
    id: "revision-1",
    preflightCheckedAt: NOW,
    preflightErrorCode: null,
    preflightStatus: "ready",
    profileConfiguration: { schemaVersion: 1 },
    profileId: "installation",
    revisionNumber: 1,
    targetDimension: 1024,
    vectorSpaceFingerprint: pin.fingerprint,
    ...overrides
  };
}

describe("administrator Knowledge profile service", () => {
  it("creates a preflighted immutable revision and schedules shadow cutover atomically", async () => {
    const create = vi.fn().mockResolvedValue({ id: "revision-2" });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      knowledgeIndexProfile: {
        findUnique: vi.fn().mockResolvedValue({ version: 4 }),
        updateMany
      },
      knowledgeIndexProfileRevision: {
        create,
        findFirst: vi.fn().mockResolvedValue({ revisionNumber: 1 })
      },
      knowledgePolicy: {
        findUnique: vi.fn().mockResolvedValue({
          candidateLimit: 40,
          resultLimit: 8,
          scoreThreshold: 0.01
        })
      },
      providerModel: {
        findFirst: vi.fn().mockResolvedValue({
          connection: { displayName: "Vision route" },
          displayName: "Document vision",
          id: "vision-1",
          provider: "openai",
          supportsVision: true
        })
      }
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx))
    } as unknown as PrismaClient;
    const resolveInstallationDestination = vi.fn(async () => ({ pin }));
    const scheduleMigration = vi.fn(async () => ({
      activatedBases: 0,
      alreadyActiveBases: 0,
      buildingBases: 1,
      createdGenerations: 1,
      queuedArtifacts: 1,
      supersededGenerations: 0
    }));
    const service = createAdminKnowledgeProfileService(prisma, {
      resolveInstallationDestination,
      resolveInstallationVisionDestination: vi.fn(async () => ({ supportsNativePdf: true })),
      scheduleMigration
    });

    await service.activate({
      deploymentId: "embedding-1",
      expectedVersion: 4,
      now: NOW,
      userId: "admin-1",
      visionDeploymentId: "vision-1"
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        activatedAt: NOW,
        chunkingProfileVersion: 4,
        embeddingProviderModelId: "embedding-1",
        executionAuthority: "installation",
        preflightStatus: "ready",
        profileConfiguration: expect.objectContaining({
          operationRoles: expect.arrayContaining([
            expect.objectContaining({ mode: "disabled", operation: "query_planning" }),
            expect.objectContaining({ mode: "local", operation: "reranking" }),
            expect.objectContaining({ mode: "local", operation: "grounding_validation" }),
            expect.objectContaining({ mode: "local", operation: "citation_repair" }),
            expect.objectContaining({ mode: "disabled", operation: "answer_citation_retry" })
          ]),
          rolePolicyVersion: 1,
          schemaVersion: 3,
          visualAnalysis: expect.objectContaining({
            providerModelId: "vision-1",
            supportsNativePdf: true
          })
        }),
        profileId: "installation",
        revisionNumber: 2,
        vectorSpaceFingerprint: pin.fingerprint,
        egressPolicy: expect.objectContaining({
          operations: expect.arrayContaining([expect.objectContaining({
            operation: "vision_analysis",
            providerModelId: "vision-1"
          })]),
          policyVersion: "knowledge-profile-egress-v3"
        })
      }),
      select: { id: true }
    });
    expect(updateMany).toHaveBeenCalledWith({
      data: {
        activeRevisionId: "revision-2",
        updatedByUserId: "admin-1",
        version: { increment: 1 }
      },
      where: { id: "installation", version: 4 }
    });
    expect(scheduleMigration).toHaveBeenCalledWith(tx, {
      now: NOW,
      profileRevisionId: "revision-2"
    });
  });

  it("returns aggregate health and destination disclosure without private corpus data", async () => {
    const active = revision();
    const count = vi.fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(0);
    const prisma = {
      knowledgeBase: { count: vi.fn().mockResolvedValue(2) },
      knowledgeIndexGeneration: { count },
      knowledgeIndexProfile: {
        findUnique: vi.fn().mockResolvedValue({
          activeRevision: active,
          revisions: [active],
          updatedAt: NOW,
          updatedBy: { displayName: "Administrator", id: "admin-1" },
          version: 2
        })
      },
      providerModel: {
        findMany: vi.fn().mockResolvedValue([active.embeddingProviderModel])
      }
    } as unknown as PrismaClient;
    const service = createAdminKnowledgeProfileService(prisma, {
      resolveInstallationDestination: vi.fn(async () => ({ pin }))
    });

    const result = await service.list();

    expect(result).toMatchObject({
      activeRevision: {
        destination: {
          connectionDisplayName: "Embedding route",
          deploymentId: "embedding-1",
          modelDisplayName: "Multilingual embed"
        },
        revisionNumber: 1
      },
      egress: {
        destination: "Embedding route / Multilingual embed",
        representations: ["document_text_chunks", "search_queries"],
        roles: [
          { mode: "external", operation: "embeddings" },
          { mode: "disabled", operation: "vision_analysis" },
          { mode: "disabled", operation: "query_planning" },
          { mode: "local", operation: "reranking" },
          { mode: "local", operation: "grounding_validation" },
          { mode: "local", operation: "citation_repair" },
          { mode: "disabled", operation: "answer_citation_retry" }
        ]
      },
      health: { code: null, state: "ready" },
      migration: {
        activeProfileBases: 2,
        buildingProfileBases: 0,
        legacyGenerations: 0,
        profiledGenerations: 3,
        totalBases: 2
      }
    });
    expect(JSON.stringify(result)).not.toMatch(/filename|passage|query text|base name/iu);
  });

  it("keeps embedding ready while exposing a pinned visual-policy failure as degraded", async () => {
    const visual = {
      connectionDisplayName: "Vision route",
      modelDisplayName: "Document vision",
      provider: "openai",
      providerModelId: "vision-1",
      supportsNativePdf: true
    };
    const active = revision({
      egressPolicy: {
        operations: [{
          operation: "embeddings",
          representations: ["document_text_chunks", "search_queries"]
        }, {
          operation: "vision_analysis",
          providerModelId: "vision-1",
          representations: ["visual_source_bytes", "visual_queries"]
        }],
        policyVersion: "knowledge-profile-egress-v2"
      },
      profileConfiguration: {
        schemaVersion: 2,
        visualAnalysis: visual
      }
    });
    const prisma = {
      knowledgeBase: { count: vi.fn().mockResolvedValue(0) },
      knowledgeIndexGeneration: { count: vi.fn().mockResolvedValue(0) },
      knowledgeIndexProfile: {
        findUnique: vi.fn().mockResolvedValue({
          activeRevision: active,
          revisions: [active],
          updatedAt: NOW,
          updatedBy: { displayName: "Administrator", id: "admin-1" },
          version: 2
        })
      },
      providerModel: { findMany: vi.fn().mockResolvedValue([]) }
    } as unknown as PrismaClient;
    const service = createAdminKnowledgeProfileService(prisma, {
      resolveInstallationDestination: vi.fn(async () => ({ pin })),
      resolveInstallationVisionDestination: vi.fn(async () => null)
    });

    await expect(service.list()).resolves.toMatchObject({
      activeRevision: { visionDestination: { deploymentId: "vision-1" } },
      egress: {
        visualAnalysis: {
          destination: "Vision route / Document vision",
          representations: ["visual_source_bytes", "visual_queries"]
        }
      },
      health: {
        code: "knowledge_profile_visual_unavailable",
        state: "ready_with_warnings"
      }
    });
  });

  it("rejects stale activation before preflight and refuses an unavailable rollback", async () => {
    const tx = {
      knowledgeIndexProfile: {
        findUnique: vi.fn().mockResolvedValue({ activeRevisionId: "revision-2", version: 3 }),
        updateMany: vi.fn()
      },
      knowledgeIndexProfileRevision: {
        findFirst: vi.fn().mockResolvedValue(revision({ id: "revision-1" }))
      }
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx))
    } as unknown as PrismaClient;
    const resolveInstallationDestination = vi.fn().mockResolvedValue(null);
    const service = createAdminKnowledgeProfileService(prisma, {
      resolveInstallationDestination
    });

    await expect(service.activate({
      deploymentId: "embedding-1",
      expectedVersion: 2,
      now: NOW,
      userId: "admin-1",
      visionDeploymentId: null
    })).rejects.toEqual(new AdminKnowledgeProfileServiceError("knowledge_profile_stale"));
    await expect(service.rollback({
      expectedVersion: 3,
      revisionId: "revision-1",
      userId: "admin-1"
    })).rejects.toEqual(
      new AdminKnowledgeProfileServiceError("knowledge_profile_revision_unavailable")
    );
    expect(tx.knowledgeIndexProfile.updateMany).not.toHaveBeenCalled();
  });

  it("rolls back through a shadow migration while preserving immutable revisions", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const target = revision({ id: "revision-1" });
    const tx = {
      knowledgeIndexProfile: {
        findUnique: vi.fn().mockResolvedValue({ activeRevisionId: "revision-2", version: 4 }),
        updateMany
      },
      knowledgeIndexProfileRevision: {
        findFirst: vi.fn().mockResolvedValue(target)
      }
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx))
    } as unknown as PrismaClient;
    const scheduleMigration = vi.fn(async () => ({
      activatedBases: 1,
      alreadyActiveBases: 0,
      buildingBases: 0,
      createdGenerations: 1,
      queuedArtifacts: 0,
      supersededGenerations: 0
    }));
    const service = createAdminKnowledgeProfileService(prisma, {
      resolveInstallationDestination: vi.fn(async () => ({ pin })),
      scheduleMigration
    });

    await service.rollback({
      expectedVersion: 4,
      now: NOW,
      revisionId: "revision-1",
      userId: "admin-1"
    });

    expect(updateMany).toHaveBeenCalledWith({
      data: {
        activeRevisionId: "revision-1",
        updatedByUserId: "admin-1",
        version: { increment: 1 }
      },
      where: { id: "installation", version: 4 }
    });
    expect(tx.knowledgeIndexProfileRevision.findFirst).toHaveBeenCalledWith({
      where: { id: "revision-1", profileId: "installation" }
    });
    expect(scheduleMigration).toHaveBeenCalledWith(tx, {
      now: NOW,
      profileRevisionId: "revision-1"
    });
  });
});
