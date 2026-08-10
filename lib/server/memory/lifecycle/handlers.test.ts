import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../../auth/requestAuth";
import {
  createDeleteExplicitMemoriesHandler,
  createForgetMemoryHandler,
  createGetMemoryDeletionHandler,
  type MemoryLifecycleHandlerDeps
} from "./handlers";
import {
  MemoryLifecycleServiceError,
  type MemoryLifecycleService
} from "./service";

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

function service(overrides: Partial<MemoryLifecycleService> = {}): MemoryLifecycleService {
  return {
    deleteExplicit: vi.fn(async () => ({
      completedUnits: 0,
      deletionId: "deletion-1",
      lastAuditAt: null,
      memoryGeneration: 2,
      memoryRevision: 3,
      operation: "DELETE_EXPLICIT" as const,
      settingsRevision: 1,
      state: "PENDING" as const,
      totalUnits: 4,
      updatedAt: "2026-08-10T12:00:00.000Z"
    })),
    forget: vi.fn(async () => ({
      memory: {
        category: "custom",
        createdAt: "2026-08-10T11:00:00.000Z",
        currentVersionId: null,
        displayText: null,
        factState: "FORGOTTEN" as const,
        id: "fact-1",
        indexingState: "DEGRADED" as const,
        lastConfirmedAt: "2026-08-10T11:00:00.000Z",
        lastUsedAt: null,
        modality: "STATE" as const,
        pinned: false,
        scope: { type: "GLOBAL_USER" as const },
        sensitivityClass: "NORMAL" as const,
        sourceCount: 0,
        sourceMode: "EXPLICIT" as const,
        updatedAt: "2026-08-10T12:00:00.000Z",
        validFrom: null,
        validTo: null,
        versionState: "FORGOTTEN" as const
      }
    })),
    status: vi.fn(async () => ({
      completedUnits: 4,
      deletionId: "deletion-1",
      lastAuditAt: "2026-08-10T12:01:00.000Z",
      memoryGeneration: 2,
      memoryRevision: 3,
      operation: "DELETE_EXPLICIT" as const,
      settingsRevision: 1,
      state: "SUCCEEDED" as const,
      totalUnits: 4,
      updatedAt: "2026-08-10T12:01:00.000Z"
    })),
    ...overrides
  };
}

function deps(
  lifecycleService = service(),
  authenticated: AuthenticatedSession | null = session()
): MemoryLifecycleHandlerDeps {
  return {
    resolveAuth: vi.fn(async () => authenticated),
    service: lifecycleService
  };
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("vary")).toBe("Cookie");
}

describe("Memory lifecycle handlers", () => {
  it("authenticates before reading a Forget body", async () => {
    const lifecycleService = service();
    const request = new Request("http://localhost/api/me/memories/fact-1/forget", {
      body: "not-json",
      method: "POST"
    });
    const response = await createForgetMemoryHandler(deps(lifecycleService, null))(
      request,
      { params: Promise.resolve({ memoryId: "fact-1" }) }
    );
    expect(response.status).toBe(401);
    expectPrivate(response);
    expect(lifecycleService.forget).not.toHaveBeenCalled();
  });

  it("routes strict Forget and bulk admission without URL payloads", async () => {
    const lifecycleService = service();
    const handlerDeps = deps(lifecycleService);
    const forgotten = await createForgetMemoryHandler(handlerDeps)(jsonRequest(
      "http://localhost/api/me/memories/fact-1/forget",
      {
        expectedVersionId: "version-1",
        mutationAuthorizationId: "authorization-1"
      }
    ), { params: { memoryId: "fact-1" } });
    expect(forgotten.status).toBe(200);
    expectPrivate(forgotten);
    expect(lifecycleService.forget).toHaveBeenCalledWith("user-1", "fact-1", {
      expectedVersionId: "version-1",
      mutationAuthorizationId: "authorization-1"
    });

    const admitted = await createDeleteExplicitMemoriesHandler(handlerDeps)(jsonRequest(
      "http://localhost/api/me/memory/bulk-delete",
      {
        expectedMemoryRevision: 2,
        expectedSettingsRevision: 1,
        mutationAuthorizationId: "authorization-bulk-1",
        operation: "DELETE_EXPLICIT"
      }
    ));
    expect(admitted.status).toBe(202);
    expectPrivate(admitted);

    const queryLeak = await createDeleteExplicitMemoriesHandler(handlerDeps)(jsonRequest(
      "http://localhost/api/me/memory/bulk-delete?operation=DELETE_EXPLICIT",
      {
        expectedMemoryRevision: 2,
        expectedSettingsRevision: 1,
        mutationAuthorizationId: "authorization-bulk-1",
        operation: "DELETE_EXPLICIT"
      }
    ));
    expect(queryLeak.status).toBe(400);
  });

  it("returns private privacy-neutral deletion status failures", async () => {
    const lifecycleService = service({
      status: vi.fn(async () => {
        throw new MemoryLifecycleServiceError("memory_not_found");
      })
    });
    const response = await createGetMemoryDeletionHandler(deps(lifecycleService))(
      new Request("http://localhost/api/me/memory/deletions/foreign"),
      { params: { deletionId: "foreign" } }
    );
    expect(response.status).toBe(404);
    expectPrivate(response);
    await expect(response.json()).resolves.toEqual({ error: "memory_not_found" });
  });
});
