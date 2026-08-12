import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "@/lib/contracts/memory";
import {
  admitPermanentChatDeletion,
  authorizePermanentChatDeletion,
  loadPermanentChatDeletionStatus,
  PermanentChatDeletionApiError
} from "./permanentChatDeletionApi";

const now = "2026-08-12T10:00:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("permanent chat deletion client", () => {
  it("uses distinct exact authorization, admission, and private status wires", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/authorization")) {
        return Response.json({
          expiresAt: "2026-08-12T10:05:00.000Z",
          mutationAuthorizationId: "authorization-1"
        });
      }
      if (path.includes("/status?")) {
        return Response.json({
          attemptCount: 1,
          cleanupComplete: false,
          deletionId: "deletion-1",
          errorCode: null,
          fencedAt: now,
          lastAuditAt: null,
          state: "RUNNING",
          updatedAt: now
        });
      }
      expect(init?.method).toBe("POST");
      return Response.json({ deletionId: "deletion-1", fencedAt: now, state: "PENDING" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const common = {
      alsoForgetOriginMemories: false,
      expectedActiveLeafMessageId: "message-1",
      expectedChatRevision: 4
    } as const;
    const authorization = await authorizePermanentChatDeletion("chat/one", {
      ...common,
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      requestNonce: "nonce-1"
    });
    await admitPermanentChatDeletion("chat/one", {
      ...common,
      mutationAuthorizationId: authorization.mutationAuthorizationId
    });
    await expect(loadPermanentChatDeletionStatus("chat/one", "deletion-1"))
      .resolves.toMatchObject({ state: "RUNNING" });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/chats/chat%2Fone/delete-permanently/authorization",
      "/api/chats/chat%2Fone/delete-permanently",
      "/api/chats/chat%2Fone/delete-permanently/status?deletionId=deletion-1"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      ...common,
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      requestNonce: "nonce-1"
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      ...common,
      mutationAuthorizationId: "authorization-1"
    });
  });

  it("fails closed on malformed success and preserves stable server errors", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ deletionId: "missing-fields" }))
      .mockResolvedValueOnce(Response.json(
        { error: "chat_permanent_delete_stale" },
        { status: 409 }
      ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(admitPermanentChatDeletion("chat-1", {
      alsoForgetOriginMemories: false,
      expectedActiveLeafMessageId: null,
      expectedChatRevision: 0,
      mutationAuthorizationId: "authorization-1"
    })).rejects.toEqual(expect.objectContaining<Partial<PermanentChatDeletionApiError>>({
      code: "chat_permanent_delete_response_invalid",
      status: 502
    }));
    await expect(loadPermanentChatDeletionStatus("chat-1", "deletion-1"))
      .rejects.toEqual(expect.objectContaining<Partial<PermanentChatDeletionApiError>>({
        code: "chat_permanent_delete_stale",
        status: 409
      }));
  });
});
