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
    evidence: vi.fn(async () => ({ evidence: [], nextCursor: null })),
    get: vi.fn(async () => summary()),
    getEditable: vi.fn(async () => ({
      canonicalKey: "custom.abc",
      category: "preference",
      currentVersionId: "version-1",
      displayText: STATEMENT,
      factId: "fact-1",
      languageCode: "ru",
      modality: "PREFERENCE" as const,
      pinned: false,
      scopeId: "scope-1",
      sensitivityClass: "NORMAL" as const,
      validFrom: null,
      validTo: null
    })),
    list: vi.fn(async () => ({ memories: [summary()], nextCursor: null })),
    search: vi.fn(async () => ({ memories: [summary()], nextCursor: null }))
  };
}

function scopeRepository(): ExplicitMemoryScopeRepository {
  return {
    ensureGlobal: vi.fn(async (userId) => ({
      id: "scope-1",
      scopeType: "GLOBAL_USER" as const,
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

  it("rejects only lifecycle authorizations without a shipped consumer", async () => {
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
    })).rejects.toEqual(new ExplicitMemoryServiceError("memory_operation_unsupported"));
    await expect(service.mintAuthorization("user-1", {
      action: "BULK_DELETE",
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      expectedMemoryRevision: 4,
      expectedSettingsRevision: 2,
      operation: "CLEAR_HISTORY_INDEX",
      requestNonce: "nonce-clear-history"
    })).rejects.toEqual(new ExplicitMemoryServiceError("memory_operation_unsupported"));
    expect(authorizations.mint).not.toHaveBeenCalled();
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
    })).resolves.toEqual({ memory: summary() });
    expect(authorizations.resolveForUse).toHaveBeenCalledWith("user-1", {
      action: "SAVE",
      authorizationId: "authorization-1",
      authorizedPayloadHash: memorySha256(STATEMENT)
    });
    expect(facts.save).toHaveBeenCalledWith("user-1", expect.objectContaining({
      authorization: expect.objectContaining({ action: "SAVE" }),
      requestId: "request-1",
      scopeId: "scope-1",
      value: expect.objectContaining({
        category: "preference",
        displayText: STATEMENT,
        languageCode: "ru",
        modality: "PREFERENCE",
        sourceMode: "EXPLICIT"
      })
    }));
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
    });
    expect(facts.edit).toHaveBeenCalledWith("user-1", expect.objectContaining({
      expectedVersionId: "version-1",
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

  it("rejects non-global scope and secrets before persistence and maps hidden failures", async () => {
    const facts = factRepository();
    const authorizations = authorizationRepository();
    const service = createExplicitMemoryService({
      authorizationRepository: authorizations,
      factRepository: facts,
      readRepository: readRepository(),
      scopeRepository: scopeRepository()
    });
    await expect(service.create("user-1", {
      mutationAuthorizationId: "authorization-1",
      scope: { targetId: "chat-1", type: "CHAT" },
      statement: "Remember this"
    })).rejects.toEqual(new ExplicitMemoryServiceError("memory_scope_invalid"));
    await expect(service.create("user-1", {
      mutationAuthorizationId: "authorization-2",
      scope: { type: "GLOBAL_USER" },
      statement: "API key: sk-abcdefghijklmnopqrstuvwxyz123456"
    })).rejects.toEqual(new ExplicitMemoryServiceError("memory_secret_rejected"));
    expect(facts.save).not.toHaveBeenCalled();
    expect(authorizations.resolveForUse).not.toHaveBeenCalled();

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
