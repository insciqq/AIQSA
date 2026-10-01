import { MemoryPersistenceError, memoryPersistenceFailureCode } from "../persistence/errors";
import { describe, expect, it, vi } from "vitest";
import type {
  MemoryDeletionStatus,
  MemorySummary
} from "../../../contracts/memory";
import { memoryTargetAuthorizationPayloadHash } from "../persistence/authorizations";
import {
  createMemoryLifecycleService,
  MemoryForgetCommittedResponseError,
  MemoryLifecycleServiceError,
  type MemoryLifecycleAuthorizationRepository,
  type MemoryLifecycleMutationRepository
} from "./service";
import { memoryForgetPeerCascadeCount, rememberMemoryForgetPeerCascade } from "./sourcePreservation";

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
    deleteAllReusable: vi.fn(async () => ({
      affectedFacts: 5,
      deletionId: "deletion-1",
      memoryGeneration: 4,
      memoryRevision: 8,
      replayed: false,
      settingsRevision: 3
    })),
    deleteExplicit: vi.fn(async () => ({
      affectedFacts: 2,
      deletionId: "deletion-1",
      memoryGeneration: 4,
      memoryRevision: 8,
      replayed: false,
      settingsRevision: 2
    })),
    deleteLearned: vi.fn(async () => ({
      affectedFacts: 3,
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
      tombstone: forgottenSummary,
      undoExpiresAt: new Date(NOW.getTime() + 60_000),
      versionId: "version-1"
    })),
    status: vi.fn(async () => pendingStatus)
  };
}

describe("Memory lifecycle service", () => {
  it("retains a precise persistence failure for server diagnostics after public mapping", async () => {
    const mutationRepository = mutations();
    vi.mocked(mutationRepository.forget).mockRejectedValueOnce(new MemoryPersistenceError("memory_forget_source_limit"));
    const service = createMemoryLifecycleService({ authorizationRepository: authorizations(), mutationRepository,
      readRepository: { get: vi.fn(async () => forgottenSummary) } });
    const error = await service.forget("user-1", "fact-1", {
      expectedVersionId: "version-1", mutationAuthorizationId: "authorization-1"
    }).catch((error: unknown) => error);
    expect(error).toEqual(new MemoryLifecycleServiceError("memory_action_failed"));
    expect(memoryPersistenceFailureCode(error)).toBe("memory_forget_source_limit");
    expect(JSON.stringify(error)).not.toContain("memory_forget_source_limit");
  });

  it("marks a committed Forget whose response cannot be projected without changing its public failure", async () => {
    const mutationRepository = mutations();
    const committed = await mutationRepository.forget("user-1", {} as never);
    vi.mocked(mutationRepository.forget).mockResolvedValueOnce({
      ...committed,
      tombstone: { ...committed.tombstone, factState: "PRIVATE_STATE" as never }
    });
    const kick = vi.fn();
    const service = createMemoryLifecycleService({ authorizationRepository: authorizations(), kick, mutationRepository,
      readRepository: { get: vi.fn(async () => forgottenSummary) } });
    const error = await service.forget("user-1", "fact-1", {
      expectedVersionId: "version-1", mutationAuthorizationId: "authorization-1"
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MemoryForgetCommittedResponseError);
    expect(error).toBeInstanceOf(MemoryLifecycleServiceError);
    expect(error).toMatchObject({ code: "memory_action_failed", name: "MemoryLifecycleServiceError" });
    expect(kick).toHaveBeenCalledOnce();
    expect(mutationRepository.forget).toHaveBeenCalledTimes(2);
  });

  it("carries a legitimate peer cascade count to the projected response only", async () => {
    const mutationRepository = mutations();
    const committed = await mutationRepository.forget("user-1", {} as never);
    rememberMemoryForgetPeerCascade(committed, 3);
    vi.mocked(mutationRepository.forget).mockResolvedValueOnce(committed);
    const service = createMemoryLifecycleService({ authorizationRepository: authorizations(), mutationRepository,
      readRepository: { get: vi.fn(async () => forgottenSummary) } });
    const response = await service.forget("user-1", "fact-1", {
      expectedVersionId: "version-1", mutationAuthorizationId: "authorization-1"
    });
    expect(memoryForgetPeerCascadeCount(response)).toBe(3);
    expect(JSON.stringify(response)).not.toContain("cascade");
  });

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
    })).resolves.toEqual({
      memory: forgottenSummary,
      undo: {
        deletionId: "deletion-1",
        expiresAt: "2026-08-10T12:01:00.000Z",
        versionId: "version-1"
      }
    });
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

  it("returns the durable tombstone when source suppression hides an automatic fact", async () => {
    const automaticTombstone: MemorySummary = {
      ...forgottenSummary,
      sourceMode: "AUTOMATIC"
    };
    const readRepository = { get: vi.fn(async () => null) };
    const forget = vi.fn(async () => ({
      deletionId: "deletion-1",
      eventId: "event-1",
      factId: "fact-1",
      memoryGeneration: 4,
      memoryRevision: 8,
      replayed: false,
      settingsRevision: 2,
      tombstone: automaticTombstone,
      undoExpiresAt: new Date(NOW.getTime() + 60_000),
      versionId: "version-1"
    }));
    const service = createMemoryLifecycleService({
      authorizationRepository: authorizations(),
      clock: () => NOW,
      mutationRepository: { ...mutations(), forget },
      readRepository
    });
    const request = {
      expectedVersionId: "version-1",
      mutationAuthorizationId: "authorization-1"
    };

    await expect(service.forget("user-1", "fact-1", request)).resolves
      .toMatchObject({ memory: automaticTombstone });
    await expect(service.forget("user-1", "fact-1", request)).resolves
      .toMatchObject({ memory: automaticTombstone });
    expect(readRepository.get).not.toHaveBeenCalled();
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

  it("dispatches DELETE_LEARNED through its source-cutoff mutation", async () => {
    const authorizationRepository = authorizations();
    const mutationRepository = mutations();
    const learnedStatus: MemoryDeletionStatus = {
      ...pendingStatus,
      operation: "DELETE_LEARNED"
    };
    const service = createMemoryLifecycleService({
      authorizationRepository,
      mutationRepository: {
        ...mutationRepository,
        status: vi.fn(async () => learnedStatus)
      },
      readRepository: { get: vi.fn(async () => forgottenSummary) }
    });

    await expect(service.deleteExplicit("user-1", {
      expectedMemoryRevision: 7,
      expectedSettingsRevision: 2,
      mutationAuthorizationId: "authorization-learned-1",
      operation: "DELETE_LEARNED"
    })).resolves.toEqual(learnedStatus);
    expect(mutationRepository.deleteLearned).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ operation: "DELETE_LEARNED" })
    );
    expect(mutationRepository.deleteExplicit).not.toHaveBeenCalled();
    expect(mutationRepository.clearHistory).not.toHaveBeenCalled();
  });

  it("dispatches DELETE_ALL_REUSABLE through its global fenced mutation", async () => {
    const mutationRepository = mutations();
    const allStatus: MemoryDeletionStatus = {
      ...pendingStatus,
      operation: "DELETE_ALL_REUSABLE",
      settingsRevision: 3
    };
    const service = createMemoryLifecycleService({
      authorizationRepository: authorizations(),
      mutationRepository: {
        ...mutationRepository,
        status: vi.fn(async () => allStatus)
      },
      readRepository: { get: vi.fn(async () => forgottenSummary) }
    });

    await expect(service.deleteExplicit("user-1", {
      expectedMemoryRevision: 7,
      expectedSettingsRevision: 2,
      mutationAuthorizationId: "authorization-bulk-2",
      operation: "DELETE_ALL_REUSABLE"
    })).resolves.toEqual(allStatus);
    expect(mutationRepository.deleteAllReusable).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ operation: "DELETE_ALL_REUSABLE" })
    );
  });

  it("hides absent deletion status", async () => {
    const service = createMemoryLifecycleService({
      authorizationRepository: authorizations(),
      mutationRepository: { ...mutations(), status: vi.fn(async () => null) },
      readRepository: { get: vi.fn(async () => forgottenSummary) }
    });
    await expect(service.status("user-1", "foreign-deletion")).rejects.toEqual(
      new MemoryLifecycleServiceError("memory_not_found")
    );
  });
});
