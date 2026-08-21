import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../../auth/requestAuth";
import {
  createMemorySourceActionHandler,
  createMemorySourceNavigationHandler,
  MEMORY_SOURCE_UNAVAILABLE_LOCATION
} from "./actionHandlers";
import {
  MemorySourceActionError,
  type MemorySourceActionService
} from "./actionService";

function session(): AuthenticatedSession {
  return {
    expiresAt: new Date("2026-08-21T09:00:00.000Z"),
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

function service(): MemorySourceActionService {
  return {
    execute: vi.fn(),
    resolveOpenSource: vi.fn(async () => ({
      chatId: "source-chat-1",
      messageId: "source-message-1"
    }))
  } as unknown as MemorySourceActionService;
}

describe("Memory source navigation handler", () => {
  it("maps stale internal versions to a consumer-safe changed error", async () => {
    const sourceService = service();
    vi.mocked(sourceService.execute).mockRejectedValue(
      new MemorySourceActionError("memory_version_stale")
    );
    const handler = createMemorySourceActionHandler({
      mutationRateLimiter: {
        check: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }))
      },
      resolveAuth: vi.fn(async () => session()),
      service: sourceService
    });
    const response = await handler(new Request(
      "http://localhost/api/me/memory/source-actions",
      {
        body: JSON.stringify({
          action: "FORGET",
          memoryRef: "mr1.opaque",
          requestNonce: "request-nonce"
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }
    ));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "memory_changed" });
  });

  it("resolves an opaque ref under current auth before canonical chat navigation", async () => {
    const sourceService = service();
    const handler = createMemorySourceNavigationHandler({
      resolveAuth: vi.fn(async () => session()),
      service: sourceService
    });
    const response = await handler(new Request(
      "http://localhost/api/me/memory/source-actions/open?memoryRef=mr1.opaque"
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location"))
      .toBe("/?chat=source-chat-1&message=source-message-1");
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(sourceService.resolveOpenSource).toHaveBeenCalledWith(
      "user-1",
      "mr1.opaque"
    );
  });

  it("redirects unavailable, unauthenticated, or ambiguous refs to a safe app notice", async () => {
    const sourceService = service();
    const unauthorized = createMemorySourceNavigationHandler({
      resolveAuth: vi.fn(async () => null),
      service: sourceService
    });
    const unauthorizedResponse = await unauthorized(new Request(
      "http://localhost/api/me/memory/source-actions/open?memoryRef=mr1.opaque"
    ));
    expect(unauthorizedResponse.status).toBe(303);
    expect(unauthorizedResponse.headers.get("location"))
      .toBe(MEMORY_SOURCE_UNAVAILABLE_LOCATION);

    const malformed = createMemorySourceNavigationHandler({
      resolveAuth: vi.fn(async () => session()),
      service: sourceService
    });
    const malformedResponse = await malformed(new Request(
      "http://localhost/api/me/memory/source-actions/open?memoryRef=a&memoryRef=b"
    ));
    expect(malformedResponse.status).toBe(303);
    expect(malformedResponse.headers.get("location"))
      .toBe(MEMORY_SOURCE_UNAVAILABLE_LOCATION);
    expect(sourceService.resolveOpenSource).not.toHaveBeenCalled();

    vi.mocked(sourceService.resolveOpenSource).mockRejectedValueOnce(
      new MemorySourceActionError("memory_not_found")
    );
    const stale = createMemorySourceNavigationHandler({
      resolveAuth: vi.fn(async () => session()),
      service: sourceService
    });
    const staleResponse = await stale(new Request(
      "http://localhost/api/me/memory/source-actions/open?memoryRef=mr1.stale"
    ));
    expect(staleResponse.status).toBe(303);
    expect(staleResponse.headers.get("location"))
      .toBe(MEMORY_SOURCE_UNAVAILABLE_LOCATION);
  });
});
