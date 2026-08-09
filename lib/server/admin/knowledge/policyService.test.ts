import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  AdminKnowledgePolicyServiceError,
  createAdminKnowledgePolicyService
} from "./policyService";

const NOW = new Date("2026-08-09T00:00:00.000Z");

describe("administrator Knowledge policy service", () => {
  it("projects only global policy and effective ingestion limits", async () => {
    const prisma = {
      knowledgePolicy: {
        findUnique: vi.fn().mockResolvedValue({
          candidateLimit: 40,
          resultLimit: 8,
          scoreThreshold: 0.01,
          updatedAt: NOW,
          updatedBy: { displayName: "Administrator", id: "admin-1" },
          version: 3
        })
      }
    } as unknown as PrismaClient;

    await expect(createAdminKnowledgePolicyService(prisma, {
      extractionConfig: () => ({
        maxChunksPerDocument: 300,
        maxFileBytes: 4_000,
        maxNormalizedChars: 2_000,
        maxNormalizedObjectBytes: 9_000,
        maxPages: 20
      })
    }).list()).resolves.toMatchObject({
      ingestionLimits: {
        maxChunksPerDocument: 300,
        maxFileBytes: 4_000,
        maxNormalizedChars: 2_000,
        maxPages: 20
      },
      policy: {
        candidateLimit: 40,
        resultLimit: 8,
        scoreThreshold: 0.01,
        version: 3
      }
    });
  });

  it("uses one optimistic update and reports stale versions", async () => {
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const prisma = { knowledgePolicy: { updateMany } } as unknown as PrismaClient;
    const service = createAdminKnowledgePolicyService(prisma);
    const update = {
      candidateLimit: 20,
      expectedVersion: 4,
      resultLimit: 5,
      scoreThreshold: 0.1,
      userId: "admin-1"
    };

    await expect(service.update(update)).resolves.toBeUndefined();
    expect(updateMany).toHaveBeenCalledWith({
      data: {
        candidateLimit: 20,
        resultLimit: 5,
        scoreThreshold: 0.1,
        updatedByUserId: "admin-1",
        version: { increment: 1 }
      },
      where: { id: "installation", version: 4 }
    });
    await expect(service.update(update)).rejects.toEqual(
      new AdminKnowledgePolicyServiceError("knowledge_policy_stale")
    );
  });
});
