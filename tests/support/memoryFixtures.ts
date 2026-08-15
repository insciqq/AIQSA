// Shared deterministic fixtures for unit, component, and end-to-end tests.
import type {
  MemoryDeletionStatus,
  MemoryDetailResponse,
  MemoryEvidenceResponse,
  MemoryListResponse,
  MemoryRebuildStatus,
  MemorySettingsResponse,
  MemorySummary
} from "@/lib/contracts/memory";
import type { UserMemoryHealth } from "@/lib/contracts/memoryHealth";

export function memoryHealthFixture(
  overrides: Partial<Omit<
    UserMemoryHealth,
    "deletion" | "indexing" | "learning" | "rebuild" | "temporary"
  >> & Readonly<{
    deletion?: Partial<UserMemoryHealth["deletion"]>;
    indexing?: Partial<UserMemoryHealth["indexing"]>;
    learning?: Partial<UserMemoryHealth["learning"]>;
    rebuild?: Partial<UserMemoryHealth["rebuild"]>;
    temporary?: Partial<UserMemoryHealth["temporary"]>;
  }> = {}
): UserMemoryHealth {
  const base: UserMemoryHealth = {
    action: "NONE",
    deletion: {
      activeCount: 0,
      countTruncated: false,
      retrievalFenced: false,
      state: "CLEAR"
    },
    egressReview: "NONE",
    indexing: {
      completedChats: 0,
      countTruncated: false,
      state: "DISABLED",
      totalChats: 0
    },
    learning: { reason: "USER_DISABLED", state: "DISABLED" },
    observedAt: "2026-08-12T10:00:00.000Z",
    rebuild: { state: "IDLE" },
    state: "UP_TO_DATE",
    temporary: { countTruncated: false, overdueCount: 0, state: "CLEAR" }
  };
  return {
    ...base,
    ...overrides,
    deletion: { ...base.deletion, ...overrides.deletion },
    indexing: { ...base.indexing, ...overrides.indexing },
    learning: { ...base.learning, ...overrides.learning },
    rebuild: { ...base.rebuild, ...overrides.rebuild },
    temporary: { ...base.temporary, ...overrides.temporary }
  };
}

export function memorySettingsFixture(
  overrides: Readonly<{
    capabilities?: Partial<MemorySettingsResponse["capabilities"]>;
    egress?: Partial<MemorySettingsResponse["egress"]>;
    historyIndexing?: Partial<MemorySettingsResponse["historyIndexing"]>;
    settings?: Partial<MemorySettingsResponse["settings"]>;
  }> = {}
): MemorySettingsResponse {
  const base: MemorySettingsResponse = {
    capabilities: {
      automaticLearning: true,
      explicitMemory: true,
      historyRecall: true,
      permanentChatDeletion: false,
      temporaryChats: true
    },
    egress: {
      acceptedAt: "2026-08-10T08:00:00.000Z",
      acceptedUtilityEgressFingerprint: "accepted-fingerprint-0000000000000001",
      acceptedUtilityPolicyVersion: "memory-policy-v1",
      consentMode: "ADMIN",
      currentUtilityEgressFingerprint: "accepted-fingerprint-0000000000000001",
      currentUtilityPolicyVersion: "memory-policy-v1",
      embeddingDestination: "Local / multilingual-embed",
      remoteRerankerDestination: null,
      reviewRequired: false,
      systemModelDestination: "Local / memory-extract"
    },
    historyIndexing: {
      completedChats: 0,
      state: "DISABLED",
      totalChats: 0
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
      referenceChatHistory: false,
      sensitiveAutomaticPolicy: "EXPLICIT_ONLY",
      settingsRevision: 12,
      updatedAt: "2026-08-10T08:00:00.000Z",
      useMemoryFacts: false
    }
  };
  const settings = { ...base.settings, ...overrides.settings };
  const defaultHistoryIndexing: MemorySettingsResponse["historyIndexing"] = {
    completedChats: 0,
    state: settings.referenceChatHistory ? "READY" : "DISABLED",
    totalChats: 0
  };
  return {
    ...base,
    ...overrides,
    capabilities: { ...base.capabilities, ...overrides.capabilities },
    egress: { ...base.egress, ...overrides.egress },
    historyIndexing: { ...defaultHistoryIndexing, ...overrides.historyIndexing },
    settings
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

export function memoryDetailFixture(
  memory = memorySummaryFixture()
): MemoryDetailResponse {
  const versionId = memory.currentVersionId ?? memory.actionVersionId ?? null;
  return {
    feedback: [],
    history: [],
    memory,
    versions: versionId ? [{
      category: memory.category,
      createdAt: memory.createdAt,
      displayText: memory.displayText,
      id: versionId,
      modality: memory.modality,
      sensitivityClass: memory.sensitivityClass,
      sourceCount: memory.sourceCount,
      sourceMode: memory.sourceMode,
      state: memory.versionState,
      systemFrom: memory.updatedAt,
      systemTo: null,
      validFrom: memory.validFrom,
      validTo: memory.validTo
    }] : []
  };
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

export function memoryRebuildFixture(
  overrides: Partial<MemoryRebuildStatus> = {}
): MemoryRebuildStatus {
  return {
    completedUnits: 0,
    createdAt: "2026-08-10T08:00:00.000Z",
    errorCode: null,
    jobId: "memory-rebuild-1",
    operation: "REBUILD_SEARCH_INDEX",
    state: "QUEUED",
    totalUnits: null,
    updatedAt: "2026-08-10T08:00:00.000Z",
    ...overrides
  };
}
