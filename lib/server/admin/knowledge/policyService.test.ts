import type { PrismaClient } from "@prisma/client";
import {
  adminKnowledgeOperationsFixture,
  adminKnowledgeProfileFixture
} from "@/tests/support/knowledgeProfile";
import { describe, expect, it, vi } from "vitest";
import { createAdminKnowledgePolicyService } from "./policyService";

describe("administrator Knowledge settings service", () => {
  it("projects fixed retrieval facts without reading mutable policy state", async () => {
    const prisma = {} as PrismaClient;
    const settings = await createAdminKnowledgePolicyService(prisma, {
      extractionConfig: () => ({
        maxChunksPerDocument: 300,
        maxFileBytes: 4_000,
        maxNormalizedChars: 2_000,
        maxNormalizedObjectBytes: 9_000,
        maxPages: 20
      }),
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
      ingestionLimits: {
        maxChunksPerDocument: 300,
        maxFileBytes: 4_000,
        maxNormalizedChars: 2_000,
        maxPages: 20
      },
      operations: { alerts: [], migration: { discrepancies: 0 } },
      retrieval: {
        candidateLimit: 40,
        resultLimit: 8
      }
    });
    expect(settings).not.toHaveProperty("policy");
    expect(settings).not.toHaveProperty("retrievalBounds");
  });
});
