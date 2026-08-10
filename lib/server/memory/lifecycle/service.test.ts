import { describe, expect, it, vi } from "vitest";
import type {
  MemoryDeletionStatus,
  MemorySummary
} from "../../../contracts/memory";
import { memoryTargetAuthorizationPayloadHash } from "../persistence/authorizations";
import {
  createMemoryLifecycleService,
  MemoryLifecycleServiceError,
  type MemoryLifecycleAuthorizationRepository,
  type MemoryLifecycleMutationRepository
} from "./service";

const NOW = new Date("2026-08-10T12:00:00.000Z");

const forgottenSummary: MemorySummary = {
  category: "preference",
  createdAt: NOW.toISOString(),
  currentVersionId: null,
  displayText: null,
  factState: "FORGOTTEN",
  id: "fact-1",
  indexingState: "DEGRADED",
  lastConfirmedAt: NOW.toISOString(),
  lastUsedAt: null,
  modality: "PREFERENCE",
  pinned: false,
  scope: { type: "GLOBAL_USER" },
  sensitivityClass: "NORMAL",
  sourceCount: 0,
  sourceMode: "EXPLICIT",
  updatedAt: NOW.toISOString(),
  validFrom: null,
  validTo: null,
  versionState: "FORGOTTEN"
};

const pendingStatus: MemoryDeletionStatus = {
  completedUnits: 1,
  deletionId: "deletion-1",
  lastAuditAt: null,
  memoryGeneration: 4,
  memoryRevision: 8,
  operation: "DELETE_EXPLICIT",
  settingsRevision: 2,
  state: "PENDING",
  totalUnits: 4,
  updatedAt: NOW.toISOString()
};

function authorizations(): MemoryLifecycleAuthorizationRepository {
  return {
    resolveForUse: vi.fn(async () => ({ confirmedAt: NOW, requestId: "request-1" }))
  };
}

function mutations(): MemoryLifecycleMutationRepository {
  return {
    clearHistory: vi.fn(async () => ({
      affectedFacts: 0,
      deletionId: "deletion-1",
      memoryGeneration: 4,
      memoryRevision: 8,
      replayed: false,
      settingsRevision: 2
    })),
    deleteExplicit: vi.fn(async () => ({
      affectedFacts: 2,
      deletionId: "deletion-1",
      memoryGeneration: 4,
      memoryRevision: 8,
      replayed: false,
      settingsRevision: 2
    })),
    forget: vi.fn(async () => ({
      deletionId: "deletion-1",
      eventId: "event-1",
      factId: "fact-1",
      memoryGeneration: 4,
      memoryRevision: 8,
      replayed: false,
      settingsRevision: 2,
      versionId: "version-1"
    })),
    status: vi.fn(async () => pendingStatus)
  };
}

describe("Memory lifecycle service", () => {
  it("forgets only through the exact target authorization and wakes durable purge", async () => {
    const authorizationRepository = authorizations();
    const mutationRepository = mutations();
    const kick = vi.fn();
    const service = createMemoryLifecycleService({
      authorizationRepository,
      clock: () => NOW,
      kick,
      mutationRepository,
      readRepository: { get: vi.fn(async () => forgottenSummary) }
    });

    await expect(service.forget("user-1", "fact-1", {
      expectedVersionId: "version-1",
      mutationAuthorizationId: "authorization-1"
    }, {
      modelRunId: "run-1",
      persistedToolCallId: "tool-call-1"
    })).resolves.toEqual({ memory: forgottenSummary });
    expect(authorizationRepository.resolveForUse).toHaveBeenCalledWith("user-1", {
      action: "FORGET",
      authorizationId: "authorization-1",
      authorizedPayloadHash: memoryTargetAuthorizationPayloadHash({
        action: "FORGET",
        expectedTargetVersionId: "version-1",
        targetFactId: "fact-1"
      }),
      expectedTargetVersionId: "version-1",
      targetFactId: "fact-1"
    });
    expect(mutationRepository.forget).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        expectedVersionId: "version-1",
        modelRunId: "run-1",
        now: NOW,
        persistedToolCallId: "tool-call-1"
      })
    );
    expect(kick).toHaveBeenCalledOnce();
  });

  it("binds DELETE_EXPLICIT authorization to both CAS revisions", async () => {
    const authorizationRepository = authorizations();
    const mutationRepository = mutations();
    const service = createMemoryLifecycleService({
      authorizationRepository,
      clock: () => NOW,
      mutationRepository,
      readRepository: { get: vi.fn(async () => forgottenSummary) }
    });

    await expect(service.deleteExplicit("user-1", {
      expectedMemoryRevision: 7,
      expectedSettingsRevision: 2,
      mutationAuthorizationId: "authorization-bulk-1",
      operation: "DELETE_EXPLICIT"
    })).resolves.toEqual(pendingStatus);
    expect(authorizationRepository.resolveForUse).toHaveBeenCalledWith("user-1", {
      action: "BULK_DELETE",
      authorizationId: "authorization-bulk-1",
      authorizedPayloadHash: memoryTargetAuthorizationPayloadHash({
        action: "BULK_DELETE",
        expectedMemoryRevision: 7,
        expectedSettingsRevision: 2,
        operation: "DELETE_EXPLICIT"
      })
    });
  });

  it("dispatches CLEAR_HISTORY_INDEX through its dedicated fenced mutation", async () => {
    const authorizationRepository = authorizations();
    const mutationRepository = mutations();
    const clearStatus: MemoryDeletionStatus = {
      ...pendingStatus,
      operation: "CLEAR_HISTORY_INDEX"
    };
    const service = createMemoryLifecycleService({
      authorizationRepository,
      mutationRepository: {
        ...mutationRepository,
        status: vi.fn(async () => clearStatus)
      },
      readRepository: { get: vi.fn(async () => forgottenSummary) }
    });

    await expect(service.deleteExplicit("user-1", {
      expectedMemoryRevision: 7,
      expectedSettingsRevision: 2,
      mutationAuthorizationId: "authorization-clear-1",
      operation: "CLEAR_HISTORY_INDEX"
    })).resolves.toEqual(clearStatus);
    expect(mutationRepository.clearHistory).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ operation: "CLEAR_HISTORY_INDEX" })
    );
    expect(mutationRepository.deleteExplicit).not.toHaveBeenCalled();
  });

  it("rejects later bulk variants and hides absent status", async () => {
    const mutationRepository = mutations();
    const service = createMemoryLifecycleService({
      authorizationRepository: authorizations(),
      mutationRepository: {
        ...mutationRepository,
        status: vi.fn(async () => null)
      },
      readRepository: { get: vi.fn(async () => forgottenSummary) }
    });

    await expect(service.deleteExplicit("user-1", {
      expectedMemoryRevision: 7,
      expectedSettingsRevision: 2,
      mutationAuthorizationId: "authorization-bulk-2",
      operation: "DELETE_LEARNED"
    })).rejects.toEqual(
      new MemoryLifecycleServiceError("memory_operation_unsupported")
    );
    await expect(service.status("user-1", "foreign-deletion")).rejects.toEqual(
      new MemoryLifecycleServiceError("memory_not_found")
    );
  });
});
