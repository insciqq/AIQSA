import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemoryMutationResponse
} from "../../../contracts/memory";
import type { AuthenticatedSession } from "../../auth/requestAuth";
import {
  createCreateMemoryHandler,
  createGetMemoryEvidenceHandler,
  createGetMemoryHandler,
  createListMemoriesHandler,
  createMintMemoryMutationAuthorizationHandler,
  createSearchMemoriesHandler,
  createUpdateMemoryHandler,
  type ExplicitMemoryHandlerDeps
} from "./handlers";
import {
  ExplicitMemoryServiceError,
  type ExplicitMemoryService
} from "./service";

const memoryResponse: MemoryMutationResponse = {
  memory: {
    category: "custom",
    createdAt: "2026-08-10T12:00:00.000Z",
    currentVersionId: "version-1",
    displayText: "Remember this preference",
    factState: "ACTIVE",
    id: "fact-1",
    indexingState: "LEXICAL_READY",
    lastConfirmedAt: "2026-08-10T12:00:00.000Z",
    lastUsedAt: null,
    modality: "STATE",
    pinned: false,
    scope: { type: "GLOBAL_USER" },
    sensitivityClass: "NORMAL",
    sourceCount: 1,
    sourceMode: "EXPLICIT",
    updatedAt: "2026-08-10T12:00:00.000Z",
    validFrom: null,
    validTo: null,
    versionState: "ACTIVE"
  }
};

function session(): AuthenticatedSession {
  return {
    expiresAt: new Date("2026-08-10T13:00:00.000Z"),
    id: "session-1",
    user: {
      displayName: "Owner",
      email: "owner@example.test",
      id: "user-1",
      role: "user",
      status: "active"
    },
    userId: "user-1"
  };
}

function service(overrides: Partial<ExplicitMemoryService> = {}): ExplicitMemoryService {
  return {
    create: vi.fn(async () => memoryResponse),
    evidence: vi.fn(async () => ({ evidence: [], nextCursor: null })),
    get: vi.fn(async () => memoryResponse),
    list: vi.fn(async () => ({ memories: [memoryResponse.memory], nextCursor: null })),
    mintAuthorization: vi.fn(async () => ({
      expiresAt: "2026-08-10T12:05:00.000Z",
      mutationAuthorizationId: "authorization-1"
    })),
    search: vi.fn(async () => ({ memories: [memoryResponse.memory], nextCursor: null })),
    update: vi.fn(async () => memoryResponse),
    ...overrides
  };
}

function deps(
  explicitService = service(),
  authenticated: AuthenticatedSession | null = session(),
  allowed = true
): ExplicitMemoryHandlerDeps {
  return {
    mutationRateLimiter: {
      check: vi.fn(async () => ({ allowed, retryAfterSeconds: allowed ? 0 : 30 }))
    },
    resolveAuth: vi.fn(async () => authenticated),
    service: explicitService
  };
}

function jsonRequest(url: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method
  });
}

function context(memoryId = "fact-1") {
  return { params: Promise.resolve({ memoryId }) };
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("vary")).toBe("Cookie");
}

describe("explicit Memory handlers", () => {
  it("authenticates before mutation admission and rate-limits grant minting", async () => {
    const explicitService = service();
    const unauthorizedDeps = deps(explicitService, null);
    const unauthorized = await createMintMemoryMutationAuthorizationHandler(
      unauthorizedDeps
    )(jsonRequest("http://localhost/api/me/memory/mutation-authorizations", {}));
    expect(unauthorized.status).toBe(401);
    expectPrivate(unauthorized);
    expect(unauthorizedDeps.mutationRateLimiter.check).not.toHaveBeenCalled();
    expect(explicitService.mintAuthorization).not.toHaveBeenCalled();

    const limited = await createMintMemoryMutationAuthorizationHandler(
      deps(explicitService, session(), false)
    )(jsonRequest("http://localhost/api/me/memory/mutation-authorizations", {
      action: "SAVE",
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      exactStatementHash: "a".repeat(64),
      requestNonce: "nonce-1"
    }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    expectPrivate(limited);
    expect(explicitService.mintAuthorization).not.toHaveBeenCalled();
  });

  it("mints exact grants and rejects unknown or cross-user mutation fields", async () => {
    const explicitService = service();
    const handlerDeps = deps(explicitService);
    const minted = await createMintMemoryMutationAuthorizationHandler(handlerDeps)(
      jsonRequest("http://localhost/api/me/memory/mutation-authorizations", {
        action: "SAVE",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        exactStatementHash: "a".repeat(64),
        requestNonce: "nonce-1"
      })
    );
    expect(minted.status).toBe(201);
    expectPrivate(minted);
    expect(explicitService.mintAuthorization).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ action: "SAVE" })
    );

    const invalid = await createCreateMemoryHandler(handlerDeps)(jsonRequest(
      "http://localhost/api/me/memories",
      {
        mutationAuthorizationId: "authorization-1",
        scope: { type: "GLOBAL_USER" },
        statement: "Remember this preference",
        userId: "other-user"
      }
    ));
    expect(invalid.status).toBe(400);
    expectPrivate(invalid);
    expect(explicitService.create).not.toHaveBeenCalled();

    const ambiguousTarget = await createMintMemoryMutationAuthorizationHandler(
      handlerDeps
    )(jsonRequest("http://localhost/api/me/memory/mutation-authorizations", {
      action: "EDIT",
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      requestNonce: "nonce-ambiguous",
      target: "the preference about reports"
    }));
    expect(ambiguousTarget.status).toBe(400);
    expect(explicitService.mintAuthorization).toHaveBeenCalledTimes(1);
  });

  it("keeps free-form search in strict JSON and bounds list query controls", async () => {
    const explicitService = service();
    const handlerDeps = deps(explicitService);
    const listed = await createListMemoriesHandler(handlerDeps)(new Request(
      "http://localhost/api/me/memories?pageSize=10&scope=GLOBAL_USER&sourceMode=EXPLICIT"
    ));
    expect(listed.status).toBe(200);
    expectPrivate(listed);
    expect(explicitService.list).toHaveBeenCalledWith("user-1", {
      pageSize: 10,
      scope: { type: "GLOBAL_USER" },
      sourceMode: "EXPLICIT"
    });

    const queryInUrl = await createListMemoriesHandler(handlerDeps)(new Request(
      "http://localhost/api/me/memories?query=private-text"
    ));
    expect(queryInUrl.status).toBe(400);
    const searched = await createSearchMemoriesHandler(handlerDeps)(jsonRequest(
      "http://localhost/api/me/memories/search",
      { query: "русский", scope: { type: "GLOBAL_USER" } }
    ));
    expect(searched.status).toBe(200);
    expect(explicitService.search).toHaveBeenCalledWith("user-1", {
      query: "русский",
      scope: { type: "GLOBAL_USER" }
    });
  });

  it("routes owner detail, edit, and evidence with private privacy-neutral failures", async () => {
    const explicitService = service({
      get: vi.fn(async () => {
        throw new ExplicitMemoryServiceError("memory_not_found");
      })
    });
    const handlerDeps = deps(explicitService);
    const absent = await createGetMemoryHandler(handlerDeps)(
      new Request("http://localhost/api/me/memories/foreign-fact"),
      context("foreign-fact")
    );
    expect(absent.status).toBe(404);
    expectPrivate(absent);
    await expect(absent.json()).resolves.toEqual({ error: "memory_not_found" });

    const updated = await createUpdateMemoryHandler(handlerDeps)(
      jsonRequest("http://localhost/api/me/memories/fact-1", {
        expectedVersionId: "version-1",
        mutationAuthorizationId: "authorization-edit-1",
        pinned: true
      }, "PATCH"),
      context()
    );
    expect(updated.status).toBe(200);
    expectPrivate(updated);

    const evidence = await createGetMemoryEvidenceHandler(handlerDeps)(
      new Request("http://localhost/api/me/memories/fact-1/evidence"),
      context()
    );
    expect(evidence.status).toBe(200);
    expectPrivate(evidence);
    expect(explicitService.evidence).toHaveBeenCalledWith("user-1", "fact-1", null);
  });
});
