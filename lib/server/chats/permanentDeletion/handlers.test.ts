import { describe, expect, it, vi } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../../contracts/memory";
import {
  createPermanentChatDeleteAdmissionHandler,
  createPermanentChatDeleteAuthorizationHandler,
  createPermanentChatDeleteStatusHandler,
  type PermanentChatDeletionHandlerDeps
} from "./handlers";

function dependencies(input: Readonly<{ authenticated?: boolean; enabled?: boolean }> = {}) {
  const service = {
    admit: vi.fn(async () => ({
      deletionId: "deletion-1",
      fencedAt: "2026-08-12T12:00:00.000Z",
      state: "PENDING" as const
    })),
    mintAuthorization: vi.fn(async () => ({
      expiresAt: "2026-08-12T12:05:00.000Z",
      mutationAuthorizationId: "authorization-1"
    })),
    status: vi.fn(async () => ({
      attemptCount: 0,
      cleanupComplete: false,
      deletionId: "deletion-1",
      errorCode: null,
      fencedAt: "2026-08-12T12:00:00.000Z",
      lastAuditAt: null,
      state: "PENDING" as const,
      updatedAt: "2026-08-12T12:00:00.000Z"
    }))
  };
  const check = vi.fn(async () => ({ allowed: true as const }));
  const resolveAuth = vi.fn(async () => input.authenticated === false
    ? null
    : { userId: "user-1" });
  return {
    check,
    deps: {
      capability: { enabled: input.enabled ?? true },
      mutationRateLimiter: { check },
      resolveAuth,
      service
    } as unknown as PermanentChatDeletionHandlerDeps,
    resolveAuth,
    service
  };
}

const context = { params: { chatId: "chat-1" } };

describe("permanent chat deletion handlers", () => {
  it("authenticates before the feature-dark gate and performs zero mutation work", async () => {
    const unavailable = dependencies({ enabled: false });
    const response = await createPermanentChatDeleteAdmissionHandler(unavailable.deps)(
      new Request("https://example.test/api/chats/chat-1/delete-permanently", {
        body: "not-json",
        method: "POST"
      }),
      context
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(unavailable.resolveAuth).toHaveBeenCalledOnce();
    expect(unavailable.check).not.toHaveBeenCalled();
    expect(unavailable.service.admit).not.toHaveBeenCalled();

    const anonymous = dependencies({ authenticated: false, enabled: false });
    const anonymousResponse = await createPermanentChatDeleteAdmissionHandler(
      anonymous.deps
    )(new Request("https://example.test/api/chats/chat-1/delete-permanently", {
      method: "POST"
    }), context);
    expect(anonymousResponse.status).toBe(401);
  });

  it("strictly decodes authorization and admission bodies", async () => {
    const deps = dependencies();
    const authorization = await createPermanentChatDeleteAuthorizationHandler(deps.deps)(
      new Request(
        "https://example.test/api/chats/chat-1/delete-permanently/authorization",
        {
          body: JSON.stringify({
            alsoForgetOriginMemories: false,
            confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
            expectedActiveLeafMessageId: "message-1",
            expectedChatRevision: 2,
            requestNonce: "nonce-1"
          }),
          headers: { "content-type": "application/json" },
          method: "POST"
        }
      ),
      context
    );
    expect(authorization.status).toBe(201);
    expect(deps.service.mintAuthorization).toHaveBeenCalledWith(
      "user-1",
      "chat-1",
      expect.objectContaining({ expectedChatRevision: 2 })
    );

    const admission = await createPermanentChatDeleteAdmissionHandler(deps.deps)(
      new Request("https://example.test/api/chats/chat-1/delete-permanently", {
        body: JSON.stringify({
          alsoForgetOriginMemories: false,
          expectedActiveLeafMessageId: "message-1",
          expectedChatRevision: 2,
          mutationAuthorizationId: "authorization-1"
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }),
      context
    );
    expect(admission.status).toBe(202);
    expect(deps.service.admit).toHaveBeenCalledOnce();

    const invalid = await createPermanentChatDeleteAdmissionHandler(deps.deps)(
      new Request("https://example.test/api/chats/chat-1/delete-permanently", {
        body: JSON.stringify({ mutationAuthorizationId: "authorization-1" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }),
      context
    );
    expect(invalid.status).toBe(400);
  });

  it("returns a bounded no-store status only for one deletion id", async () => {
    const deps = dependencies({ enabled: false });
    const response = await createPermanentChatDeleteStatusHandler(deps.deps)(
      new Request(
        "https://example.test/api/chats/chat-1/delete-permanently/status?deletionId=deletion-1"
      ),
      context
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      cleanupComplete: false,
      deletionId: "deletion-1",
      state: "PENDING"
    }));
    const invalid = await createPermanentChatDeleteStatusHandler(deps.deps)(
      new Request(
        "https://example.test/api/chats/chat-1/delete-permanently/status?deletionId=deletion-1&extra=1"
      ),
      context
    );
    expect(invalid.status).toBe(400);
  });
});
