import { describe, expect, it, vi } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../../contracts/memory";
import {
  createPermanentChatDeleteConsumerHandler,
  createPermanentChatDeleteStatusHandler,
  type PermanentChatDeletionHandlerDeps
} from "./handlers";
import { PermanentChatDeletionError } from "./service";

function dependencies(input: Readonly<{ authenticated?: boolean; enabled?: boolean }> = {}) {
  const service = {
    confirm: vi.fn(async () => ({ status: "IN_PROGRESS" as const })),
    consumerStatus: vi.fn(async () => ({ status: "IN_PROGRESS" as const }))
  };
  const check = vi.fn(async () => ({
    allowed: true as const,
    retryAfterSeconds: 0
  }));
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
    const response = await createPermanentChatDeleteConsumerHandler(unavailable.deps)(
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
    expect(unavailable.service.confirm).not.toHaveBeenCalled();

    const anonymous = dependencies({ authenticated: false, enabled: false });
    const anonymousResponse = await createPermanentChatDeleteConsumerHandler(
      anonymous.deps
    )(new Request("https://example.test/api/chats/chat-1/delete-permanently", {
      method: "POST"
    }), context);
    expect(anonymousResponse.status).toBe(401);
  });

  it("accepts one consumer-safe confirmation and rejects internal fields", async () => {
    const deps = dependencies();
    const confirmation = await createPermanentChatDeleteConsumerHandler(deps.deps)(
      new Request("https://example.test/api/chats/chat-1/delete-permanently", {
        body: JSON.stringify({
          alsoForgetOriginMemories: false,
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          requestId: "request-1"
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }),
      context
    );
    expect(confirmation.status).toBe(202);
    expect(await confirmation.json()).toEqual({ status: "IN_PROGRESS" });
    expect(deps.service.confirm).toHaveBeenCalledWith("user-1", "chat-1", {
      alsoForgetOriginMemories: false,
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      requestId: "request-1"
    });

    const invalid = await createPermanentChatDeleteConsumerHandler(deps.deps)(
      new Request("https://example.test/api/chats/chat-1/delete-permanently", {
        body: JSON.stringify({
          alsoForgetOriginMemories: false,
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          expectedChatRevision: 2,
          requestId: "request-1"
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }),
      context
    );
    expect(invalid.status).toBe(400);
  });

  it("returns only a friendly chat-keyed status without query identifiers", async () => {
    const deps = dependencies({ enabled: false });
    const response = await createPermanentChatDeleteStatusHandler(deps.deps)(
      new Request(
        "https://example.test/api/chats/chat-1/delete-permanently/status"
      ),
      context
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "IN_PROGRESS" });
    expect(deps.service.consumerStatus).toHaveBeenCalledWith("user-1", "chat-1");
    const invalid = await createPermanentChatDeleteStatusHandler(deps.deps)(
      new Request(
        "https://example.test/api/chats/chat-1/delete-permanently/status?deletionId=deletion-1"
      ),
      context
    );
    expect(invalid.status).toBe(400);
  });

  it("maps internal failures to a bounded consumer reason", async () => {
    const deps = dependencies();
    deps.service.confirm.mockRejectedValueOnce(
      new PermanentChatDeletionError("chat_permanent_delete_stale")
    );
    const response = await createPermanentChatDeleteConsumerHandler(deps.deps)(
      new Request("https://example.test/api/chats/chat-1/delete-permanently", {
        body: JSON.stringify({
          alsoForgetOriginMemories: false,
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          requestId: "request-1"
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }),
      context
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "CHANGED" });
  });
});
