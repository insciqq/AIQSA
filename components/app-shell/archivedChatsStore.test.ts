import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deactivateArchivedChats,
  loadEarlierArchivedMessages,
  openArchivedChatPreview,
  refreshArchivedChats,
  restoreArchivedChat,
  restoreArchivedChatSummary,
  useArchivedChatsStore
} from "./archivedChatsStore";
import { resetArchivedChatsStoreForTest } from "@/tests/support/appShellStores";

const updatedAt = "2026-08-10T08:00:00.000Z";

function message(id: string, text: string, parentMessageId: string | null) {
  return {
    artifactSummary: null,
    citationMessageId: null,
    content: { blocks: [{ text, type: "text" }] },
    createdAt: updatedAt,
    errorMessage: null,
    id,
    modelId: null,
    modelRunId: null,
    parentMessageId,
    provider: null,
    role: "user",
    status: "complete"
  };
}

const summary = {
  activeLeafMessageId: "message-new",
  archived: true,
  createdAt: updatedAt,
  defaultKnowledgePlan: null,
  defaultModelId: null,
  defaultProvider: null,
  folderId: null,
  id: "chat-1",
  lastMessageAt: updatedAt,
  memoryMode: "NORMAL",
  messageCount: 2,
  pinned: false,
  projectId: null,
  sourceRevision: 4,
  title: "Archived source",
  updatedAt
} as const;

const detail = {
  ...summary,
  lastMessageAt: undefined,
  contextStats: { approximateActiveBranchInputTokens: 2 },
  messages: [message("message-new", "Newer", "message-old")],
  pageInfo: {
    activeLeafMessageId: "message-new",
    beforeCursor: "cursor-old",
    hasOlder: true,
    snapshotUpdatedAt: updatedAt
  },
  usageStats: null
};

afterEach(() => {
  resetArchivedChatsStoreForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("archived chats store", () => {
  it("lists, previews, pages, and restores owner history through explicit lifecycle routes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/chats/archived") {
        return Response.json({ chats: [summary], nextCursor: null });
      }
      if (url === "/api/chats/chat-1/archive") {
        return Response.json({ chat: detail });
      }
      if (url === "/api/chats/chat-1/archive/messages?before=cursor-old") {
        return Response.json({
          messages: [message("message-old", "Older", null)],
          pageInfo: {
            activeLeafMessageId: "message-new",
            beforeCursor: null,
            hasOlder: false,
            snapshotUpdatedAt: updatedAt
          }
        });
      }
      if (url === "/api/chats/chat-1/restore" && init?.method === "POST") {
        return Response.json({
          chat: {
            archived: false,
            id: "chat-1",
            memoryMode: "NORMAL",
            sourceRevision: 5,
            updatedAt
          }
        });
      }
      return Response.json({ error: "unexpected_request" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await refreshArchivedChats();
    expect(useArchivedChatsStore.getState()).toMatchObject({
      listLoadState: "ready",
      summaries: [expect.objectContaining({ id: "chat-1" })]
    });

    await openArchivedChatPreview("chat-1");
    expect(useArchivedChatsStore.getState().detail).toMatchObject({
      archived: true,
      id: "chat-1",
      messages: [expect.objectContaining({ id: "message-new" })],
      sourceRevision: 4
    });

    await loadEarlierArchivedMessages();
    expect(useArchivedChatsStore.getState().detail?.messages.map((item) => item.id))
      .toEqual(["message-old", "message-new"]);

    await expect(restoreArchivedChat()).resolves.toBe("chat-1");
    expect(useArchivedChatsStore.getState()).toMatchObject({
      detail: null,
      restoring: false,
      summaries: []
    });
    const restoreCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/restore"));
    expect(JSON.parse(String(restoreCall?.[1]?.body))).toEqual({ expectedChatRevision: 4 });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("fails closed on an additive archived response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      chats: [{ ...summary, privateRun: "must-not-cross" }],
      nextCursor: null
    })));

    await expect(refreshArchivedChats()).rejects.toThrow("chat_lifecycle_response_invalid");
    expect(useArchivedChatsStore.getState()).toMatchObject({
      listLoadState: "error",
      summaries: []
    });
  });

  it("ignores a list restore that settles after the archive surface deactivates", async () => {
    let settle: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      settle = resolve;
    })));
    useArchivedChatsStore.setState({ listLoadState: "ready", summaries: [summary] });

    const restore = restoreArchivedChatSummary(summary);
    deactivateArchivedChats();
    settle?.(Response.json({
      chat: {
        archived: false,
        id: "chat-1",
        memoryMode: "NORMAL",
        sourceRevision: 5,
        updatedAt
      }
    }));

    await expect(restore).resolves.toBeNull();
    expect(useArchivedChatsStore.getState()).toEqual(expect.objectContaining({
      detail: null,
      listLoadState: "idle",
      restoring: false,
      summaries: []
    }));
  });

  it("ignores a preview restore that settles after the archive surface deactivates", async () => {
    let settle: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      settle = resolve;
    })));
    useArchivedChatsStore.setState({
      detail: {
        ...detail,
        defaultModelId: "",
        defaultProvider: "",
        messages: [{
          content: "Newer",
          id: "message-new",
          parentMessageId: "message-old",
          role: "user",
          status: "complete"
        }]
      },
      detailLoadState: "ready"
    });

    const restore = restoreArchivedChat();
    deactivateArchivedChats();
    settle?.(Response.json({
      chat: {
        archived: false,
        id: "chat-1",
        memoryMode: "NORMAL",
        sourceRevision: 5,
        updatedAt
      }
    }));

    await expect(restore).resolves.toBeNull();
    expect(useArchivedChatsStore.getState()).toEqual(expect.objectContaining({
      detail: null,
      detailLoadState: "idle",
      restoring: false,
      summaries: []
    }));
  });
});
