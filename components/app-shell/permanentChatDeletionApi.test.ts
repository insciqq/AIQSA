import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "@/lib/contracts/memoryClient";
import {
  admitPermanentChatDeletion,
  loadPermanentChatDeletionStatus,
  PermanentChatDeletionApiError
} from "./permanentChatDeletionApi";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("permanent chat deletion client", () => {
  it("uses one safe confirmation and a chat-keyed friendly status", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/status")) return Response.json({ status: "COMPLETE" });
      expect(init?.method).toBe("POST");
      return Response.json({ status: "IN_PROGRESS" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const confirmation = {
      alsoForgetOriginMemories: false,
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      requestId: "request-1"
    } as const;
    await expect(admitPermanentChatDeletion("chat/one", confirmation))
      .resolves.toEqual({ status: "IN_PROGRESS" });
    await expect(loadPermanentChatDeletionStatus("chat/one"))
      .resolves.toEqual({ status: "COMPLETE" });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/chats/chat%2Fone/delete-permanently",
      "/api/chats/chat%2Fone/delete-permanently/status"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      ...confirmation
    });
  });

  it("fails closed on malformed success and preserves stable server errors", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        deletionId: "private-id",
        status: "IN_PROGRESS"
      }))
      .mockResolvedValueOnce(Response.json(
        { error: "CHANGED" },
        { status: 409 }
      ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(admitPermanentChatDeletion("chat-1", {
      alsoForgetOriginMemories: false,
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      requestId: "request-1"
    })).rejects.toEqual(expect.objectContaining<Partial<PermanentChatDeletionApiError>>({
      reason: "FAILED",
      status: 502
    }));
    await expect(loadPermanentChatDeletionStatus("chat-1"))
      .rejects.toEqual(expect.objectContaining<Partial<PermanentChatDeletionApiError>>({
        reason: "CHANGED",
        status: 409
      }));
  });
});
