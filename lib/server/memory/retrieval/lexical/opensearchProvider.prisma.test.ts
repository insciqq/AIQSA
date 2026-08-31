import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../../prisma";
import {
  MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
  MEMORY_OPENSEARCH_BACKEND_KIND,
  MEMORY_OPENSEARCH_MAPPING_VERSION,
  MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
  MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
  memoryOpenSearchConfigurationFromEnv,
  memoryOpenSearchProjectionFingerprint
} from "../../../search/opensearch/memoryContract";
import type { MemoryLexicalSearchRequest } from "./contract";
import { readMemoryOpenSearchProjectionReadiness } from
  "./opensearchProvider";

const env: NodeJS.ProcessEnv = {
  AIQSA_MEMORY_OPENSEARCH_INDEX_BUILD_ID: "shadow-readiness-test",
  AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY:
    "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=",
  AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY_ID: "shadow-readiness-test-v1",
  NODE_ENV: "test"
};

afterAll(async () => {
  await prisma.$disconnect();
});

function request(input: Readonly<{
  generationId: string;
  memoryRevisionSnapshot: number;
  userId: string;
}>): MemoryLexicalSearchRequest {
  return {
    activeGenerationId: input.generationId,
    analysisProfileVersion: "UNICODE_ICU_NGRAM_V1",
    candidateLimitPerVariant: 24,
    deadlineAtMs: Date.now() + 1_000,
    finalLimit: 12,
    itemFamily: "FACT",
    memoryRevisionSnapshot: input.memoryRevisionSnapshot,
    userId: input.userId,
    variants: [{
      logicalTerms: [{ characterLength: 5, ordinal: 0, value: "cedar" }],
      normalizedText: "cedar",
      ordinal: 0
    }]
  };
}

describe("OpenSearch Memory projection readiness fence", () => {
  it("admits only the exact active revision and content fingerprint", async () => {
    const userId = randomUUID();
    const generationId = randomUUID();
    const now = new Date();
    const emptyFingerprint = createHash("sha256").digest("hex");
    const projectionFingerprint = memoryOpenSearchProjectionFingerprint(
      memoryOpenSearchConfigurationFromEnv(env)
    );
    try {
      await prisma.user.create({
        data: {
          displayName: "Memory shadow readiness fixture",
          id: userId,
          status: "active"
        }
      });
      await prisma.userMemorySettings.update({
        data: { memoryRevision: 7 },
        where: { userId }
      });
      await prisma.memoryIndexGeneration.create({
        data: {
          chunkingVersion: "memory-shadow-readiness-chunking-v1",
          generation: 1,
          id: generationId,
          indexMode: "LEXICAL_ONLY",
          indexedThroughMemoryRevision: 7,
          languageProfile: "UNICODE_ICU_NGRAM_V1",
          normalizationVersion: MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
          readyAt: now,
          retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
          state: "READY",
          targetMemoryRevision: 7,
          userId
        }
      });
      await prisma.$transaction(async (tx) => {
        await tx.userMemorySettings.update({
          data: { activeIndexGenerationId: generationId },
          where: { userId }
        });
        await tx.memoryIndexGeneration.update({
          data: { activatedAt: now, state: "ACTIVE" },
          where: { id: generationId }
        });
      });
      await prisma.memoryLexicalProjectionState.create({
        data: {
          analysisProfile: MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
          backendKind: MEMORY_OPENSEARCH_BACKEND_KIND,
          enqueuedThroughSequence: 0,
          expectedContentFingerprint: emptyFingerprint,
          expectedDocumentCount: 0,
          indexGenerationId: generationId,
          lastIntegrityCheckAt: now,
          lastSuccessfulRefreshAt: now,
          mappingVersion: MEMORY_OPENSEARCH_MAPPING_VERSION,
          normalizationVersion: MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
          projectedThroughRevision: 7,
          projectionFingerprint,
          readyAt: now,
          retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
          status: "READY",
          targetMemoryRevision: 7,
          userId,
          visibleContentFingerprint: emptyFingerprint,
          visibleDocumentCount: 0,
          visibleThroughSequence: 0
        }
      });

      await expect(readMemoryOpenSearchProjectionReadiness(
        prisma,
        request({ generationId, memoryRevisionSnapshot: 7, userId }),
        env
      )).resolves.toMatchObject({
        caughtUp: true,
        eventLag: 0,
        revisionLag: 0
      });
      await expect(readMemoryOpenSearchProjectionReadiness(
        prisma,
        request({ generationId, memoryRevisionSnapshot: 8, userId }),
        env
      )).resolves.toMatchObject({
        caughtUp: false,
        eventLag: 0,
        revisionLag: 1
      });
      await prisma.$transaction([
        prisma.userMemorySettings.update({
          data: { memoryRevision: 8 },
          where: { userId }
        }),
        prisma.memoryIndexGeneration.update({
          data: { indexedThroughMemoryRevision: 8 },
          where: { id: generationId }
        }),
        prisma.memoryLexicalProjectionState.update({
          data: {
            projectedThroughRevision: 8,
            targetMemoryRevision: 8
          },
          where: { userId_indexGenerationId: { indexGenerationId: generationId, userId } }
        })
      ]);
      await expect(readMemoryOpenSearchProjectionReadiness(
        prisma,
        request({ generationId, memoryRevisionSnapshot: 8, userId }),
        env
      )).resolves.toMatchObject({
        caughtUp: true,
        eventLag: 0,
        revisionLag: 0
      });
      await prisma.memoryLexicalProjectionState.update({
        data: { projectionFingerprint: "f".repeat(64) },
        where: { userId_indexGenerationId: { indexGenerationId: generationId, userId } }
      });
      await expect(readMemoryOpenSearchProjectionReadiness(
        prisma,
        request({ generationId, memoryRevisionSnapshot: 8, userId }),
        env
      )).resolves.toMatchObject({ caughtUp: false });
    } finally {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
        await tx.memoryLexicalProjectionState.deleteMany({ where: { userId } });
        await tx.memoryLexicalProjectionEvent.deleteMany({ where: { userId } });
        await tx.userMemorySettings.updateMany({
          data: { activeIndexGenerationId: null },
          where: { userId }
        });
        await tx.memoryIndexGeneration.deleteMany({ where: { userId } });
        await tx.user.deleteMany({ where: { id: userId } });
      });
    }
  });
});
