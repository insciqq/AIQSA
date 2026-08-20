import type {
  AdminKnowledgeOperations,
  AdminKnowledgeProfileDestination,
  AdminKnowledgeProfileSettings,
  AdminKnowledgeVisionDestination
} from "@/lib/contracts/adminKnowledge";

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
      p95DurationMs24h: null,
      repairedAnswers24h: 0
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

export const adminKnowledgeVisionDestinationFixture: AdminKnowledgeVisionDestination = {
  connectionDisplayName: "Vision provider",
  deploymentId: "vision-model-1",
  modelDisplayName: "Document vision",
  provider: "openai",
  supportsNativePdf: true
};

export function adminKnowledgeProfileFixture(
  overrides: Partial<AdminKnowledgeProfileSettings> = {}
): AdminKnowledgeProfileSettings {
  const activeRevision = {
    activatedAt: "2026-08-18T00:00:00.000Z",
    destination: adminKnowledgeDestinationFixture,
    executionAuthority: "installation" as const,
    id: "profile-revision-1",
    revisionNumber: 1,
    visionDestination: null
  };
  return {
    activeRevision,
    availableDestinations: [adminKnowledgeDestinationFixture],
    availableVisionDestinations: [],
    egress: {
      destination: "Local embeddings / Multilingual embed",
      policyVersion: "knowledge-profile-egress-v3",
      representations: ["document_text_chunks", "search_queries"],
      roles: [
        { mode: "external", operation: "embeddings" },
        { mode: "disabled", operation: "vision_analysis" },
        { mode: "disabled", operation: "query_planning" },
        { mode: "local", operation: "reranking" },
        { mode: "local", operation: "grounding_validation" },
        { mode: "local", operation: "citation_repair" },
        { mode: "disabled", operation: "answer_citation_retry" }
      ],
      visualAnalysis: null
    },
    health: { checkedAt: "2026-08-18T00:00:00.000Z", code: null, state: "ready" },
    migration: {
      activeProfileBases: 1,
      buildingProfileBases: 0,
      legacyGenerations: 0,
      profiledGenerations: 1,
      totalBases: 1
    },
    recentRevisions: [activeRevision],
    updatedAt: "2026-08-18T00:00:00.000Z",
    updatedBy: null,
    version: 1,
    ...overrides
  };
}
