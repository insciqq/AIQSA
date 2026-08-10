import { describe, expect, it, vi } from "vitest";
import type { MemoryRebuildStatus } from "../../../contracts/memory";
import type { AuthenticatedSession } from "../../auth/requestAuth";
import {
  createCancelMemoryRebuildHandler,
  createGetMemoryRebuildHandler,
  createStartMemoryRebuildHandler,
  type MemoryRebuildHandlerDeps
} from "./handlers";
import {
  MemoryRebuildServiceError,
  type MemoryRebuildService
} from "./service";

const status: MemoryRebuildStatus = {
  completedUnits: 0,
  createdAt: "2026-08-10T12:00:00.000Z",
  errorCode: null,
  jobId: "job-1",
  operation: "REBUILD_SEARCH_INDEX",
  state: "QUEUED",
  totalUnits: null,
  updatedAt: "2026-08-10T12:00:00.000Z"
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

function service(overrides: Partial<MemoryRebuildService> = {}): MemoryRebuildService {
  return {
    cancel: vi.fn(async () => ({ ...status, state: "CANCELLED" as const })),
    start: vi.fn(async () => status),
    status: vi.fn(async () => status),
    ...overrides
  };
}

function deps(
  rebuildService = service(),
  authenticated: AuthenticatedSession | null = session()
): MemoryRebuildHandlerDeps {
  return {
    resolveAuth: vi.fn(async () => authenticated),
    service: rebuildService
  };
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/me/memory/rebuild", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("vary")).toBe("Cookie");
}

describe("Memory rebuild handlers", () => {
  it("authenticates before decoding and admits only strict JSON", async () => {
    const rebuildService = service();
    const unauthorized = await createStartMemoryRebuildHandler(
      deps(rebuildService, null)
    )(new Request("http://localhost/api/me/memory/rebuild", {
      body: "not-json",
      method: "POST"
    }));
    expect(unauthorized.status).toBe(401);
    expectPrivate(unauthorized);
    expect(rebuildService.start).not.toHaveBeenCalled();

    const admitted = await createStartMemoryRebuildHandler(deps(rebuildService))(
      jsonRequest({
        expectedMemoryRevision: 7,
        expectedSettingsRevision: 3,
        operation: "REBUILD_SEARCH_INDEX"
      })
    );
    expect(admitted.status).toBe(202);
    expectPrivate(admitted);
    expect(rebuildService.start).toHaveBeenCalledWith("user-1", {
      expectedMemoryRevision: 7,
      expectedSettingsRevision: 3,
      operation: "REBUILD_SEARCH_INDEX"
    });

    const leaked = await createStartMemoryRebuildHandler(deps(rebuildService))(
      jsonRequest({
        expectedMemoryRevision: 7,
        expectedSettingsRevision: 3,
        operation: "REBUILD_SEARCH_INDEX",
        userId: "other-user"
      })
    );
    expect(leaked.status).toBe(400);
  });

  it("returns owner-scoped status and accepts an explicitly empty cancel body", async () => {
    const rebuildService = service();
    const handlerDeps = deps(rebuildService);
    const current = await createGetMemoryRebuildHandler(handlerDeps)(
      new Request("http://localhost/api/me/memory/rebuild/job-1"),
      { params: { jobId: "job-1" } }
    );
    expect(current.status).toBe(200);
    expectPrivate(current);
    expect(rebuildService.status).toHaveBeenCalledWith("user-1", "job-1");

    const cancelled = await createCancelMemoryRebuildHandler(handlerDeps)(
      new Request("http://localhost/api/me/memory/rebuild/job-1/cancel", {
        headers: { "content-length": "0" },
        method: "POST"
      }),
      { params: Promise.resolve({ jobId: "job-1" }) }
    );
    expect(cancelled.status).toBe(200);
    expectPrivate(cancelled);
    expect(rebuildService.cancel).toHaveBeenCalledWith("user-1", "job-1");
  });

  it("rejects non-empty cancel payloads and maps privacy-neutral failures", async () => {
    const invalid = await createCancelMemoryRebuildHandler(deps())(
      new Request("http://localhost/api/me/memory/rebuild/job-1/cancel", {
        body: "x",
        headers: { "content-length": "1" },
        method: "POST"
      }),
      { params: { jobId: "job-1" } }
    );
    expect(invalid.status).toBe(400);
    expectPrivate(invalid);
    const bodyWithoutLength = await createCancelMemoryRebuildHandler(deps())(
      new Request("http://localhost/api/me/memory/rebuild/job-1/cancel", {
        body: "x",
        method: "POST"
      }),
      { params: { jobId: "job-1" } }
    );
    expect(bodyWithoutLength.status).toBe(400);
    expectPrivate(bodyWithoutLength);

    const missing = await createGetMemoryRebuildHandler(deps(service({
      status: vi.fn(async () => {
        throw new MemoryRebuildServiceError("memory_rebuild_not_found");
      })
    })))(
      new Request("http://localhost/api/me/memory/rebuild/foreign"),
      { params: { jobId: "foreign" } }
    );
    expect(missing.status).toBe(404);
    expectPrivate(missing);
    await expect(missing.json()).resolves.toEqual({ error: "memory_rebuild_not_found" });
  });
});
