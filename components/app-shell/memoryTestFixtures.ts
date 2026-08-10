import type {
  MemoryDeletionStatus,
  MemoryEvidenceResponse,
  MemoryListResponse,
  MemorySettingsResponse,
  MemorySummary,
  MemoryUiLocale
} from "@/lib/contracts/memory";

export function memorySettingsFixture(
  overrides: Readonly<{
    capabilities?: Partial<MemorySettingsResponse["capabilities"]>;
    egress?: Partial<MemorySettingsResponse["egress"]>;
    settings?: Partial<MemorySettingsResponse["settings"]>;
  }> = {},
  locale: MemoryUiLocale = "EN"
): MemorySettingsResponse {
  const base: MemorySettingsResponse = {
    capabilities: {
      automaticLearning: true,
      explicitMemory: true,
      historyRecall: true,
      russianQualified: true,
      temporaryChats: true
    },
    egress: {
      acceptedAt: "2026-08-10T08:00:00.000Z",
      acceptedUtilityEgressFingerprint: "accepted-fingerprint-0000000000000001",
      acceptedUtilityPolicyVersion: "memory-policy-v1",
      currentUtilityEgressFingerprint: "accepted-fingerprint-0000000000000001",
      currentUtilityPolicyVersion: "memory-policy-v1",
      embeddingDestination: "Local / multilingual-embed",
      remoteRerankerDestination: null,
      reviewRequired: false,
      systemModelDestination: "Local / memory-extract"
    },
    settings: {
      embeddingDeployment: {
        connectionDisplayName: "Local",
        id: "embedding-model-1",
        modelDisplayName: "multilingual-embed"
      },
      learnAutomatically: false,
      memoryConsentRevision: 4,
      memoryGeneration: 3,
      memoryRevision: 8,
      memoryUiLocale: locale,
      preferredProfileLanguage: "AUTO",
      referenceChatHistory: false,
      sensitiveAutomaticPolicy: "EXPLICIT_ONLY",
      settingsRevision: 12,
      updatedAt: "2026-08-10T08:00:00.000Z",
      useMemoryFacts: false
    }
  };
  return {
    ...base,
    ...overrides,
    capabilities: { ...base.capabilities, ...overrides.capabilities },
    egress: { ...base.egress, ...overrides.egress },
    settings: { ...base.settings, ...overrides.settings }
  };
}

export function memorySummaryFixture(overrides: Partial<MemorySummary> = {}): MemorySummary {
  return {
    category: "preference",
    createdAt: "2026-08-10T08:00:00.000Z",
    currentVersionId: "memory-version-1",
    displayText: "I prefer concise answers in Russian.",
    factState: "ACTIVE",
    id: "memory-fact-1",
    indexingState: "LEXICAL_READY",
    lastConfirmedAt: "2026-08-10T08:00:00.000Z",
    lastUsedAt: null,
    modality: "PREFERENCE",
    pinned: false,
    scope: { type: "GLOBAL_USER" },
    sensitivityClass: "NORMAL",
    sourceCount: 1,
    sourceMode: "EXPLICIT",
    updatedAt: "2026-08-10T08:00:00.000Z",
    validFrom: null,
    validTo: null,
    versionState: "ACTIVE",
    ...overrides
  };
}

export function memoryListFixture(memories = [memorySummaryFixture()]): MemoryListResponse {
  return { memories, nextCursor: null };
}

export function memoryEvidenceFixture(): MemoryEvidenceResponse {
  return {
    evidence: [{
      factVersionId: "memory-version-1",
      id: "memory-evidence-1",
      observedAt: "2026-08-10T08:00:00.000Z",
      safeExcerpt: "I prefer concise answers in Russian.",
      safetyClass: "NORMAL",
      sourceChatId: null,
      sourceMessageId: null,
      sourceRole: null,
      sourceType: "EXPLICIT_ACTION",
      stance: "SUPPORTS"
    }],
    nextCursor: null
  };
}

export function memoryDeletionFixture(
  overrides: Partial<MemoryDeletionStatus> = {}
): MemoryDeletionStatus {
  return {
    completedUnits: 0,
    deletionId: "memory-deletion-1",
    lastAuditAt: null,
    memoryGeneration: 4,
    memoryRevision: 9,
    operation: "DELETE_EXPLICIT",
    settingsRevision: 13,
    state: "PENDING",
    totalUnits: 4,
    updatedAt: "2026-08-10T08:00:00.000Z",
    ...overrides
  };
}
