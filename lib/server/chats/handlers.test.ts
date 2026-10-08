import { describe, expect, it } from "vitest";
import { CHAT_TITLE_MAX_LENGTH, PERSONAL_FOLDER_NAME_MAX_LENGTH } from "@/lib/contracts/chats";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "@/tests/support/auth";
import {
  createArchiveChatHandler,
  createCreateChatHandler,
  createCreateFolderHandler,
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
import { ChatAssistantUpdateError } from "./assistantUpdateError";
import { RecoveryStateInvalidError } from "../runs/recoveryStateInvalid";
import { reconcileStaleRuns, type RunRecoveryRegistry, type RunRecoveryRepository } from "../runs/runRecovery";

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
  it("accepts names at the code-point limit intact and rejects longer ones without truncating", async () => {
    const stored: string[] = [];
    const summary = (id: string, title: string) => ({
      activeLeafMessageId: null,
      createdAt: "2026-09-27T00:00:00.000Z",
      defaultModelId: null,
      defaultProvider: null,
      folderId: null,
      id,
      messageCount: 0,
      pinned: false,
      title,
      updatedAt: "2026-09-27T00:00:00.000Z"
    });
    const folderRecord = (id: string, name: string) => ({
      id, name, parentId: null, projectMemory: "", sortOrder: 10
    });
    const repository: ChatRepository = {
      ...historyRepositoryMethods,
      archiveChat: async () => false,
      createChat: async (input) => {
        stored.push(input.title ?? "");
        return summary("chat-1", input.title ?? "New Chat");
      },
      createFolder: async (input) => {
        stored.push(input.name);
        return folderRecord("folder-1", input.name);
      },
      deleteFolder: async () => false,
      getChat: async () => null,
      listWorkspace: async () => null,
      updateChat: async (input) => {
        stored.push(input.title ?? "");
        return summary(input.chatId, input.title ?? "Chat");
      },
      updateFolder: async (input) => {
        stored.push(input.name ?? "");
        return folderRecord(input.folderId, input.name ?? "Folder");
      }
    };
    const deps = { repository, resolveAuth: auth.resolveAuth };
    const request = (path: string, method: string, body: unknown) => new Request(`http://app.local${path}`, {
      body: JSON.stringify(body),
      headers: { cookie: authCookie() },
      method
    });
    // One emoji is one code point but two UTF-16 units: the limit counts code
    // points and a stored name keeps every submitted pair intact.
    const emoji = "😀";
    const title = `${"t".repeat(CHAT_TITLE_MAX_LENGTH - 2)}${emoji}${emoji}`;
    const name = `${"f".repeat(PERSONAL_FOLDER_NAME_MAX_LENGTH - 1)}${emoji}`;
    const longTitle = `${title}x`;
    const longName = `${emoji}${name}`;

    const created = await createCreateChatHandler(deps)(request("/api/chats", "POST", { title: ` ${title} ` }));
    const renamed = await createUpdateChatHandler(deps)(
      request("/api/chats/chat-1", "PATCH", { title }),
      { params: { chatId: "chat-1" } }
    );
    const folder = await createCreateFolderHandler(deps)(request("/api/folders", "POST", { name }));
    const folderRenamed = await createUpdateFolderHandler(deps)(
      request("/api/folders/folder-1", "PATCH", { name }),
      { params: { folderId: "folder-1" } }
    );
    expect([created.status, renamed.status, folder.status, folderRenamed.status]).toEqual([201, 200, 201, 200]);
    expect(stored).toEqual([title, title, name, name]);
    await expect(renamed.json()).resolves.toMatchObject({ chat: { title } });

    stored.length = 0;
    const rejected = [
      await createCreateChatHandler(deps)(request("/api/chats", "POST", { title: longTitle })),
      await createUpdateChatHandler(deps)(
        request("/api/chats/chat-1", "PATCH", { title: longTitle }),
        { params: { chatId: "chat-1" } }
      ),
      await createCreateFolderHandler(deps)(request("/api/folders", "POST", { name: longName })),
      await createUpdateFolderHandler(deps)(
        request("/api/folders/folder-1", "PATCH", { name: longName }),
        { params: { folderId: "folder-1" } }
      )
    ];
    expect(rejected.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    await expect(Promise.all(rejected.map((response) => response.json()))).resolves.toEqual([
      { error: "chat_title_too_long" },
      { error: "chat_title_too_long" },
      { error: "folder_name_too_long" },
      { error: "folder_name_too_long" }
    ]);
    expect(stored).toEqual([]);
  });

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
      folders: []
    });
    expect(body).not.toHaveProperty("contentMatches");
    expect(body.chats[0]).not.toHaveProperty("messages");
    expect(body.chats[0]).not.toHaveProperty("usageStats");
  });

  it("returns the chat history while its stale runs cannot be recovered", async () => {
    const stale = ["run-unavailable", "run-unreadable"].map((id) => ({
      assistantMessageId: `assistant-${id}`, chatId: "chat-1", id, modelId: "model-1", provider: "provider-1",
      providerResponseId: null, status: "streaming", updatedAt: new Date(0)
    }));
    const failed: string[] = [];
    const recoveryRepository = {
      failRun: async (runId: string, _assistantMessageId: string, error: { code: string }) => {
        failed.push(`${runId}:${error.code}`);
        return true;
      },
      findStaleActiveRunsForUser: async (input: { chatId?: string; userId: string }) =>
        input.userId === config.bootstrapUserId && input.chatId === "chat-1" ? stale : [],
      getRunControlForUser: async (runId: string) => stale.find((run) => run.id === runId) ?? null,
      loadCheckpointedToolLoopRun: async ({ runId }: { runId: string }) => {
        if (runId === "run-unreadable") throw new RecoveryStateInvalidError("tool_loop_checkpoint_invalid_in_storage");
        throw new Error("synthetic database timeout");
      }
    } as unknown as RunRecoveryRepository;
    const registry: RunRecoveryRegistry = {
      has: () => false, ids: () => [],
      register: () => ({ release: () => undefined, signal: new AbortController().signal })
    };
    const GET = createGetChatHandler({
      reconcileRuns: (input) => reconcileStaleRuns({ providers: {}, registry, repository: recoveryRepository }, input),
      repository: {
        ...historyRepositoryMethods,
        archiveChat: async () => false,
        createChat: async () => null,
        createFolder: async () => null,
        deleteFolder: async () => false,
        getChat: async ({ chatId, userId }) => chatId === "chat-1" && userId === config.bootstrapUserId ? {
          activeLeafMessageId: "user-message-1",
          contextStats: { approximateActiveBranchInputTokens: 3 },
          createdAt: "2026-06-07T09:00:00.000Z",
          defaultModelId: null,
          defaultProvider: null,
          folderId: null,
          id: "chat-1",
          messageCount: 1,
          messages: [{
            content: { blocks: [{ text: "Saved question", type: "text" }] },
            createdAt: "2026-06-07T09:00:00.000Z",
            id: "user-message-1",
            parentMessageId: null,
            role: "user",
            status: "complete"
          }],
          pageInfo: {
            activeLeafMessageId: "user-message-1",
            beforeCursor: null,
            hasOlder: false,
            snapshotUpdatedAt: "2026-06-07T09:00:00.000Z"
          },
          pinned: false,
          title: "Interrupted chat",
          updatedAt: "2026-06-07T09:00:00.000Z",
          usageStats: {
            estimatedCostMicros: null,
            hasCompletedAnswer: false,
            incompleteRecordCount: 0,
            knownCostRecordCount: 0,
            recordCount: 0,
            totalTokens: 0
          }
        } : null,
        listWorkspace: async () => null,
        updateFolder: async () => null,
        updateChat: async () => null
      },
      resolveAuth: auth.resolveAuth
    });

    const response = await GET(new Request("http://app.local/api/chats/chat-1", { headers: { cookie: authCookie() } }),
      { params: { chatId: "chat-1" } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      chat: { id: "chat-1", messages: [{ content: { blocks: [{ text: "Saved question", type: "text" }] }, id: "user-message-1" }] }
    });
    expect(failed).toEqual(["run-unreadable:tool_loop_checkpoint_invalid_in_storage"]);
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
          hasCompletedAnswer: false,
          incompleteRecordCount: 0,
          recordCount: 2,
          knownCostRecordCount: 0,
          estimatedCostMicros: null,
          totalTokens: 19
        }
      }),
      listWorkspace: async () => null,
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
          hasCompletedAnswer: false,
          incompleteRecordCount: 0,
          recordCount: 2,
          knownCostRecordCount: 0,
          estimatedCostMicros: null,
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
        body: JSON.stringify({
          defaultKnowledgePlan: {
            baseIds: ["base-1", "base-2"],
            mode: "explicit",
            sourceIds: [],
            version: 1
          }
        }),
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
    expect(chatDefault).toEqual({
      baseIds: ["base-1", "base-2"], mode: "explicit", sourceIds: [], version: 1
    });
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
      updateChat: async () => { called = true; return null; },
      updateFolder: async () => { called = true; return null; }
    };
    const response = await createUpdateChatHandler({ repository, resolveAuth: auth.resolveAuth })(
      new Request("http://app.local/api/chats/chat-1", {
        body: JSON.stringify({
          defaultKnowledgePlan: {
            baseIds: ["same", "same"], mode: "explicit", sourceIds: [], version: 1
          }
        }),
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

  it("passes Assistant binding fields through and answers their refusals with stable codes", async () => {
    const calls: Parameters<ChatRepository["updateChat"]>[0][] = [];
    let failure: Error | null = null;
    const repository: ChatRepository = {
      ...historyRepositoryMethods,
      archiveChat: async () => false,
      createChat: async () => null,
      createFolder: async () => null,
      deleteFolder: async () => false,
      getChat: async () => null,
      listWorkspace: async () => null,
      updateChat: async (input) => {
        calls.push(input);
        if (failure) throw failure;
        return {
          activeLeafMessageId: null,
          assistantId: input.assistantId ?? null,
          createdAt: "2026-09-28T00:00:00.000Z",
          defaultModelId: null,
          defaultProvider: null,
          folderId: null,
          id: input.chatId,
          messageCount: 0,
          pinned: false,
          title: "Bound",
          updatedAt: "2026-09-28T00:00:00.000Z"
        };
      },
      updateFolder: async () => null
    };
    const PATCH = createUpdateChatHandler({ repository, resolveAuth: auth.resolveAuth });
    const patch = (body: unknown) => PATCH(
      new Request("http://app.local/api/chats/chat-1", {
        body: JSON.stringify(body),
        headers: { cookie: authCookie() },
        method: "PATCH"
      }),
      { params: { chatId: "chat-1" } }
    );

    const bound = await patch({ assistantId: "assistant-1", unknownKey: true });
    expect(bound.status).toBe(200);
    await expect(bound.json()).resolves.toMatchObject({ chat: { assistantId: "assistant-1", id: "chat-1" } });
    const overrides = await patch({ assistantOverrides: { model: { mode: "model", modelId: "model-2" }, search: null } });
    expect(overrides.status).toBe(200);
    const removed = await patch({ assistantId: null });
    await expect(removed.json()).resolves.toMatchObject({ chat: { assistantId: null } });
    expect(calls.map(({ assistantId, assistantOverrides }) => ({ assistantId, assistantOverrides }))).toEqual([
      { assistantId: "assistant-1", assistantOverrides: undefined },
      { assistantId: undefined, assistantOverrides: { model: { mode: "model", modelId: "model-2" }, search: null } },
      { assistantId: null, assistantOverrides: undefined }
    ]);
    expect(calls[0]).not.toHaveProperty("unknownKey");

    // Malformed values are refused before the repository, never dropped.
    calls.length = 0;
    const malformed = await Promise.all([
      patch({ assistantId: "" }),
      patch({ assistantId: 42 }),
      patch({ assistantId: "bad id" }),
      patch({ assistantOverrides: { model: { mode: "inherit" } } }),
      patch({ assistantOverrides: { unknownRow: null } }),
      patch({ assistantOverrides: [] })
    ]);
    expect(malformed.map((response) => response.status)).toEqual([404, 404, 404, 400, 400, 400]);
    await expect(Promise.all(malformed.map((response) => response.json()))).resolves.toEqual([
      { error: "assistant_not_available" },
      { error: "assistant_not_available" },
      { error: "assistant_not_available" },
      { error: "assistant_overrides_invalid" },
      { error: "assistant_overrides_invalid" },
      { error: "assistant_overrides_invalid" }
    ]);
    expect(calls).toEqual([]);

    const refusals: Array<[Error, number, string]> = [
      [new ChatAssistantUpdateError("assistant_not_available"), 404, "assistant_not_available"],
      [new ChatAssistantUpdateError("assistant_overrides_not_allowed"), 400, "assistant_overrides_not_allowed"],
      [new ChatAssistantUpdateError("assistant_overrides_invalid"), 400, "assistant_overrides_invalid"],
      [new ActiveRunConflictError(), 409, "active_run_in_progress"]
    ];
    for (const [error, status, code] of refusals) {
      failure = error;
      const response = await patch({ assistantId: "assistant-2" });
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error: code });
    }
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
