import { describe, expect, it } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  MEMORY_ERROR_CODES,
  MEMORY_PAGE_SIZE_MAX,
  MEMORY_TEMPORARY_RETENTION_POLICY_VERSION,
  decodeMemoryBulkDeleteInput,
  decodeMemoryChatModePatch,
  decodeMemoryChatModeResponse,
  decodeMemoryConsentInput,
  decodeMemoryCreateInput,
  decodeMemoryDeletionStatus,
  decodeMemoryEvidenceResponse,
  decodeMemoryErrorResponse,
  decodeMemoryHistorySearchInput,
  decodeMemoryHistorySearchResponse,
  decodeMemoryInitialChatMode,
  decodeMemoryListInput,
  decodeMemoryListResponse,
  decodeMemoryListSearchInput,
  decodeMemoryMutationAuthorizationInput,
  decodeMemoryMutationAuthorizationResponse,
  decodeMemoryMutationResponse,
  decodeMemoryReceipt,
  decodeMemoryActionFeedback,
  decodeMemoryRebuildInput,
  decodeMemoryRebuildStatus,
  decodeMemoryScopeSelection,
  decodeMemorySettingsPatch,
  decodeMemorySettingsMutation,
  decodeMemorySettingsResponse,
  decodeMemoryUpdateInput
} from "./memory";

const now = "2026-08-09T12:00:00.000Z";

function memorySummary() {
  return {
    category: "preference",
    createdAt: now,
    currentVersionId: "version-1",
    displayText: "Я предпочитаю ответы на русском языке.",
    factState: "ACTIVE",
    id: "memory-1",
    indexingState: "LEXICAL_READY",
    lastConfirmedAt: now,
    lastUsedAt: null,
    modality: "PREFERENCE",
    pinned: true,
    scope: { type: "GLOBAL_USER" },
    sensitivityClass: "NORMAL",
    sourceCount: 1,
    sourceMode: "EXPLICIT",
    updatedAt: now,
    validFrom: null,
    validTo: null,
    versionState: "ACTIVE"
  };
}

function settingsResponse() {
  return {
    capabilities: {
      automaticLearning: true,
      explicitMemory: true,
      historyRecall: true,
      russianQualified: true
    },
    egress: {
      acceptedAt: now,
      acceptedUtilityEgressFingerprint: "accepted-fingerprint-1234",
      acceptedUtilityPolicyVersion: "memory-egress-v1",
      currentUtilityEgressFingerprint: "accepted-fingerprint-1234",
      currentUtilityPolicyVersion: "memory-egress-v1",
      embeddingDestination: "Embedding deployment",
      remoteRerankerDestination: null,
      reviewRequired: false,
      systemModelDestination: "System model"
    },
    settings: {
      embeddingDeployment: {
        connectionDisplayName: "Provider",
        id: "embedding-1",
        modelDisplayName: "Multilingual embedding"
      },
      learnAutomatically: false,
      memoryConsentRevision: 3,
      memoryGeneration: 7,
      memoryRevision: 42,
      memoryUiLocale: "RU",
      preferredProfileLanguage: "AUTO",
      referenceChatHistory: true,
      sensitiveAutomaticPolicy: "EXPLICIT_ONLY",
      settingsRevision: 12,
      updatedAt: now,
      useMemoryFacts: true
    }
  };
}

describe("Memory request contracts", () => {
  it("decodes only the four exact scope target shapes", () => {
    expect(decodeMemoryScopeSelection({ type: "GLOBAL_USER" })).toEqual({
      ok: true,
      value: { type: "GLOBAL_USER" }
    });
    expect(decodeMemoryScopeSelection({ targetId: "folder-1", type: "FOLDER" })).toMatchObject({
      ok: true
    });
    for (const unsafe of [
      { targetId: "folder-1", type: "GLOBAL_USER" },
      { type: "FOLDER" },
      { targetId: "folder-1", type: "UNKNOWN" },
      { targetId: "folder-1", type: "FOLDER", userId: "other-user" }
    ]) {
      expect(decodeMemoryScopeSelection(unsafe)).toEqual({
        code: "memory_contract_invalid",
        ok: false
      });
    }
  });

  it("requires optimistic revisions for every memory-visible settings patch", () => {
    expect(decodeMemorySettingsPatch({
      expectedMemoryRevision: 42,
      expectedSettingsRevision: 12,
      useMemoryFacts: true
    })).toMatchObject({ ok: true });
    expect(decodeMemorySettingsPatch({
      expectedSettingsRevision: 12,
      memoryUiLocale: "EN"
    })).toMatchObject({ ok: true });

    for (const invalid of [
      { expectedSettingsRevision: 12 },
      { expectedSettingsRevision: 12, useMemoryFacts: true },
      { expectedMemoryRevision: 42, expectedSettingsRevision: 12, memoryUiLocale: "EN" },
      { expectedMemoryRevision: 42, expectedSettingsRevision: 12, useMemoryFacts: true, userId: "other" }
    ]) {
      expect(decodeMemorySettingsPatch(invalid)).toMatchObject({ ok: false });
    }
  });

  it("binds consent and mutation authority to current copy and exact targets", () => {
    expect(decodeMemoryConsentInput({
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      currentUtilityEgressFingerprint: "current-fingerprint-1234",
      currentUtilityPolicyVersion: "memory-egress-v1",
      expectedMemoryConsentRevision: 3,
      expectedMemoryRevision: 42,
      expectedSettingsRevision: 12
    })).toMatchObject({ ok: true });
    expect(decodeMemoryConsentInput({
      confirmationCopyVersion: "stale-copy",
      currentUtilityEgressFingerprint: "current-fingerprint-1234",
      currentUtilityPolicyVersion: "memory-egress-v1",
      expectedMemoryConsentRevision: 3,
      expectedMemoryRevision: 42,
      expectedSettingsRevision: 12
    })).toMatchObject({ ok: false });
    expect(decodeMemorySettingsMutation({
      expectedMemoryRevision: 42,
      expectedSettingsRevision: 12,
      useMemoryFacts: true
    })).toEqual({
      ok: true,
      value: {
        kind: "patch",
        value: {
          expectedMemoryRevision: 42,
          expectedSettingsRevision: 12,
          useMemoryFacts: true
        }
      }
    });
    expect(decodeMemorySettingsMutation({
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      currentUtilityEgressFingerprint: "current-fingerprint-1234",
      currentUtilityPolicyVersion: "memory-egress-v1",
      expectedMemoryConsentRevision: 3,
      expectedMemoryRevision: 42,
      expectedSettingsRevision: 12
    })).toMatchObject({
      ok: true,
      value: { kind: "accept_utility_egress" }
    });
    expect(decodeMemorySettingsMutation({
      expectedSettingsRevision: 12,
      unknown: true
    })).toMatchObject({ ok: false });

    expect(decodeMemoryMutationAuthorizationInput({
      action: "SAVE",
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      exactStatementHash: "a".repeat(64),
      requestNonce: "nonce-1"
    })).toMatchObject({ ok: true });
    expect(decodeMemoryMutationAuthorizationInput({
      action: "BULK_DELETE",
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      expectedMemoryRevision: 42,
      expectedSettingsRevision: 12,
      operation: "DELETE_EXPLICIT",
      requestNonce: "nonce-bulk-1"
    })).toMatchObject({ ok: true });
    expect(decodeMemoryMutationAuthorizationInput({
      action: "BULK_DELETE",
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      operation: "DELETE_EXPLICIT",
      requestNonce: "nonce-bulk-missing-revisions"
    })).toMatchObject({ ok: false });
    expect(decodeMemoryMutationAuthorizationInput({
      action: "FORGET",
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      expectedTargetVersionId: "version-1",
      requestNonce: "nonce-2",
      targetFactId: "fact-1"
    })).toMatchObject({ ok: true });
    expect(decodeMemoryMutationAuthorizationInput({
      action: "FORGET",
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      requestNonce: "nonce-2",
      targetFactId: "fact-1"
    })).toMatchObject({ ok: false });
    expect(decodeMemoryMutationAuthorizationResponse({
      expiresAt: now,
      mutationAuthorizationId: "authorization-1"
    })).toMatchObject({ ok: true });
  });

  it("decodes bounded create, update, list search, and bulk deletion inputs", () => {
    expect(decodeMemoryCreateInput({
      category: "preference",
      modality: "PREFERENCE",
      mutationAuthorizationId: "authorization-1",
      scope: { type: "GLOBAL_USER" },
      statement: "  Я предпочитаю русский язык.  ",
      validFrom: null,
      validTo: null
    })).toEqual({
      ok: true,
      value: {
        category: "preference",
        modality: "PREFERENCE",
        mutationAuthorizationId: "authorization-1",
        scope: { type: "GLOBAL_USER" },
        statement: "  Я предпочитаю русский язык.  ",
        validFrom: null,
        validTo: null
      }
    });
    expect(decodeMemoryCreateInput({
      mutationAuthorizationId: "authorization-1",
      scope: { type: "GLOBAL_USER" },
      statement: "Plan",
      validFrom: "2026-08-10T00:00:00.000Z",
      validTo: "2026-08-09T00:00:00.000Z"
    })).toMatchObject({ ok: false });

    expect(decodeMemoryUpdateInput({
      expectedVersionId: "version-1",
      mutationAuthorizationId: "authorization-2",
      pinned: false
    })).toMatchObject({ ok: true });
    expect(decodeMemoryUpdateInput({
      expectedVersionId: "version-1",
      mutationAuthorizationId: "authorization-2"
    })).toMatchObject({ ok: false });

    expect(decodeMemoryListSearchInput({
      cursor: null,
      pageSize: MEMORY_PAGE_SIZE_MAX,
      query: "что я предпочитаю",
      state: "ACTIVE"
    })).toMatchObject({ ok: true });
    expect(decodeMemoryListSearchInput({
      pageSize: MEMORY_PAGE_SIZE_MAX + 1,
      query: "query"
    })).toMatchObject({ ok: false });
    expect(decodeMemoryListInput({
      cursor: null,
      pageSize: 20,
      scope: { type: "GLOBAL_USER" },
      sourceMode: "EXPLICIT",
      state: "ACTIVE"
    })).toMatchObject({ ok: true });
    expect(decodeMemoryListInput({ query: "private text" })).toMatchObject({ ok: false });

    expect(decodeMemoryBulkDeleteInput({
      expectedMemoryRevision: 42,
      expectedSettingsRevision: 12,
      mutationAuthorizationId: "authorization-3",
      operation: "DELETE_ALL_REUSABLE"
    })).toMatchObject({ ok: true });
    expect(decodeMemoryBulkDeleteInput({
      expectedMemoryRevision: 42,
      expectedSettingsRevision: 12,
      mutationAuthorizationId: "authorization-3",
      operation: "DELETE_EVERYTHING"
    })).toMatchObject({ ok: false });
  });

  it("bounds private history search and rejects target or time ambiguity", () => {
    expect(decodeMemoryHistorySearchInput({
      chatIds: ["chat-1", "chat-2"],
      cursor: null,
      folderId: null,
      from: null,
      pageSize: 20,
      query: "где обсуждали pgvector",
      to: null
    })).toMatchObject({ ok: true });
    expect(decodeMemoryHistorySearchInput({
      chatIds: ["chat-1", "chat-1"],
      cursor: null,
      folderId: null,
      from: null,
      pageSize: 20,
      query: "query",
      to: null
    })).toMatchObject({ ok: false });
  });

  it("requires explicit, operation-specific rebuild evidence", () => {
    expect(decodeMemoryRebuildInput({
      embeddingDeploymentId: "embedding-1",
      expectedMemoryRevision: 42,
      expectedSettingsRevision: 12,
      operation: "REEMBED"
    })).toMatchObject({ ok: true });
    expect(decodeMemoryRebuildInput({
      expectedMemoryRevision: 42,
      expectedSettingsRevision: 12,
      operation: "REEMBED"
    })).toMatchObject({ ok: false });
    expect(decodeMemoryRebuildInput({
      expectedMemoryRevision: 42,
      expectedSettingsRevision: 12,
      operation: "REDREAM_EXISTING_CHATS"
    })).toMatchObject({ ok: false });
  });

  it("keeps Temporary immutable and Archive outside memory-mode PATCH", () => {
    expect(decodeMemoryChatModePatch({
      expectedChatRevision: 5,
      expectedMemoryRevision: 42,
      mode: "EXCLUDED"
    })).toMatchObject({ ok: true });
    expect(decodeMemoryChatModePatch({
      expectedChatRevision: 6,
      expectedMemoryRevision: 43,
      mode: "NORMAL",
      resumeDisclosureCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION
    })).toMatchObject({ ok: true });
    expect(decodeMemoryChatModePatch({
      expectedChatRevision: 6,
      expectedMemoryRevision: 43,
      mode: "TEMPORARY"
    })).toMatchObject({ ok: false });

    expect(decodeMemoryInitialChatMode({ chatMode: "NORMAL" })).toMatchObject({ ok: true });
    expect(decodeMemoryInitialChatMode({
      chatMode: "TEMPORARY",
      temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION
    })).toMatchObject({ ok: true });
    expect(decodeMemoryInitialChatMode({
      chatMode: "TEMPORARY",
      temporaryRetentionPolicyVersion: "temporary-later"
    })).toMatchObject({ ok: false });
  });
});

describe("Memory response contracts", () => {
  it("decodes settings only when egress acceptance is internally consistent", () => {
    expect(decodeMemorySettingsResponse(settingsResponse())).toMatchObject({ ok: true });
    expect(decodeMemorySettingsResponse({
      ...settingsResponse(),
      egress: {
        ...settingsResponse().egress,
        acceptedAt: null
      }
    })).toMatchObject({ ok: false });
    expect(decodeMemorySettingsResponse({
      ...settingsResponse(),
      egress: {
        ...settingsResponse().egress,
        currentUtilityEgressFingerprint: "changed-fingerprint-1234",
        reviewRequired: false
      }
    })).toMatchObject({ ok: false });
    expect(decodeMemorySettingsResponse({
      ...settingsResponse(),
      egress: {
        ...settingsResponse().egress,
        currentUtilityPolicyVersion: "memory-egress-v2",
        reviewRequired: false
      }
    })).toMatchObject({ ok: false });
    expect(decodeMemorySettingsResponse({
      ...settingsResponse(),
      egress: {
        ...settingsResponse().egress,
        reviewRequired: true
      }
    })).toMatchObject({ ok: false });
  });

  it("strictly decodes list and mutation projections", () => {
    expect(decodeMemoryListResponse({ memories: [memorySummary()], nextCursor: null }))
      .toMatchObject({ ok: true });
    expect(decodeMemoryMutationResponse({ memory: memorySummary() })).toMatchObject({ ok: true });
    expect(decodeMemoryListResponse({
      memories: [{ ...memorySummary(), ownerUserId: "other" }],
      nextCursor: null
    })).toMatchObject({ ok: false });
  });

  it("decodes bounded evidence without accepting impossible source shapes", () => {
    const explicitEvidence = {
      factVersionId: "version-1",
      id: "evidence-1",
      observedAt: now,
      safeExcerpt: "  Exact saved text.  ",
      safetyClass: "NORMAL",
      sourceChatId: null,
      sourceMessageId: null,
      sourceRole: null,
      sourceType: "EXPLICIT_ACTION",
      stance: "SUPPORTS"
    };
    expect(decodeMemoryEvidenceResponse({
      evidence: [explicitEvidence],
      nextCursor: null
    })).toMatchObject({ ok: true });
    expect(decodeMemoryEvidenceResponse({
      evidence: [{ ...explicitEvidence, sourceMessageId: "message-1" }],
      nextCursor: null
    })).toMatchObject({ ok: false });
  });

  it("requires deletion audit evidence and bounded progress", () => {
    expect(decodeMemoryDeletionStatus({
      completedUnits: 3,
      deletionId: "deletion-1",
      lastAuditAt: now,
      memoryGeneration: 8,
      memoryRevision: 43,
      operation: "CLEAR_HISTORY_INDEX",
      settingsRevision: 13,
      state: "SUCCEEDED",
      totalUnits: 3,
      updatedAt: now
    })).toMatchObject({ ok: true });
    expect(decodeMemoryDeletionStatus({
      completedUnits: 3,
      deletionId: "deletion-1",
      lastAuditAt: null,
      memoryGeneration: 8,
      memoryRevision: 43,
      operation: "CLEAR_HISTORY_INDEX",
      settingsRevision: 13,
      state: "SUCCEEDED",
      totalUnits: 3,
      updatedAt: now
    })).toMatchObject({ ok: false });
  });

  it("accepts only item-bearing used/degraded immutable receipts", () => {
    const item = {
      includedText: "Prefers Russian answers.",
      itemType: "FACT_VERSION",
      lifecycleState: "CURRENT",
      ordinal: 0,
      scopeType: "GLOBAL_USER",
      selectionReason: "exact preference",
      sourceChatId: "chat-1",
      sourceMessageIds: ["message-1"],
      sourceMode: "EXPLICIT",
      versionId: "version-1"
    };
    expect(decodeMemoryReceipt({
      degradationCode: null,
      itemCount: 1,
      items: [item],
      outcome: "USED",
      summary: "Used 1 memory"
    })).toMatchObject({ ok: true });
    expect(decodeMemoryReceipt({
      degradationCode: "vector_unavailable",
      itemCount: 1,
      items: [item],
      outcome: "DEGRADED",
      summary: "Used 1 memory"
    })).toMatchObject({ ok: true });
    expect(decodeMemoryReceipt({
      degradationCode: null,
      itemCount: 0,
      items: [],
      outcome: "USED",
      summary: "Used memory"
    })).toMatchObject({ ok: false });
    expect(decodeMemoryReceipt({
      degradationCode: null,
      itemCount: 1,
      items: [{ ...item, lifecycleState: "SOURCE_DELETED" }],
      outcome: "USED",
      summary: "Used 1 memory"
    })).toMatchObject({ ok: false });
  });

  it("accepts only committed bounded action feedback", () => {
    expect(decodeMemoryActionFeedback({ operation: "SAVE", status: "COMMITTED" }))
      .toMatchObject({ ok: true });
    expect(decodeMemoryActionFeedback({ operation: "EDIT", status: "COMMITTED" }))
      .toMatchObject({ ok: false });
    expect(decodeMemoryActionFeedback({
      operation: "FORGET",
      status: "COMMITTED",
      targetFactId: "private-id"
    })).toMatchObject({ ok: false });
  });

  it("decodes bounded history, rebuild, chat-mode, and stable error responses", () => {
    expect(decodeMemoryHistorySearchResponse({
      nextCursor: null,
      results: [{
        occurredAt: now,
        sourceChatId: "chat-1",
        sourceChatTitle: "Database notes",
        sourceMessageIds: ["message-1"],
        sourceState: "ARCHIVED",
        snippet: "We discussed pgvector."
      }]
    })).toMatchObject({ ok: true });
    expect(decodeMemoryRebuildStatus({
      completedUnits: 2,
      createdAt: now,
      errorCode: null,
      jobId: "job-1",
      operation: "REBUILD_SEARCH_INDEX",
      state: "RUNNING",
      totalUnits: 4,
      updatedAt: now
    })).toMatchObject({ ok: true });
    expect(decodeMemoryChatModeResponse({
      chatId: "chat-1",
      memoryGeneration: 8,
      memoryRevision: 43,
      mode: "EXCLUDED",
      sourceRevision: 10
    })).toMatchObject({ ok: true });

    for (const error of MEMORY_ERROR_CODES) {
      expect(decodeMemoryErrorResponse({ error })).toEqual({ error });
    }
    expect(decodeMemoryErrorResponse({ error: "memory_unknown" })).toBeNull();
    expect(decodeMemoryErrorResponse({ error: "memory_not_found", detail: "private" })).toBeNull();
  });
});
