import { describe, expect, it, vi } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../contracts/memory";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "@/tests/support/auth";
import { ActiveRunConflictError } from "../runs/runRepositoryContract";
import {
  createArchiveChatExplicitHandler,
  createGetArchivedChatHandler,
  createGetArchivedChatMessagesPageHandler,
  createGetChatMemoryModeHandler,
  createListArchivedChatsHandler,
  createPatchChatMemoryModeHandler,
  createResolveChatSourceHandler,
  createRestoreChatHandler,
  type ChatLifecycleRepository
} from "./lifecycleHandlers";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: "token",
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({ user: { id: config.bootstrapUserId } });
const updatedAt = "2026-08-10T08:00:00.000Z";

const archivedSummary = {
  activeLeafMessageId: "message-1",
  archived: true as const,
  createdAt: updatedAt,
  defaultKnowledgePlan: null,
  defaultModelId: null,
  defaultProvider: null,
  folderId: null,
  id: "chat-1",
  memoryMode: "NORMAL" as const,
  messageCount: 1,
  pinned: false,
  sourceRevision: 4,
  title: "Archived source",
  updatedAt
};

const archivedDetail = {
  ...archivedSummary,
  contextStats: { approximateActiveBranchInputTokens: 2 },
  messages: [{
    content: { blocks: [{ text: "Retained", type: "text" }] },
    createdAt: updatedAt,
    id: "message-1",
    modelId: null,
    parentMessageId: null,
    provider: null,
    role: "user",
    status: "complete"
  }],
  pageInfo: {
    activeLeafMessageId: "message-1",
    beforeCursor: null,
    hasOlder: false,
    snapshotUpdatedAt: updatedAt
  },
  usageStats: null
};

function repository(
  overrides: Partial<ChatLifecycleRepository> = {}
): ChatLifecycleRepository {
  return {
    getArchivedChat: async () => null,
    getChatMemoryState: async () => null,
    getArchivedMessagesPage: async () => ({ kind: "not_found" }),
    listArchivedChats: async () => ({ chats: [], kind: "ok", nextCursor: null }),
    resolveChatSource: async () => null,
    setArchived: async () => ({ kind: "not_found" }),
    setMemoryMode: async () => ({ kind: "not_found" }),
    ...overrides
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://app.local${path}`, {
    ...init,
    headers: {
      cookie: auth.cookie,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers
    }
  });
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("vary")).toBe("Cookie");
}

describe("chat lifecycle handlers", () => {
  it("rejects unauthenticated lifecycle reads before repository access with private cache policy", async () => {
    const listArchivedChats = vi.fn<ChatLifecycleRepository["listArchivedChats"]>();
    const response = await createListArchivedChatsHandler({
      repository: repository({ listArchivedChats }),
      resolveAuth: auth.resolveAuth
    })(new Request("http://app.local/api/chats/archived"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(listArchivedChats).not.toHaveBeenCalled();
    expectPrivate(response);
  });

  it("keeps explicit Archive and Restore CAS-shaped and distinct from Archive DELETE", async () => {
    const setArchived = vi.fn<ChatLifecycleRepository["setArchived"]>(async (input) => ({
      chat: {
        archived: input.archived,
        id: input.chatId,
        memoryMode: "NORMAL",
        sourceRevision: input.expectedChatRevision,
        updatedAt
      },
      kind: "ok"
    }));
    const deps = { repository: repository({ setArchived }), resolveAuth: auth.resolveAuth };
    const archive = createArchiveChatExplicitHandler(deps);
    const restore = createRestoreChatHandler(deps);
    const archiveResponse = await archive(request("/api/chats/chat-1/archive", {
      body: JSON.stringify({ expectedChatRevision: 4 }),
      method: "POST"
    }), { params: { chatId: "chat-1" } });
    const restoreResponse = await restore(request("/api/chats/chat-1/restore", {
      body: JSON.stringify({ expectedChatRevision: 4 }),
      method: "POST"
    }), { params: { chatId: "chat-1" } });

    expect(setArchived).toHaveBeenNthCalledWith(1, {
      archived: true,
      chatId: "chat-1",
      expectedChatRevision: 4,
      userId: config.bootstrapUserId
    });
    expect(setArchived).toHaveBeenNthCalledWith(2, {
      archived: false,
      chatId: "chat-1",
      expectedChatRevision: 4,
      userId: config.bootstrapUserId
    });
    expect(await archiveResponse.json()).toMatchObject({ chat: { archived: true } });
    expect(await restoreResponse.json()).toMatchObject({ chat: { archived: false } });
    expectPrivate(archiveResponse);
    expectPrivate(restoreResponse);

    const malformed = await archive(request("/api/chats/chat-1/archive", {
      body: JSON.stringify({ expectedChatRevision: 4, permanentlyDelete: true }),
      method: "POST"
    }), { params: { chatId: "chat-1" } });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: "chat_lifecycle_invalid" });
  });

  it("returns bounded lifecycle conflicts without losing private cache policy", async () => {
    const stale = await createRestoreChatHandler({
      repository: repository({ setArchived: async () => ({ kind: "stale" }) }),
      resolveAuth: auth.resolveAuth
    })(request("/api/chats/chat-1/restore", {
      body: JSON.stringify({ expectedChatRevision: 3 }),
      method: "POST"
    }), { params: { chatId: "chat-1" } });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: "chat_revision_stale" });
    expectPrivate(stale);

    const active = await createArchiveChatExplicitHandler({
      repository: repository({
        setArchived: async () => {
          throw new ActiveRunConflictError();
        }
      }),
      resolveAuth: auth.resolveAuth
    })(request("/api/chats/chat-1/archive", {
      body: JSON.stringify({ expectedChatRevision: 4 }),
      method: "POST"
    }), { params: { chatId: "chat-1" } });
    expect(active.status).toBe(409);
    await expect(active.json()).resolves.toEqual({ error: "active_run_in_progress" });
    expectPrivate(active);
  });

  it("serves Archived list, preview, pages, and source resolution as owner-private reads", async () => {
    const deps = {
      repository: repository({
        getArchivedChat: async () => archivedDetail,
        getArchivedMessagesPage: async () => ({
          kind: "ok",
          page: { messages: archivedDetail.messages, pageInfo: archivedDetail.pageInfo }
        }),
        listArchivedChats: async () => ({
          chats: [archivedSummary],
          kind: "ok",
          nextCursor: "next"
        }),
        resolveChatSource: async () => ({
          chatId: "chat-1",
          location: "ARCHIVED_PREVIEW",
          memoryMode: "NORMAL",
          sourceRevision: 4,
          updatedAt
        })
      }),
      resolveAuth: auth.resolveAuth
    };
    const responses = [
      await createListArchivedChatsHandler(deps)(request("/api/chats/archived")),
      await createGetArchivedChatHandler(deps)(request("/api/chats/chat-1/archive"), {
        params: { chatId: "chat-1" }
      }),
      await createGetArchivedChatMessagesPageHandler(deps)(
        request("/api/chats/chat-1/archive/messages?before=cursor"),
        { params: { chatId: "chat-1" } }
      ),
      await createResolveChatSourceHandler(deps)(request("/api/chats/chat-1/source"), {
        params: { chatId: "chat-1" }
      })
    ];
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    for (const response of responses) expectPrivate(response);
    await expect(responses[0]?.clone().json()).resolves.toMatchObject({
      chats: [{ archived: true, id: "chat-1" }],
      nextCursor: "next"
    });
    await expect(responses[1]?.clone().json()).resolves.toMatchObject({
      chat: { archived: true, messages: [{ id: "message-1" }] }
    });
    await expect(responses[3]?.clone().json()).resolves.toEqual({
      source: {
        chatId: "chat-1",
        location: "ARCHIVED_PREVIEW",
        memoryMode: "NORMAL",
        sourceRevision: 4,
        updatedAt
      }
    });
  });

  it("requires current Resume disclosure and maps source/counter fences", async () => {
    const setMemoryMode = vi.fn<ChatLifecycleRepository["setMemoryMode"]>(async (input) => ({
      kind: "ok",
      response: {
        chatId: input.chatId,
        memoryGeneration: 8,
        memoryRevision: 12,
        mode: input.mode,
        sourceRevision: 5
      }
    }));
    const handler = createPatchChatMemoryModeHandler({
      repository: repository({ setMemoryMode }),
      resolveAuth: auth.resolveAuth
    });
    const undisclosed = await handler(request("/api/me/chats/chat-1/memory-mode", {
      body: JSON.stringify({
        expectedChatRevision: 4,
        expectedMemoryRevision: 11,
        mode: "NORMAL"
      }),
      method: "PATCH"
    }), { params: { chatId: "chat-1" } });
    expect(undisclosed.status).toBe(400);
    expect(setMemoryMode).not.toHaveBeenCalled();

    const resumed = await handler(request("/api/me/chats/chat-1/memory-mode", {
      body: JSON.stringify({
        expectedChatRevision: 4,
        expectedMemoryRevision: 11,
        mode: "NORMAL",
        resumeDisclosureCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION
      }),
      method: "PATCH"
    }), { params: { chatId: "chat-1" } });
    expect(resumed.status).toBe(200);
    await expect(resumed.json()).resolves.toEqual({
      chatId: "chat-1",
      memoryGeneration: 8,
      memoryRevision: 12,
      mode: "NORMAL",
      sourceRevision: 5
    });
    expectPrivate(resumed);

    const blocked = await createPatchChatMemoryModeHandler({
      repository: repository({ setMemoryMode: async () => ({ kind: "resume_blocked" }) }),
      resolveAuth: auth.resolveAuth
    })(request("/api/me/chats/chat-1/memory-mode", {
      body: JSON.stringify({
        expectedChatRevision: 4,
        expectedMemoryRevision: 11,
        mode: "NORMAL",
        resumeDisclosureCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION
      }),
      method: "PATCH"
    }), { params: { chatId: "chat-1" } });
    expect(blocked.status).toBe(503);
    await expect(blocked.json()).resolves.toEqual({ error: "memory_action_failed" });
    expectPrivate(blocked);
  });

  it("reads Temporary mode without reading reusable Memory state", async () => {
    const getChatMemoryState = vi.fn<ChatLifecycleRepository["getChatMemoryState"]>(async () => ({
      archived: false,
      chatId: "chat-temp",
      mode: "TEMPORARY",
      sourceRevision: 1,
      temporaryRetentionDeadline: "2026-08-11T08:00:00.000Z",
      temporaryRetentionPolicyVersion: "temporary-24h-v1",
      updatedAt
    }));
    const response = await createGetChatMemoryModeHandler({
      repository: repository({ getChatMemoryState }),
      resolveAuth: auth.resolveAuth
    })(request("/api/me/chats/chat-temp/memory-mode"), {
      params: { chatId: "chat-temp" }
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      chat: {
        archived: false,
        chatId: "chat-temp",
        mode: "TEMPORARY",
        sourceRevision: 1,
        temporaryRetentionDeadline: "2026-08-11T08:00:00.000Z",
        temporaryRetentionPolicyVersion: "temporary-24h-v1",
        updatedAt
      }
    });
    expect(getChatMemoryState).toHaveBeenCalledWith({
      chatId: "chat-temp",
      userId: config.bootstrapUserId
    });
    expectPrivate(response);
  });
});
