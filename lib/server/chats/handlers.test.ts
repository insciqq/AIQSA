import { describe, expect, it } from "vitest";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "../auth/testRequestAuth";
import {
  createArchiveChatHandler,
  createCreateChatHandler,
  createDeleteFolderHandler,
  createGetChatHandler,
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

describe("chat route handlers", () => {
  it("creates generic new chats unfiled unless a folder is explicitly provided", async () => {
    const createInputs: Parameters<ChatRepository["createChat"]>[0][] = [];
    const repository: ChatRepository = {
      archiveChat: async () => false,
      createChat: async (input) => {
        createInputs.push(input);
        return {
          activeLeafMessageId: null,
          createdAt: "2026-06-09T00:00:00.000Z",
          defaultModelId: null,
          defaultPromptPresetId: null,
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

    expect(genericResponse.status).toBe(201);
    expect(folderResponse.status).toBe(201);
    expect(createInputs.map((input) => input.folderId)).toEqual([null, "folder-1"]);
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
            defaultPromptPresetId: null,
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
            defaultPromptPresetId: null,
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
      archiveChat: async () => false,
      createChat: async () => null,
      createFolder: async () => null,
      deleteFolder: async () => false,
      getChat: async () => ({
        activeLeafMessageId: "assistant-message-1",
        createdAt: "2026-06-07T09:00:00.000Z",
        defaultModelId: "google/gemini-3.5-flash",
        defaultPromptPresetId: null,
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

  it("renames an owned folder", async () => {
    let updateInput: Parameters<ChatRepository["updateFolder"]>[0] | null = null;
    const repository: ChatRepository = {
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
          defaultPromptPresetId: null,
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

  it("returns a stable conflict for active-leaf checkout and archive during an active run", async () => {
    const repository: ChatRepository = {
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
