import type { PrismaClient } from "@prisma/client";
import {
  adminKnowledgeAnswerPolicyFixture,
  adminKnowledgeOperationsFixture,
  adminKnowledgeProfileFixture
} from "@/tests/support/knowledgeProfile";
import { describe, expect, it, vi } from "vitest";
import { createAdminKnowledgePolicyService } from "./policyService";

describe("administrator Knowledge settings service", () => {
  it("projects the installation answer policy beside fixed retrieval facts", async () => {
    const prisma = {} as PrismaClient;
    const settings = await createAdminKnowledgePolicyService(prisma, {
      extractionConfig: () => ({
        maxChunksPerDocument: 300,
        maxFileBytes: 4_000,
        maxNormalizedChars: 2_000,
        maxNormalizedObjectBytes: 9_000,
        maxPages: 20
      }),
      answerPolicyService: {
        list: vi.fn(async () => adminKnowledgeAnswerPolicyFixture()),
        update: vi.fn(),
        updateIngestionParallelism: vi.fn()
      },
      operationsService: {
        read: vi.fn(async () => adminKnowledgeOperationsFixture())
      },
      profileService: {
        activate: vi.fn(),
        list: vi.fn(async () => adminKnowledgeProfileFixture()),
        rollback: vi.fn()
      }
    }).list();

    expect(settings).toMatchObject({
      answerPolicy: {
        fullContextThresholdPercent: 70,
        ingestionParallelism: 8,
        maximumKnowledgeSearches: 12,
        parallelismMaximum: 64,
        parallelismMinimum: 1
      },
      ingestionLimits: {
        maxChunksPerDocument: 300,
        maxFileBytes: 4_000,
        maxNormalizedChars: 2_000,
        maxPages: 20
      },
      operations: { alerts: [], migration: { discrepancies: 0 } },
      retrieval: {
        candidateLimit: 40,
        resultLimit: 16
      }
    });
    expect(settings).not.toHaveProperty("policy");
    expect(settings).not.toHaveProperty("retrievalBounds");
  });

  it("delegates an optimistic answer-policy update", async () => {
    const update = vi.fn();
    const service = createAdminKnowledgePolicyService({} as PrismaClient, {
      answerPolicyService: { list: vi.fn(), update, updateIngestionParallelism: vi.fn() },
      operationsService: { read: vi.fn() },
      profileService: {
        activate: vi.fn(),
        list: vi.fn(),
        rollback: vi.fn()
      }
    });
    await service.updateAnswerPolicy({
      expectedVersion: 3,
      maximumKnowledgeSearches: 18,
      userId: "admin-1"
    });
    expect(update).toHaveBeenCalledWith({
      expectedVersion: 3,
      maximumKnowledgeSearches: 18,
      userId: "admin-1"
    });
  });

  it("delegates an optimistic ingestion-parallelism update", async () => {
    const updateIngestionParallelism = vi.fn();
    const service = createAdminKnowledgePolicyService({} as PrismaClient, {
      answerPolicyService: { list: vi.fn(), update: vi.fn(), updateIngestionParallelism },
      operationsService: { read: vi.fn() },
      profileService: {
        activate: vi.fn(),
        list: vi.fn(),
        rollback: vi.fn()
      }
    });
    await service.updateIngestionParallelism({
      expectedVersion: 2,
      ingestionParallelism: 6,
      userId: "admin-1"
    });
    expect(updateIngestionParallelism).toHaveBeenCalledWith({
      expectedVersion: 2,
      ingestionParallelism: 6,
      userId: "admin-1"
    });
  });
});
