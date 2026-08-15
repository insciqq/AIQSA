import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemorySummary
} from "../../../contracts/memory";
import { MemoryPersistenceError } from "../persistence/errors";
import { memorySha256 } from "../persistence/lexical";
import {
  createExplicitMemoryService,
  ExplicitMemoryServiceError,
  type ExplicitMemoryAuthorizationRepository,
  type ExplicitMemoryFactRepository,
  type ExplicitMemoryReadRepository,
  type ExplicitMemoryScopeRepository
} from "./service";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const STATEMENT = "  Я предпочитаю ответы о ёлках на русском языке.  ";

function summary(overrides: Partial<MemorySummary> = {}): MemorySummary {
  return {
    category: "preference",
    createdAt: NOW.toISOString(),
    currentVersionId: "version-1",
    displayText: STATEMENT,
    factState: "ACTIVE",
    id: "fact-1",
    indexingState: "LEXICAL_READY",
    lastConfirmedAt: NOW.toISOString(),
    lastUsedAt: null,
    modality: "PREFERENCE",
    pinned: false,
    scope: { type: "GLOBAL_USER" },
    sensitivityClass: "NORMAL",
    sourceCount: 1,
    sourceMode: "EXPLICIT",
    updatedAt: NOW.toISOString(),
    validFrom: null,
    validTo: null,
    versionState: "ACTIVE",
    ...overrides
  };
}

function authorizationRepository(): ExplicitMemoryAuthorizationRepository {
  return {
    mint: vi.fn(async (_userId, input) => ({
      expiresAt: input.expiresAt,
      id: "authorization-1"
    })),
    resolveForUse: vi.fn(async () => ({ confirmedAt: NOW, requestId: "request-1" }))
  };
}

function factRepository(): ExplicitMemoryFactRepository {
  return {
    edit: vi.fn(async (_userId, input) => {
      if (input.expectedVersionId !== "version-1") {
        throw new MemoryPersistenceError("memory_fact_version_stale");
      }
      return {
      eventId: "event-2",
      factId: "fact-1",
      memoryGeneration: 0,
      memoryRevision: 2,
      outcome: "EDITED" as const,
      replayed: false,
      versionId: "version-2"
      };
    }),
    move: vi.fn(async () => ({
      eventId: "event-move",
      factId: "fact-moved",
      memoryGeneration: 0,
      memoryRevision: 2,
      outcome: "MOVED" as const,
      replayed: false,
      versionId: "version-moved"
    })),
    resolve: vi.fn(async () => ({
      eventId: "event-resolve",
      factId: "fact-1",
      memoryGeneration: 0,
      memoryRevision: 2,
      outcome: "EDITED" as const,
      replayed: false,
      versionId: "version-resolved"
    })),
    save: vi.fn(async () => ({
      eventId: "event-1",
      factId: "fact-1",
      memoryGeneration: 0,
      memoryRevision: 1,
      outcome: "CREATED" as const,
      replayed: false,
      versionId: "version-1"
    }))
  };
}

function readRepository(): ExplicitMemoryReadRepository {
  return {
    detail: vi.fn(async () => ({
      feedback: [],
      history: [],
      memory: summary(),
      versions: []
    })),
    evidence: vi.fn(async () => ({ evidence: [], nextCursor: null })),
    get: vi.fn(async () => summary()),
    getConflict: vi.fn(async () => null),
    getEditable: vi.fn(async () => ({
      canonicalKey: "custom.abc",
      category: "preference",
      currentVersionId: "version-1",
      displayText: STATEMENT,
      factState: "ACTIVE" as const,
      factId: "fact-1",
      languageCode: "ru",
      modality: "PREFERENCE" as const,
      pinned: false,
      scopeId: "scope-1",
      scope: { type: "GLOBAL_USER" as const },
      sensitivityClass: "NORMAL" as const,
      validFrom: null,
      validTo: null
    })),
    getForgetUndoCandidate: vi.fn(async () => null),
    list: vi.fn(async () => ({ memories: [summary()], nextCursor: null })),
    search: vi.fn(async () => ({ memories: [summary()], nextCursor: null }))
  };
}

function scopeRepository(): ExplicitMemoryScopeRepository {
  return {
    ensure: vi.fn(async (userId, selection) => ({
      id: selection.type === "GLOBAL_USER" ? "scope-1" : `scope-${selection.targetId}`,
      scopeType: selection.type,
      targetIdSnapshot: selection.type === "GLOBAL_USER" ? null : selection.targetId,
      userId
    })),
    ensureGlobal: vi.fn(async (userId) => ({
      id: "scope-1",
      scopeType: "GLOBAL_USER" as const,
      targetIdSnapshot: null,
      userId
    }))
  };
}

describe("explicit Memory service", () => {
  it("mints a short-lived exact statement authorization without retaining plaintext", async () => {
    const authorizations = authorizationRepository();
    const service = createExplicitMemoryService({
      authorizationRepository: authorizations,
      clock: () => NOW,
      factRepository: factRepository(),
      readRepository: readRepository(),
      scopeRepository: scopeRepository()
    });
    const exactStatementHash = memorySha256(STATEMENT);
    await expect(service.mintAuthorization("user-1", {
      action: "SAVE",
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      exactStatementHash,
      requestNonce: "nonce-1"
    })).resolves.toEqual({
      expiresAt: "2026-08-10T12:05:00.000Z",
      mutationAuthorizationId: "authorization-1"
    });
    expect(authorizations.mint).toHaveBeenCalledWith("user-1", expect.objectContaining({
      action: "SAVE",
      authorizedPayloadHash: exactStatementHash,
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      expiresAt: new Date("2026-08-10T12:05:00.000Z")
    }), NOW);
    expect(JSON.stringify(vi.mocked(authorizations.mint).mock.calls)).not.toContain(STATEMENT);
  });

  it("mints shipped Move and bulk-delete authorizations", async () => {
    const authorizations = authorizationRepository();
    const service = createExplicitMemoryService({
      authorizationRepository: authorizations,
      clock: () => NOW,
      factRepository: factRepository(),
      readRepository: readRepository(),
      scopeRepository: scopeRepository()
    });

    await expect(service.mintAuthorization("user-1", {
      action: "MOVE_SCOPE",
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      expectedTargetVersionId: "version-1",
      requestNonce: "nonce-move",
      targetFactId: "fact-1"
    })).resolves.toMatchObject({ mutationAuthorizationId: "authorization-1" });
    await expect(service.mintAuthorization("user-1", {
      action: "BULK_DELETE",
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      expectedMemoryRevision: 4,
      expectedSettingsRevision: 2,
      operation: "CLEAR_HISTORY_INDEX",
      requestNonce: "nonce-clear-history"
    })).resolves.toMatchObject({ mutationAuthorizationId: "authorization-1" });
    await expect(service.mintAuthorization("user-1", {
      action: "BULK_DELETE",
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      expectedMemoryRevision: 4,
      expectedSettingsRevision: 2,
      operation: "DELETE_LEARNED",
      requestNonce: "nonce-delete-learned"
    })).resolves.toMatchObject({ mutationAuthorizationId: "authorization-1" });
    await expect(service.mintAuthorization("user-1", {
      action: "BULK_DELETE",
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      expectedMemoryRevision: 4,
      expectedSettingsRevision: 2,
      operation: "DELETE_ALL_REUSABLE",
      requestNonce: "nonce-delete-all-reusable"
    })).resolves.toMatchObject({ mutationAuthorizationId: "authorization-1" });
    expect(authorizations.mint).toHaveBeenCalledTimes(4);
  });

  it("commits the exact display statement through an authorized local lexical write", async () => {
    const authorizations = authorizationRepository();
    const facts = factRepository();
    const service = createExplicitMemoryService({
      authorizationRepository: authorizations,
      clock: () => NOW,
      factRepository: facts,
      readRepository: readRepository(),
      scopeRepository: scopeRepository()
    });
    await expect(service.create("user-1", {
      category: "preference",
      modality: "PREFERENCE",
      mutationAuthorizationId: "authorization-1",
      scope: { type: "GLOBAL_USER" },
      statement: STATEMENT,
      validFrom: null,
      validTo: null
    }, {
      modelRunId: "run-1",
      persistedToolCallId: "tool-call-1"
    })).resolves.toEqual({ memory: summary() });
    expect(authorizations.resolveForUse).toHaveBeenCalledWith("user-1", {
      action: "SAVE",
      authorizationId: "authorization-1",
      authorizedPayloadHash: memorySha256(STATEMENT)
    });
    expect(facts.save).toHaveBeenCalledWith("user-1", expect.objectContaining({
      authorization: expect.objectContaining({ action: "SAVE" }),
      modelRunId: "run-1",
      persistedToolCallId: "tool-call-1",
      requestId: "request-1",
      scopeId: "scope-1",
      value: expect.objectContaining({
        category: "preference",
        displayText: STATEMENT,
        languageCode: "und",
        modality: "PREFERENCE",
        sourceMode: "EXPLICIT"
      })
    }));
  });

  it("reuses SAVE authority for one exact pending Forget revival", async () => {
    const authorizations = authorizationRepository();
    const facts = factRepository();
    const reads = readRepository();
    vi.mocked(reads.getForgetUndoCandidate).mockResolvedValue({
      canonicalKey: "profile.response_style",
      category: "preference",
      displayText: STATEMENT,
      expiresAt: new Date(NOW.getTime() + 60_000),
      modality: "PREFERENCE",
      scopeId: "scope-1",
      sensitivityClass: "NORMAL",
      validFrom: null,
      validTo: null,
      versionId: "version-forgotten"
    });
    const service = createExplicitMemoryService({
      authorizationRepository: authorizations,
      clock: () => NOW,
      factRepository: facts,
      readRepository: reads,
      scopeRepository: scopeRepository()
    });

    await expect(service.undoForget("user-1", "fact-1", {
      deletionId: "deletion-1",
      mutationAuthorizationId: "authorization-undo"
    })).resolves.toEqual({ memory: summary() });
    expect(authorizations.resolveForUse).toHaveBeenCalledWith("user-1", {
      action: "SAVE",
      authorizationId: "authorization-undo",
      authorizedPayloadHash: memorySha256(STATEMENT)
    });
    expect(facts.save).toHaveBeenCalledWith("user-1", expect.objectContaining({
      explicitSuppressionOverride: true,
      scopeId: "scope-1",
      undoForget: {
        deletionId: "deletion-1",
        expectedVersionId: "version-forgotten",
        now: NOW
      },
      value: expect.objectContaining({
        canonicalKey: "profile.response_style",
        displayText: STATEMENT,
        sourceMode: "EXPLICIT"
      })
    }));

    vi.mocked(reads.getForgetUndoCandidate).mockResolvedValue(null);
    await expect(service.undoForget("user-1", "fact-1", {
      deletionId: "expired-deletion",
      mutationAuthorizationId: "authorization-expired"
    })).rejects.toEqual(new ExplicitMemoryServiceError("memory_undo_unavailable"));
  });

  it("preserves omitted fields on edit and leaves stale-version fencing to the transaction", async () => {
    const facts = factRepository();
    const reads = readRepository();
    const service = createExplicitMemoryService({
      authorizationRepository: authorizationRepository(),
      clock: () => NOW,
      factRepository: facts,
      readRepository: reads,
      scopeRepository: scopeRepository()
    });
    await service.update("user-1", "fact-1", {
      expectedVersionId: "version-1",
      mutationAuthorizationId: "authorization-edit-1",
      pinned: true
    }, {
      modelRunId: "run-1",
      persistedToolCallId: "tool-call-1"
    });
    expect(facts.edit).toHaveBeenCalledWith("user-1", expect.objectContaining({
      expectedVersionId: "version-1",
      modelRunId: "run-1",
      persistedToolCallId: "tool-call-1",
      pinned: true,
      value: expect.objectContaining({
        category: "preference",
        displayText: STATEMENT,
        modality: "PREFERENCE"
      })
    }));

    await expect(service.update("user-1", "fact-1", {
      expectedVersionId: "stale-version",
      mutationAuthorizationId: "authorization-edit-2",
      pinned: false
    })).rejects.toEqual(new ExplicitMemoryServiceError("memory_version_stale"));
    expect(facts.edit).toHaveBeenCalledTimes(2);
  });

  it("moves an orphaned explicit fact through append-only target lineage", async () => {
    const facts = factRepository();
    const reads = readRepository();
    vi.mocked(reads.getEditable).mockResolvedValue({
      canonicalKey: "custom.abc",
      category: "preference",
      currentVersionId: "version-1",
      displayText: STATEMENT,
      factId: "fact-1",
      factState: "ORPHANED",
      languageCode: "ru",
      modality: "PREFERENCE",
      pinned: false,
      scope: { targetId: "deleted-chat", type: "CHAT" },
      scopeId: "scope-deleted-chat",
      sensitivityClass: "NORMAL",
      validFrom: null,
      validTo: null
    });
    vi.mocked(reads.get).mockResolvedValue(summary({
      currentVersionId: "version-moved",
      id: "fact-moved",
      scope: { targetId: "chat-live", type: "CHAT" }
    }));
    const service = createExplicitMemoryService({
      authorizationRepository: authorizationRepository(),
      clock: () => NOW,
      factRepository: facts,
      readRepository: reads,
      scopeRepository: scopeRepository()
    });

    await expect(service.update("user-1", "fact-1", {
      expectedVersionId: "version-1",
      mutationAuthorizationId: "authorization-move",
      scope: { targetId: "chat-live", type: "CHAT" }
    })).resolves.toMatchObject({
      memory: { id: "fact-moved", scope: { targetId: "chat-live", type: "CHAT" } }
    });
    expect(facts.move).toHaveBeenCalledWith("user-1", expect.objectContaining({
      authorization: expect.objectContaining({ action: "MOVE_SCOPE" }),
      expectedVersionId: "version-1",
      factId: "fact-1",
      targetScopeId: "scope-chat-live"
    }));
    expect(facts.edit).not.toHaveBeenCalled();

    await expect(service.update("user-1", "fact-1", {
      expectedVersionId: "version-1",
      mutationAuthorizationId: "authorization-mixed-move",
      pinned: true,
      scope: { targetId: "chat-live", type: "CHAT" }
    })).rejects.toEqual(new ExplicitMemoryServiceError("memory_contract_invalid"));
    expect(facts.move).toHaveBeenCalledTimes(1);
  });

  it("turns an active automatic correction into an authorized explicit version", async () => {
    const facts = factRepository();
    const reads = readRepository();
    vi.mocked(reads.get).mockResolvedValue(summary({
      currentVersionId: "version-explicit-2",
      sourceMode: "EXPLICIT"
    }));
    const service = createExplicitMemoryService({
      authorizationRepository: authorizationRepository(),
      clock: () => NOW,
      factRepository: facts,
      readRepository: reads,
      scopeRepository: scopeRepository()
    });

    await expect(service.update("user-1", "fact-1", {
      expectedVersionId: "version-1",
      mutationAuthorizationId: "authorization-correct-automatic",
      statement: "I prefer detailed answers in Russian."
    })).resolves.toMatchObject({
      memory: { currentVersionId: "version-explicit-2", sourceMode: "EXPLICIT" }
    });
    expect(facts.edit).toHaveBeenCalledWith("user-1", expect.objectContaining({
      expectedVersionId: "version-1",
      value: expect.objectContaining({
        displayText: "I prefer detailed answers in Russian.",
        sourceMode: "EXPLICIT"
      })
    }));
  });

  it("resolves an exact conflict snapshot once and conservatively labels corrections", async () => {
    const facts = factRepository();
    const reads = readRepository();
    vi.mocked(reads.getConflict).mockResolvedValue({
      canonicalKey: "preference.response_style",
      category: "preference",
      factId: "fact-1",
      pinned: false,
      scope: { type: "GLOBAL_USER" },
      scopeId: "scope-1",
      versions: [{
        displayText: "Keep answers concise.",
        id: "version-a",
        modality: "PREFERENCE",
        sensitivityClass: "NORMAL",
        validFrom: null,
        validTo: null
      }, {
        displayText: "Include private medical detail.",
        id: "version-b",
        modality: "PREFERENCE",
        sensitivityClass: "HIGHLY_SENSITIVE",
        validFrom: null,
        validTo: null
      }]
    });
    vi.mocked(reads.get).mockResolvedValue(summary({
      currentVersionId: "version-resolved",
      sourceMode: "EXPLICIT"
    }));
    const service = createExplicitMemoryService({
      authorizationRepository: authorizationRepository(),
      clock: () => NOW,
      factRepository: facts,
      readRepository: reads,
      scopeRepository: scopeRepository()
    });

    await expect(service.resolveConflict("user-1", "fact-1", {
      expectedVersionIds: ["version-a", "version-b"],
      mutationAuthorizationId: "authorization-resolve",
      resolution: { kind: "CORRECT", statement: "Use a balanced level of detail." }
    })).resolves.toMatchObject({ memory: { currentVersionId: "version-resolved" } });
    expect(facts.resolve).toHaveBeenCalledWith("user-1", expect.objectContaining({
      expectedVersionIds: ["version-a", "version-b"],
      selectedVersionId: "version-a",
      value: expect.objectContaining({
        displayText: "Use a balanced level of detail.",
        sensitivityClass: "HIGHLY_SENSITIVE",
        sourceMode: "EXPLICIT"
      })
    }));

    await expect(service.resolveConflict("user-1", "fact-1", {
      expectedVersionIds: ["version-a", "version-stale"],
      mutationAuthorizationId: "authorization-stale",
      resolution: { kind: "CHOOSE", versionId: "version-a" }
    })).rejects.toEqual(new ExplicitMemoryServiceError("memory_version_stale"));
    expect(facts.resolve).toHaveBeenCalledTimes(1);
  });

  it("maps unavailable scoped targets, rejects secrets, and hides authorization failures", async () => {
    const facts = factRepository();
    const authorizations = authorizationRepository();
    const scopes = scopeRepository();
    vi.mocked(scopes.ensure).mockImplementation(async (userId, selection) => {
      if (selection.type === "CHAT") {
        throw new MemoryPersistenceError("memory_scope_unavailable");
      }
      return {
        id: "scope-1",
        scopeType: "GLOBAL_USER",
        targetIdSnapshot: null,
        userId
      };
    });
    const service = createExplicitMemoryService({
      authorizationRepository: authorizations,
      factRepository: facts,
      readRepository: readRepository(),
      scopeRepository: scopes
    });
    await expect(service.create("user-1", {
      mutationAuthorizationId: "authorization-1",
      scope: { targetId: "chat-1", type: "CHAT" },
      statement: "Remember this"
    })).rejects.toEqual(new ExplicitMemoryServiceError("memory_scope_unavailable"));
    await expect(service.create("user-1", {
      mutationAuthorizationId: "authorization-2",
      scope: { type: "GLOBAL_USER" },
      statement: "API key: sk-abcdefghijklmnopqrstuvwxyz123456"
    })).rejects.toEqual(new ExplicitMemoryServiceError("memory_secret_rejected"));
    expect(facts.save).not.toHaveBeenCalled();
    expect(authorizations.resolveForUse).toHaveBeenCalledTimes(1);

    const failing = createExplicitMemoryService({
      authorizationRepository: {
        ...authorizationRepository(),
        resolveForUse: vi.fn(async () => {
          throw new MemoryPersistenceError("memory_mutation_authorization_invalid");
        })
      },
      factRepository: facts,
      readRepository: readRepository(),
      scopeRepository: scopeRepository()
    });
    await expect(failing.create("user-1", {
      mutationAuthorizationId: "authorization-3",
      scope: { type: "GLOBAL_USER" },
      statement: "Remember an ordinary preference"
    })).rejects.toEqual(
      new ExplicitMemoryServiceError("memory_intent_confirmation_required")
    );
  });
});
