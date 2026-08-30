import type {
  AdminKnowledgeSettings,
  AdminKnowledgeOperations,
  AdminKnowledgeProfileDestination,
  AdminKnowledgeProfileSettings
} from "@/lib/contracts/adminKnowledge";

export function adminKnowledgeAnswerPolicyFixture(
  overrides: Partial<AdminKnowledgeSettings["answerPolicy"]> = {}
): AdminKnowledgeSettings["answerPolicy"] {
  return {
    fullContextThresholdPercent: 70,
    ingestionParallelism: 8,
    maximum: 32,
    maximumKnowledgeSearches: 12,
    minimum: 1,
    parallelismMaximum: 64,
    parallelismMinimum: 1,
    updatedAt: "2026-08-18T00:00:00.000Z",
    updatedBy: null,
    version: 1,
    ...overrides
  };
}

export function adminKnowledgeOperationsFixture(
  overrides: Partial<AdminKnowledgeOperations> = {}
): AdminKnowledgeOperations {
  return {
    alerts: [],
    checkedAt: "2026-08-18T00:00:00.000Z",
    deletion: {
      blockedJobs: 0,
      oldestPendingSeconds: null,
      pendingJobs: 0,
      pendingObjects: 0
    },
    ingestion: {
      activeUploads: 0,
      expiredUploads: 0,
      failedArtifacts: 0,
      items24h: 0,
      needsAttentionUploads: 0,
      oldestQueuedSeconds: null,
      p50ReadyLatencyMs24h: null,
      p95ReadyLatencyMs24h: null,
      pendingArtifacts: 0,
      processingArtifacts: 0,
      readyArtifacts: 0,
      settledUploads24h: 0,
      uploadedBytes24h: 0,
      warningArtifacts: 0
    },
    migration: {
      discrepancies: 0,
      mappedArtifacts: 0,
      mappedDocuments: 0,
      mappedVersions: 0,
      v1Artifacts: 0,
      v1Documents: 0,
      v1Versions: 0
    },
    retrieval: {
      degradedOperations24h: 0,
      noAnswerOperations24h: 0,
      operations24h: 0,
      p50DurationMs24h: null,
      p95DurationMs24h: null
    },
    ...overrides
  };
}

export const adminKnowledgeDestinationFixture: AdminKnowledgeProfileDestination = {
  connectionDisplayName: "Local embeddings",
  deploymentId: "embedding-model-1",
  modelDisplayName: "Multilingual embed",
  provider: "openai_compatible",
  targetDimension: 1024
};

export function adminKnowledgeProfileFixture(
  overrides: Partial<AdminKnowledgeProfileSettings> = {}
): AdminKnowledgeProfileSettings {
  const activeRevision = {
    activatedAt: "2026-08-18T00:00:00.000Z",
    destination: adminKnowledgeDestinationFixture,
    executionAuthority: "installation" as const,
    id: "profile-revision-1",
    pdfProcessing: {
      destination: null,
      mode: "local" as const,
      parserProfileVersion: 1
    },
    revisionNumber: 1
  };
  return {
    activeRevision,
    availableDestinations: [adminKnowledgeDestinationFixture],
    egress: {
      embeddingDestination: "Local embeddings / Multilingual embed",
      pdfDestination: null,
      representations: ["document_text_chunks", "search_queries"]
    },
    health: { checkedAt: "2026-08-18T00:00:00.000Z", code: null, state: "ready" },
    migration: {
      activeProfileBases: 1,
      buildingProfileBases: 0,
      legacyGenerations: 0,
      profiledGenerations: 1,
      totalBases: 1
    },
    pdfProcessingOptions: [
      { available: true, mode: "local", representation: "local_only" },
      {
        available: false,
        mode: "system_model_direct_pdf",
        representation: "original_pdf_page_ranges"
      },
      {
        available: false,
        mode: "system_model_vision",
        representation: "rendered_pdf_page_images"
      }
    ],
    recentRevisions: [activeRevision],
    systemModelDestination: null,
    updatedAt: "2026-08-18T00:00:00.000Z",
    updatedBy: null,
    version: 1,
    ...overrides
  };
}
