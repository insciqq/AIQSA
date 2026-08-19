import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createAdminKnowledgeOperationsService } from "./operationsService";

const NOW = new Date("2026-08-19T00:00:00.000Z");

function reconciliation(overrides: Record<string, bigint> = {}) {
  return {
    invalidArtifactMappings: 0n,
    invalidDocumentMappings: 0n,
    invalidVersionMappings: 0n,
    mappedDocuments: 2n,
    mappedGenerationCandidates: 2n,
    mappedVersions: 2n,
    memberships: 2n,
    snapshots: 1n,
    sources: 2n,
    v1Documents: 2n,
    v1GenerationCandidates: 2n,
    v1Versions: 2n,
    ...overrides
  };
}

describe("administrator Knowledge operations service", () => {
  it("projects content-free health metrics and stable alerts", async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{
        activeUploads: 3,
        blockedDeletionJobs: 1,
        checkedAt: NOW,
        degradedOperations24h: 5,
        expiredUploads: 2,
        failedArtifacts: 4,
        items24h: 14,
        needsAttentionUploads: 1,
        noAnswerOperations24h: 3,
        oldestDeletionSeconds: 90,
        oldestQueuedSeconds: 4_000,
        p50ReadyLatencyMs24h: 1_200.4,
        p50RetrievalDurationMs24h: 40.4,
        p95ReadyLatencyMs24h: 8_200.6,
        p95RetrievalDurationMs24h: 400.6,
        pendingArtifacts: 2,
        pendingDeletionJobs: 2,
        pendingDeletionObjects: 3,
        processingArtifacts: 1,
        readyArtifacts: 20,
        repairedAnswers24h: 2,
        retrievalOperations24h: 20,
        settledUploads24h: 12,
        uploadedBytes24h: 2_048n,
        warningArtifacts: 6
      }])
      .mockResolvedValueOnce([reconciliation({ mappedDocuments: 1n })]);
    const client = { $queryRaw: queryRaw } as unknown as PrismaClient;

    const result = await createAdminKnowledgeOperationsService(client).read();

    expect(result).toMatchObject({
      alerts: [
        { code: "knowledge_deletion_blocked", severity: "critical" },
        { code: "knowledge_ingestion_queue_stalled", severity: "critical" },
        { code: "knowledge_v1_reconciliation_incomplete", severity: "critical" },
        { code: "knowledge_deletion_backlog", severity: "warning" },
        { code: "knowledge_ingestion_failures", severity: "warning" },
        { code: "knowledge_retrieval_degraded", severity: "warning" },
        { code: "knowledge_upload_sessions_expired", severity: "warning" }
      ],
      checkedAt: NOW.toISOString(),
      deletion: { blockedJobs: 1, pendingJobs: 2, pendingObjects: 3 },
      ingestion: {
        p50ReadyLatencyMs24h: 1_200,
        p95ReadyLatencyMs24h: 8_201,
        uploadedBytes24h: 2_048
      },
      migration: { discrepancies: 1, mappedDocuments: 1, v1Documents: 2 },
      retrieval: {
        degradedOperations24h: 5,
        operations24h: 20,
        p95DurationMs24h: 401
      }
    });
    expect(JSON.stringify(result)).not.toMatch(/filename|passage|query|excerpt|storageKey/iu);
  });

  it("keeps a quiet empty installation healthy", async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{
        activeUploads: 0,
        blockedDeletionJobs: 0,
        checkedAt: NOW,
        degradedOperations24h: 0,
        expiredUploads: 0,
        failedArtifacts: 0,
        items24h: 0,
        needsAttentionUploads: 0,
        noAnswerOperations24h: 0,
        oldestDeletionSeconds: null,
        oldestQueuedSeconds: null,
        p50ReadyLatencyMs24h: null,
        p50RetrievalDurationMs24h: null,
        p95ReadyLatencyMs24h: null,
        p95RetrievalDurationMs24h: null,
        pendingArtifacts: 0,
        pendingDeletionJobs: 0,
        pendingDeletionObjects: 0,
        processingArtifacts: 0,
        readyArtifacts: 0,
        repairedAnswers24h: 0,
        retrievalOperations24h: 0,
        settledUploads24h: 0,
        uploadedBytes24h: 0n,
        warningArtifacts: 0
      }])
      .mockResolvedValueOnce([reconciliation({
        mappedDocuments: 0n,
        mappedGenerationCandidates: 0n,
        mappedVersions: 0n,
        memberships: 0n,
        snapshots: 0n,
        sources: 0n,
        v1Documents: 0n,
        v1GenerationCandidates: 0n,
        v1Versions: 0n
      })]);
    const client = { $queryRaw: queryRaw } as unknown as PrismaClient;

    await expect(createAdminKnowledgeOperationsService(client).read()).resolves.toMatchObject({
      alerts: [],
      migration: { discrepancies: 0 }
    });
  });
});
