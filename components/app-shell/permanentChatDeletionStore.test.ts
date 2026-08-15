import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySettingsFixture } from "@/tests/support/memoryFixtures";
import { useMemorySettingsStore } from "./memorySettingsStore";
import { activatePermanentChatDeletionAccount, confirmPermanentChatDeletion, deactivatePermanentChatDeletionAccount, openPermanentChatDeletion, setPermanentChatDeletionOriginForget, usePermanentChatDeletionStore } from "./permanentChatDeletionStore";
import { resetMemorySettingsStoreForTest, resetPermanentChatDeletionStoreForTest } from "@/tests/support/appShellStores";

const now = "2026-08-12T10:00:00.000Z";

function message() {
  return {
    artifactSummary: null,
    content: { blocks: [{ text: "Private text", type: "text" }] },
    createdAt: now,
    errorMessage: null,
    id: "message-1",
    modelId: null,
    modelRunId: null,
    parentMessageId: null,
    provider: null,
    role: "user",
    status: "complete"
  };
}

function detail() {
  return {
    chat: {
      activeLeafMessageId: "message-1",
      contextStats: { approximateActiveBranchInputTokens: 2 },
      createdAt: now,
      defaultKnowledgePlan: null,
      defaultModelId: null,
      defaultProvider: null,
      folderId: null,
      id: "chat-1",
      messageCount: 1,
      messages: [message()],
      pageInfo: {
        activeLeafMessageId: "message-1",
        beforeCursor: null,
        hasOlder: false,
        snapshotUpdatedAt: now
      },
      pinned: false,
      title: "Private chat",
      updatedAt: now,
      usageStats: null
    }
  };
}

function lifecycle(sourceRevision = 4) {
  return {
    chat: {
      archived: false,
      chatId: "chat-1",
      mode: "NORMAL",
      sourceRevision,
      temporaryRetentionDeadline: null,
      temporaryRetentionPolicyVersion: null,
      updatedAt: now
    }
  };
}

beforeEach(() => {
  resetPermanentChatDeletionStoreForTest();
  resetMemorySettingsStoreForTest();
  window.sessionStorage.clear();
  useMemorySettingsStore.setState({
    data: memorySettingsFixture({
      capabilities: { permanentChatDeletion: true }
    }),
    error: null,
    loadState: "ready"
  });
});

afterEach(() => {
  resetPermanentChatDeletionStoreForTest();
  resetMemorySettingsStoreForTest();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("permanent chat deletion store", () => {
  it("binds the fresh snapshot and explicit origin-memory choice, then restores opaque status", async () => {
    const reconciled = vi.fn();
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/memory-mode")) return Response.json(lifecycle());
      if (path === "/api/chats/chat-1") return Response.json(detail());
      if (path.endsWith("/authorization")) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({
          expiresAt: "2026-08-12T10:05:00.000Z",
          mutationAuthorizationId: "authorization-1"
        });
      }
      if (path.endsWith("/delete-permanently")) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ deletionId: "deletion-1", fencedAt: now, state: "PENDING" });
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
      return Response.json({ error: "unexpected_request" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await activatePermanentChatDeletionAccount("account-a", reconciled);
    openPermanentChatDeletion({
      chatId: "chat-1",
      expectedActiveLeafMessageId: "message-1",
      expectedChatRevision: 4,
      location: "WORKSPACE",
      title: "Private chat"
    });
    setPermanentChatDeletionOriginForget(true);
    await confirmPermanentChatDeletion();

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      alsoForgetOriginMemories: true,
      expectedActiveLeafMessageId: "message-1",
      expectedChatRevision: 4
    });
    expect(bodies[1]).toEqual({
      alsoForgetOriginMemories: true,
      expectedActiveLeafMessageId: "message-1",
      expectedChatRevision: 4,
      mutationAuthorizationId: "authorization-1"
    });
    expect(reconciled).toHaveBeenCalledWith("chat-1");
    expect(usePermanentChatDeletionStore.getState()).toMatchObject({
      reference: { chatId: "chat-1", deletionId: "deletion-1" },
      status: { state: "RUNNING" },
      statusOpen: true,
      target: null
    });
    expect(window.sessionStorage.getItem(
      "aiqsa:chat-permanent-deletion:v1:account-a"
    )).toBe(JSON.stringify({ chatId: "chat-1", deletionId: "deletion-1", version: 1 }));

    deactivatePermanentChatDeletionAccount("account-a");
    await activatePermanentChatDeletionAccount("account-a");
    expect(usePermanentChatDeletionStore.getState().status).toMatchObject({ state: "RUNNING" });
    await activatePermanentChatDeletionAccount("account-b");
    expect(usePermanentChatDeletionStore.getState()).toMatchObject({
      accountId: "account-b",
      reference: null,
      status: null
    });
  });

  it("requires a second confirmation after a fresh snapshot differs and never authorizes stale state", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/memory-mode")) return Response.json(lifecycle(5));
      if (path === "/api/chats/chat-1") return Response.json(detail());
      return Response.json({ error: "unexpected_authorization" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await activatePermanentChatDeletionAccount("account-a");
    openPermanentChatDeletion({
      chatId: "chat-1",
      expectedActiveLeafMessageId: "message-1",
      expectedChatRevision: 4,
      location: "WORKSPACE",
      title: "Private chat"
    });

    await confirmPermanentChatDeletion();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(usePermanentChatDeletionStore.getState()).toMatchObject({
      busy: false,
      confirmationError: "chat_permanent_delete_stale_review_required",
      target: { expectedChatRevision: 5 }
    });
  });

  it("keeps the workflow unavailable when the server capability is dark", async () => {
    useMemorySettingsStore.setState({
      data: memorySettingsFixture({
        capabilities: { permanentChatDeletion: false }
      })
    });
    await activatePermanentChatDeletionAccount("account-a");
    openPermanentChatDeletion({
      chatId: "chat-1",
      expectedActiveLeafMessageId: "message-1",
      expectedChatRevision: 4,
      location: "WORKSPACE",
      title: "Private chat"
    });
    expect(usePermanentChatDeletionStore.getState().target).toBeNull();
  });
});
