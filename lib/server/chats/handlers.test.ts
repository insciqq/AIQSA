import { describe, expect, it } from "vitest";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "../auth/testRequestAuth";
import {
  createArchiveChatHandler,
  createCreateChatHandler,
  createDeleteFolderHandler,
  createGetChatBranchesHandler,
  createGetChatHandler,
  createGetChatMessagesPageHandler,
  createListChatsHandler,
  createUpdateChatHandler,
  createUpdateFolderHandler,
  type ChatRepository
} from "./handlers";
import { ActiveRunConflictError } from "../runs/runRepositoryContract";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: "token",
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({
  user: {
    id: config.bootstrapUserId
  }
});

function authCookie() {
  return auth.cookie;
}

const historyRepositoryMethods: Pick<
  ChatRepository,
  "getBranches" | "getMessagesPage"
> = {
  getBranches: async () => null,
  getMessagesPage: async () => ({ kind: "not_found" })
};

describe("chat route handlers", () => {
  it("creates generic new chats unfiled unless a folder is explicitly provided", async () => {
    const createInputs: Parameters<ChatRepository["createChat"]>[0][] = [];
    const repository: ChatRepository = {
      ...historyRepositoryMethods,
      archiveChat: async () => false,
      createChat: async (input) => {
        createInputs.push(input);
        return {
          activeLeafMessageId: null,
          createdAt: "2026-06-09T00:00:00.000Z",
          defaultModelId: null,
          defaultProvider: null,
          folderId: input.folderId ?? null,
          id: `chat-${createInputs.length}`,
          messageCount: 0,
          pinned: false,
          title: "New Chat",
          updatedAt: "2026-06-09T00:00:00.000Z"
        };
      },
      createFolder: async () => null,
      deleteFolder: async () => false,
      getChat: async () => null,
      listWorkspace: async () => null,
      searchChatContent: async () => [],
      updateChat: async () => null,
      updateFolder: async () => null
    };
    const POST = createCreateChatHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const genericResponse = await POST(
      new Request("http://app.local/api/chats", {
        body: JSON.stringify({}),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      })
    );
    const folderResponse = await POST(
      new Request("http://app.local/api/chats", {
        body: JSON.stringify({ folderId: "folder-1" }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      })
    );
    const excludedResponse = await POST(
      new Request("http://app.local/api/chats", {
        body: JSON.stringify({ memoryMode: "EXCLUDED" }),
        headers: { cookie: authCookie() },
        method: "POST"
      })
    );
    const invalidModeResponse = await POST(
      new Request("http://app.local/api/chats", {
        body: JSON.stringify({ memoryMode: "TEMPORARY" }),
        headers: { cookie: authCookie() },
        method: "POST"
      })
    );

    expect(genericResponse.status).toBe(201);
    expect(folderResponse.status).toBe(201);
    expect(excludedResponse.status).toBe(201);
    expect(invalidModeResponse.status).toBe(400);
    await expect(invalidModeResponse.json()).resolves.toEqual({
      error: "chat_memory_mode_invalid"
    });
    expect(createInputs.map((input) => input.folderId)).toEqual([null, "folder-1", null]);
    expect(createInputs.map((input) => input.memoryMode)).toEqual([
      undefined,
      undefined,
      "EXCLUDED"
    ]);
    for (const response of [genericResponse, folderResponse]) {
      const chat = (await response.json()).chat as Record<string, unknown>;
      expect(chat).toMatchObject({
        defaultModelId: null,
        defaultProvider: null,
        messageCount: 0,
        pinned: false
      });
      expect(chat).not.toHaveProperty("messages");
      expect(chat).not.toHaveProperty("usageStats");
    }
  });

  it("keeps the workspace list lightweight without message payloads", async () => {
    const repository: ChatRepository = {
      ...historyRepositoryMethods,
      archiveChat: async () => false,
      createChat: async () => null,
      createFolder: async () => null,
      deleteFolder: async () => false,
      getChat: async () => null,
      listWorkspace: async () => ({
        chats: [
          {
            activeLeafMessageId: "assistant-message-1",
            createdAt: "2026-06-07T09:00:00.000Z",
            defaultModelId: "gpt-5.5",
            defaultProvider: "openai",
            folderId: null,
            id: "chat-1",
            messageCount: 1,
            pinned: false,
            title: "Background run",
            updatedAt: "2026-06-07T09:00:02.000Z"
          }
        ],
        folders: []
      }),
      searchChatContent: async () => [],
      updateFolder: async () => null,
      updateChat: async () => null
    };
    const GET = createListChatsHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(
      new Request("http://app.local/api/chats", {
        headers: {
          cookie: authCookie()
        }
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      chats: [
        {
          id: "chat-1",
          messageCount: 1
        }
      ],
      contentMatches: []
    });
    expect(body.chats[0]).not.toHaveProperty("messages");
    expect(body.chats[0]).not.toHaveProperty("usageStats");
  });

  it("returns capped current-user content match ids for workspace search", async () => {
    let searchInput: Parameters<ChatRepository["searchChatContent"]>[0] | null = null;
    const repository: ChatRepository = {
      ...historyRepositoryMethods,
      archiveChat: async () => false,
      createChat: async () => null,
      createFolder: async () => null,
      deleteFolder: async () => false,
      getChat: async () => null,
      listWorkspace: async () => ({
        chats: [
          {
            activeLeafMessageId: null,
            createdAt: "2026-06-07T09:00:00.000Z",
            defaultModelId: "gpt-5.5",
            defaultProvider: "openai",
            folderId: null,
            id: "chat-1",
            messageCount: 2,
            pinned: false,
            title: "Old imported notes",
            updatedAt: "2026-06-07T09:00:02.000Z"
          }
        ],
        folders: []
      }),
      searchChatContent: async (input) => {
        searchInput = input;

        return [
          {
            chatId: "chat-1",
            snippet: "buried phrase in a never loaded chat"
          }
        ];
      },
      updateFolder: async () => null,
      updateChat: async () => null
    };
    const GET = createListChatsHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(
      new Request("http://app.local/api/chats?q=%20buried%20phrase%20", {
        headers: {
          cookie: authCookie()
        }
      })
    );

    expect(response.status).toBe(200);
    expect(searchInput).toEqual({
      limit: 50,
      query: "buried phrase",
      userId: config.bootstrapUserId
    });
    const body = await response.json();
    expect(body).toMatchObject({
      chats: [
        {
          id: "chat-1"
        }
      ],
      contentMatches: [
        {
          chatId: "chat-1",
          snippet: "buried phrase in a never loaded chat"
        }
      ]
    });
    expect(body.chats[0]).not.toHaveProperty("messages");
    expect(body.chats[0]).not.toHaveProperty("usageStats");
  });

  it("includes the latest assistant model run id in chat details", async () => {
    const repository: ChatRepository = {
      ...historyRepositoryMethods,
      archiveChat: async () => false,
      createChat: async () => null,
      createFolder: async () => null,
      deleteFolder: async () => false,
      getChat: async () => ({
        activeLeafMessageId: "assistant-message-1",
        contextStats: { approximateActiveBranchInputTokens: 11 },
        createdAt: "2026-06-07T09:00:00.000Z",
        defaultModelId: "google/gemini-3.5-flash",
        defaultProvider: "openrouter",
        folderId: null,
        id: "chat-1",
        messageCount: 1,
        messages: [
          {
            content: {
              blocks: [{ text: "", type: "text" }]
            },
            createdAt: "2026-06-07T09:00:01.000Z",
            errorMessage: "No endpoints found for model.",
            id: "assistant-message-1",
            modelId: "google/gemini-3.5-flash",
            modelRunId: "run-1",
            parentMessageId: "user-message-1",
            provider: "openrouter",
            role: "assistant",
            status: "error"
          }
        ],
        pageInfo: {
          activeLeafMessageId: "assistant-message-1",
          beforeCursor: "opaque-cursor",
          hasOlder: true,
          snapshotUpdatedAt: "2026-06-07T09:00:02.000Z"
        },
        pinned: false,
        title: "Provider error",
        updatedAt: "2026-06-07T09:00:02.000Z",
        usageStats: {
          activeBranchMessageCount: 2,
          cachedInputTokens: 4,
          cacheWriteInputTokens: 1,
          totalTokens: 19
        }
      }),
      listWorkspace: async () => null,
      searchChatContent: async () => [],
      updateFolder: async () => null,
      updateChat: async () => null
    };
    const GET = createGetChatHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(
      new Request("http://app.local/api/chats/chat-1", {
        headers: {
          cookie: authCookie()
        }
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      chat: {
        usageStats: {
          activeBranchMessageCount: 2,
          cachedInputTokens: 4,
          cacheWriteInputTokens: 1,
          totalTokens: 19
        },
        messages: [
          {
            errorMessage: "No endpoints found for model.",
            id: "assistant-message-1",
            modelRunId: "run-1",
            status: "error"
          }
        ]
      }
    });
  });

  it("loads an owned older page by opaque cursor and preserves forward order", async () => {
    let received: Parameters<ChatRepository["getMessagesPage"]>[0] | null = null;
    const repository: ChatRepository = {
      ...historyRepositoryMethods,
      archiveChat: async () => false,
      createChat: async () => null,
      createFolder: async () => null,
      deleteFolder: async () => false,
      getChat: async () => null,
      getMessagesPage: async (input) => {
        received = input;
        return {
          kind: "ok",
          page: {
            messages: [
              {
                content: { blocks: [{ text: "Older", type: "text" }] },
                createdAt: "2026-06-07T08:00:00.000Z",
                id: "message-older",
                modelId: null,
                parentMessageId: null,
                provider: null,
                role: "user",
                status: "complete"
              }
            ],
            pageInfo: {
              activeLeafMessageId: "message-newest",
              beforeCursor: null,
              hasOlder: false,
              snapshotUpdatedAt: "2026-06-07T09:00:02.000Z"
            }
          }
        };
      },
      listWorkspace: async () => null,
      searchChatContent: async () => [],
      updateChat: async () => null,
      updateFolder: async () => null
    };
    const GET = createGetChatMessagesPageHandler({ repository, resolveAuth: auth.resolveAuth });
    const response = await GET(new Request(
      "http://app.local/api/chats/chat-1/messages?before=opaque-cursor",
      { headers: { cookie: authCookie() } }
    ), { params: { chatId: "chat-1" } });

    expect(response.status).toBe(200);
    expect(received).toEqual({
      before: "opaque-cursor",
      chatId: "chat-1",
      userId: config.bootstrapUserId
    });
    await expect(response.json()).resolves.toMatchObject({
      messages: [{ id: "message-older" }],
      pageInfo: { hasOlder: false }
    });
  });

  it("types missing, invalid, and stale older-page cursors", async () => {
    const repository: ChatRepository = {
      ...historyRepositoryMethods,
      archiveChat: async () => false,
      createChat: async () => null,
      createFolder: async () => null,
      deleteFolder: async () => false,
      getChat: async () => null,
      getMessagesPage: async ({ before }) => ({ kind: before === "stale" ? "stale" : "cursor_invalid" }),
      listWorkspace: async () => null,
      searchChatContent: async () => [],
      updateChat: async () => null,
      updateFolder: async () => null
    };
    const GET = createGetChatMessagesPageHandler({ repository, resolveAuth: auth.resolveAuth });
    for (const [url, status, error] of [
      ["http://app.local/api/chats/chat-1/messages", 400, "chat_page_cursor_invalid"],
      ["http://app.local/api/chats/chat-1/messages?before=bad", 400, "chat_page_cursor_invalid"],
      ["http://app.local/api/chats/chat-1/messages?before=stale", 409, "chat_page_stale"]
    ] as const) {
      const response = await GET(new Request(url, { headers: { cookie: authCookie() } }), {
        params: { chatId: "chat-1" }
      });
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error });
    }
  });

  it("returns a separate current-user compact branch graph", async () => {
    let received: Parameters<ChatRepository["getBranches"]>[0] | null = null;
    const repository: ChatRepository = {
      ...historyRepositoryMethods,
      archiveChat: async () => false,
      createChat: async () => null,
      createFolder: async () => null,
      deleteFolder: async () => false,
      getBranches: async (input) => {
        received = input;
        return {
          activeLeafMessageId: "assistant-a",
          nodes: [{
            id: "assistant-a",
            parentMessageId: null,
            preview: "Bounded answer",
            role: "assistant",
            status: "complete"
          }],
          snapshotUpdatedAt: "2026-06-07T09:00:02.000Z"
        };
      },
      getChat: async () => null,
      listWorkspace: async () => null,
      searchChatContent: async () => [],
      updateChat: async () => null,
      updateFolder: async () => null
    };
    const GET = createGetChatBranchesHandler({ repository, resolveAuth: auth.resolveAuth });
    const response = await GET(new Request("http://app.local/api/chats/chat-1/branches", {
      headers: { cookie: authCookie() }
    }), { params: { chatId: "chat-1" } });

    expect(received).toEqual({ chatId: "chat-1", userId: config.bootstrapUserId });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      branchGraph: { nodes: [{ preview: "Bounded answer" }] }
    });
  });

  it("renames an owned folder", async () => {
    let updateInput: Parameters<ChatRepository["updateFolder"]>[0] | null = null;
    const repository: ChatRepository = {
      ...historyRepositoryMethods,
      archiveChat: async () => false,
      createChat: async () => null,
      createFolder: async () => null,
      deleteFolder: async () => false,
      getChat: async () => null,
      listWorkspace: async () => null,
      searchChatContent: async () => [],
      updateChat: async () => null,
      updateFolder: async (input) => {
        updateInput = input;

        return {
          id: input.folderId,
          name: input.name ?? "Renamed Folder",
          parentId: null,
          projectMemory: "",
          sortOrder: 20
        };
      }
    };
    const PATCH = createUpdateFolderHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await PATCH(
      new Request("http://app.local/api/folders/folder-1", {
        body: JSON.stringify({ name: "Renamed Folder" }),
        headers: {
          cookie: authCookie()
        },
        method: "PATCH"
      }),
      {
        params: {
          folderId: "folder-1"
        }
      }
    );

    expect(response.status).toBe(200);
    expect(updateInput).toMatchObject({
      folderId: "folder-1",
      name: "Renamed Folder",
      userId: config.bootstrapUserId
    });
    await expect(response.json()).resolves.toMatchObject({
      folder: {
        id: "folder-1",
        name: "Renamed Folder",
        parentId: null,
        projectMemory: ""
      }
    });
  });

  it("deletes an owned folder", async () => {
    let deletedFolderId: string | null = null;
    const repository: ChatRepository = {
      ...historyRepositoryMethods,
      archiveChat: async () => false,
      createChat: async () => null,
      createFolder: async () => null,
      deleteFolder: async (input) => {
        deletedFolderId = input.folderId;
        return true;
      },
      getChat: async () => null,
      listWorkspace: async () => null,
      searchChatContent: async () => [],
      updateChat: async () => null,
      updateFolder: async () => null
    };
    const DELETE = createDeleteFolderHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await DELETE(
      new Request("http://app.local/api/folders/folder-1", {
        headers: {
          cookie: authCookie()
        },
        method: "DELETE"
      }),
      {
        params: {
          folderId: "folder-1"
        }
      }
    );

    expect(response.status).toBe(200);
    expect(deletedFolderId).toBe("folder-1");
    await expect(response.json()).resolves.toEqual({
      folder: {
        deleted: true,
        id: "folder-1"
      }
    });
  });

  it("updates the active leaf for branch checkout", async () => {
    let updateInput: Parameters<ChatRepository["updateChat"]>[0] | null = null;
    const repository: ChatRepository = {
      ...historyRepositoryMethods,
      archiveChat: async () => false,
      createChat: async () => null,
      createFolder: async () => null,
      deleteFolder: async () => false,
      getChat: async () => null,
      listWorkspace: async () => null,
      searchChatContent: async () => [],
      updateChat: async (input) => {
        updateInput = input;
        return {
          activeLeafMessageId: input.activeLeafMessageId ?? null,
          createdAt: "2026-06-07T09:00:00.000Z",
          defaultModelId: "fake-qsa",
          defaultProvider: "fake",
          folderId: null,
          id: input.chatId,
          messageCount: 2,
          pinned: false,
          title: "Branching",
          updatedAt: "2026-06-07T09:00:01.000Z"
        };
      },
      updateFolder: async () => null
    };
    const PATCH = createUpdateChatHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await PATCH(
      new Request("http://app.local/api/chats/chat-1", {
        body: JSON.stringify({ activeLeafMessageId: "message-2" }),
        headers: {
          cookie: authCookie()
        },
        method: "PATCH"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    expect(updateInput).toMatchObject({
      activeLeafMessageId: "message-2",
      chatId: "chat-1",
      userId: config.bootstrapUserId
    });
    const body = await response.json();
    expect(body).toMatchObject({
      chat: {
        activeLeafMessageId: "message-2",
        id: "chat-1"
      }
    });
    expect(body.chat).not.toHaveProperty("messages");
    expect(body.chat).not.toHaveProperty("usageStats");
  });

  it("validates and persists nullable chat and folder Knowledge defaults", async () => {
    let chatDefault: Parameters<ChatRepository["updateChat"]>[0]["defaultKnowledgePlan"];
    let folderDefault: Parameters<ChatRepository["updateFolder"]>[0]["defaultKnowledgePlan"];
    const repository: ChatRepository = {
      ...historyRepositoryMethods,
      archiveChat: async () => false,
      createChat: async () => null,
      createFolder: async () => null,
      deleteFolder: async () => false,
      getChat: async () => null,
      listWorkspace: async () => null,
      searchChatContent: async () => [],
      updateChat: async (input) => {
        chatDefault = input.defaultKnowledgePlan;
        return {
          activeLeafMessageId: null,
          createdAt: "2026-08-08T00:00:00.000Z",
          defaultKnowledgePlan: input.defaultKnowledgePlan ?? null,
          defaultModelId: "fake-qsa",
          defaultProvider: "fake",
          folderId: null,
          id: input.chatId,
          messageCount: 0,
          pinned: false,
          title: "Knowledge",
          updatedAt: "2026-08-08T00:00:00.000Z"
        };
      },
      updateFolder: async (input) => {
        folderDefault = input.defaultKnowledgePlan;
        return {
          defaultKnowledgePlan: input.defaultKnowledgePlan ?? null,
          id: input.folderId,
          name: "Project",
          parentId: null,
          projectMemory: "",
          sortOrder: 10
        };
      }
    };
    const chatPatch = createUpdateChatHandler({ repository, resolveAuth: auth.resolveAuth });
    const folderPatch = createUpdateFolderHandler({ repository, resolveAuth: auth.resolveAuth });
    const chatResponse = await chatPatch(
      new Request("http://app.local/api/chats/chat-1", {
        body: JSON.stringify({ defaultKnowledgePlan: { baseIds: ["base-1", "base-2"] } }),
        headers: { cookie: authCookie() },
        method: "PATCH"
      }),
      { params: { chatId: "chat-1" } }
    );
    const folderResponse = await folderPatch(
      new Request("http://app.local/api/folders/folder-1", {
        body: JSON.stringify({ defaultKnowledgePlan: null }),
        headers: { cookie: authCookie() },
        method: "PATCH"
      }),
      { params: { folderId: "folder-1" } }
    );

    expect(chatResponse.status).toBe(200);
    expect(folderResponse.status).toBe(200);
    expect(chatDefault).toEqual({ baseIds: ["base-1", "base-2"] });
    expect(folderDefault).toBeNull();
  });

  it("rejects malformed Knowledge defaults before repository mutation", async () => {
    let called = false;
    const repository: ChatRepository = {
      ...historyRepositoryMethods,
      archiveChat: async () => false,
      createChat: async () => null,
      createFolder: async () => null,
      deleteFolder: async () => false,
      getChat: async () => null,
      listWorkspace: async () => null,
      searchChatContent: async () => [],
      updateChat: async () => { called = true; return null; },
      updateFolder: async () => { called = true; return null; }
    };
    const response = await createUpdateChatHandler({ repository, resolveAuth: auth.resolveAuth })(
      new Request("http://app.local/api/chats/chat-1", {
        body: JSON.stringify({ defaultKnowledgePlan: { baseIds: ["same", "same"] } }),
        headers: { cookie: authCookie() },
        method: "PATCH"
      }),
      { params: { chatId: "chat-1" } }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "knowledge_plan_invalid" });
    expect(called).toBe(false);
  });

  it("returns a stable conflict for active-leaf checkout and archive during an active run", async () => {
    const repository: ChatRepository = {
      ...historyRepositoryMethods,
      archiveChat: async () => {
        throw new ActiveRunConflictError();
      },
      createChat: async () => null,
      createFolder: async () => null,
      deleteFolder: async () => false,
      getChat: async () => null,
      listWorkspace: async () => null,
      searchChatContent: async () => [],
      updateChat: async () => {
        throw new ActiveRunConflictError();
      },
      updateFolder: async () => null
    };
    const PATCH = createUpdateChatHandler({ repository, resolveAuth: auth.resolveAuth });
    const DELETE = createArchiveChatHandler({ repository, resolveAuth: auth.resolveAuth });

    const patchResponse = await PATCH(
      new Request("http://app.local/api/chats/chat-1", {
        body: JSON.stringify({ activeLeafMessageId: "message-2" }),
        headers: { cookie: authCookie() },
        method: "PATCH"
      }),
      { params: { chatId: "chat-1" } }
    );
    const deleteResponse = await DELETE(
      new Request("http://app.local/api/chats/chat-1", {
        headers: { cookie: authCookie() },
        method: "DELETE"
      }),
      { params: { chatId: "chat-1" } }
    );

    expect(patchResponse.status).toBe(409);
    await expect(patchResponse.json()).resolves.toEqual({ error: "active_run_in_progress" });
    expect(deleteResponse.status).toBe(409);
    await expect(deleteResponse.json()).resolves.toEqual({ error: "active_run_in_progress" });
  });

  it("rejects updates for archived chats using the normal not-found response", async () => {
    const repository: ChatRepository = {
      ...historyRepositoryMethods,
      archiveChat: async () => false,
      createChat: async () => null,
      createFolder: async () => null,
      deleteFolder: async () => false,
      getChat: async () => null,
      listWorkspace: async () => null,
      searchChatContent: async () => [],
      updateChat: async () => null,
      updateFolder: async () => null
    };
    const PATCH = createUpdateChatHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await PATCH(
      new Request("http://app.local/api/chats/chat-archived", {
        body: JSON.stringify({ title: "Should not update" }),
        headers: {
          cookie: authCookie()
        },
        method: "PATCH"
      }),
      {
        params: {
          chatId: "chat-archived"
        }
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "chat_not_found"
    });
  });
});
