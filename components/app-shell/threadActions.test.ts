import { afterEach, describe, expect, it, vi } from "vitest";
import { resetComposerControlStoreForTest } from "./composerControlStore";
import {
  createThreadActions,
  type BranchCheckoutSettlement
} from "./threadActions";
import type { ShareDialogTarget } from "./ShareDialog";
import { resetThreadStoreForTest, selectThreadSnapshot, useThreadStore } from "./threadStore";
import { resetWorkspaceStoreForTest, useWorkspaceStore } from "./workspaceStore";
import type { ChatDetail, ChatSummary, Notice, ThreadMessage } from "./types";

function chatSummary(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    activeLeafMessageId: "message-1",
    createdAt: "2026-06-12T00:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultPromptPresetId: null,
    defaultProvider: "openai",
    folderId: null,
    id: "chat-b",
    messageCount: 2,
    title: "Chat B",
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...overrides
  };
}

function threadMessages(): ThreadMessage[] {
  return [
    {
      content: "Question",
      id: "message-1",
      parentMessageId: null,
      role: "user",
      status: "complete"
    },
    {
      content: "Answer",
      id: "message-2",
      parentMessageId: "message-1",
      role: "assistant",
      status: "complete"
    }
  ];
}

function apiChat(overrides: Partial<ChatSummary> = {}) {
  const chat = chatSummary(overrides);

  return {
    activeLeafMessageId: chat.activeLeafMessageId,
    createdAt: chat.createdAt,
    defaultModelId: chat.defaultModelId,
    defaultPromptPresetId: chat.defaultPromptPresetId,
    defaultProvider: chat.defaultProvider,
    folderId: chat.folderId,
    id: chat.id,
    messageCount: chat.messageCount,
    pinned: chat.pinned ?? false,
    title: chat.title,
    updatedAt: chat.updatedAt
  };
}

function createActionsForTest(input: { activeChatStreaming?: boolean } = {}) {
  const activeChat = chatSummary();
  const messages = threadMessages();
  resetComposerControlStoreForTest();
  resetThreadStoreForTest();
  useThreadStore.getState().replaceThread(activeChat.id, {
    activeLeafId: "message-1",
    messages,
    usageStats: null
  });
  resetWorkspaceStoreForTest();
  useWorkspaceStore.setState({
    activeChatId: activeChat.id,
    chats: [activeChat]
  });
  const notices: Notice[] = [];
  const activateChat = vi.fn();
  const confirmDeleteMessage = vi.fn(async () => true);
  const refreshActiveChat = vi.fn(async (): Promise<ChatDetail> => ({
    ...activeChat,
    messages,
    usageStats: null
  }));
  const pendingBranchCheckouts = new Map<
    string,
    Promise<BranchCheckoutSettlement>
  >();
  const closeChatActions = vi.fn();
  const openShareDialog = vi.fn<(target: ShareDialogTarget) => void>();

  return {
    actions: createThreadActions({
      activeChat,
      activeChatId: activeChat.id,
      activeChatStreaming: input.activeChatStreaming ?? false,
      activeChatTitle: activeChat.title,
      activateChat,
      closeChatActions,
      confirmDeleteMessage,
      openShareDialog,
      pendingBranchCheckouts,
      refreshActiveChat,
      resetThreadToLatest: vi.fn(),
      setNotice: (notice) => {
        notices.push(notice);
      }
    }),
    activateChat,
    chats: () => useWorkspaceStore.getState().chats,
    closeChatActions,
    confirmDeleteMessage,
    messages: () => selectThreadSnapshot(useThreadStore.getState(), activeChat.id).messages,
    notices,
    openShareDialog,
    pendingBranchCheckouts,
    refreshActiveChat,
    thread: () => selectThreadSnapshot(useThreadStore.getState(), activeChat.id)
  };
}

describe("thread actions", () => {
  afterEach(() => {
    document.body.replaceChildren();
    resetComposerControlStoreForTest();
    resetThreadStoreForTest();
    resetWorkspaceStoreForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("allows mutable active-chat actions while another chat streams", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === "/api/messages/message-1/branch-chat") {
        return Response.json({
          chat: apiChat({
            id: "chat-branch",
            title: "Branched Chat"
          })
        });
      }

      if (href === "/api/chats/chat-b") {
        return Response.json({
          chat: apiChat({
            activeLeafMessageId: "message-2"
          })
        });
      }

      if (href === "/api/messages/message-1" && init?.method === "DELETE") {
        return Response.json({
          message: {
            activeLeafMessageId: "message-2",
            chatId: "chat-b",
            deletedMessageIds: ["message-1"]
          }
        });
      }

      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { actions, activateChat, confirmDeleteMessage, messages, refreshActiveChat, thread } =
      createActionsForTest({
        activeChatStreaming: false
      });

    await actions.branchChatFromMessage("message-1");
    await actions.checkoutBranch("message-2");
    await actions.deleteMessage("message-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/messages/message-1/branch-chat", { method: "POST" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats/chat-b",
      expect.objectContaining({
        method: "PATCH"
      })
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/messages/message-1", { method: "DELETE" });
    expect(activateChat).toHaveBeenCalledWith(expect.objectContaining({ id: "chat-branch" }));
    expect(thread().activeLeafId).toBe("message-2");
    expect(confirmDeleteMessage).toHaveBeenCalledWith("message-1");
    expect(messages().map((message) => message.id)).toEqual(["message-2"]);
    expect(refreshActiveChat).toHaveBeenCalledWith("chat-b", {
      forceDetail: true,
      preserveControls: true,
      resumeRuns: false
    });
  });

  it("blocks mutable actions while the active chat streams", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { actions, confirmDeleteMessage, thread } = createActionsForTest({
      activeChatStreaming: true
    });

    await actions.branchChatFromMessage("message-1");
    await actions.checkoutBranch("message-2");
    await actions.deleteMessage("message-1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(confirmDeleteMessage).not.toHaveBeenCalled();
    expect(thread().activeLeafId).toBe("message-1");
  });

  it("refreshes active-branch usage after the summary-only checkout response", async () => {
    const messages = threadMessages();
    const usageStats = {
      activeBranchMessageCount: 2,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 3,
      totalTokens: 21
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          chat: apiChat({ activeLeafMessageId: "message-2" })
        })
      )
    );
    const { actions, chats, refreshActiveChat, thread } = createActionsForTest();
    refreshActiveChat.mockImplementationOnce(async () => {
      useThreadStore.getState().replaceThread("chat-b", {
        activeLeafId: "message-2",
        messages,
        usageStats
      });
      return {
        ...chatSummary({ activeLeafMessageId: "message-2" }),
        messages,
        usageStats
      };
    });

    await actions.checkoutBranch("message-2");

    expect(thread()).toMatchObject({
      activeLeafId: "message-2",
      usageStats
    });
    expect(chats().find((candidate) => candidate.id === "chat-b")?.activeLeafMessageId).toBe(
      "message-2"
    );
    expect(refreshActiveChat).toHaveBeenCalledWith("chat-b", {
      forceDetail: true,
      preserveControls: true,
      resumeRuns: false
    });
  });

  it("persists checkout when the previously stored leaf is explicitly null", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ chat: apiChat({ activeLeafMessageId: "message-2" }) })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { actions } = createActionsForTest();
    useWorkspaceStore.setState((state) => ({
      chats: state.chats.map((chat) => ({ ...chat, activeLeafMessageId: null }))
    }));
    useThreadStore.getState().checkoutBranch("chat-b", null);

    await actions.checkoutBranch("message-2");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats/chat-b",
      expect.objectContaining({ method: "PATCH" })
    );
  });

  it("holds send-side leaf persistence behind a delayed checkout", async () => {
    let resolveCheckout!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveCheckout = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { actions, pendingBranchCheckouts } = createActionsForTest();

    const checkout = actions.checkoutBranch("message-2");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(pendingBranchCheckouts.has("chat-b")).toBe(true);

    let sendBarrierSettled = false;
    const sendBarrier = actions.persistActiveLeaf("chat-b", "message-2").then(() => {
      sendBarrierSettled = true;
    });
    await Promise.resolve();
    expect(sendBarrierSettled).toBe(false);

    resolveCheckout(
      Response.json({
        chat: apiChat({ activeLeafMessageId: "message-2" })
      })
    );
    await Promise.all([checkout, sendBarrier]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sendBarrierSettled).toBe(true);
    expect(pendingBranchCheckouts.has("chat-b")).toBe(false);
  });

  it("aborts a send waiter after delayed checkout failure without retrying the PATCH", async () => {
    let resolveCheckout!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveCheckout = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { actions, thread } = createActionsForTest();

    const checkout = actions.checkoutBranch("message-2");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const sendBarrier = actions.persistActiveLeaf("chat-b", "message-2");
    resolveCheckout(
      Response.json({ error: "active_leaf_changed" }, { status: 409 })
    );

    await checkout;
    await expect(sendBarrier).rejects.toThrow("active_leaf_changed");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(thread().activeLeafId).toBe("message-1");
  });

  it("rejects malformed branch and checkout summaries without publishing them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => Response.json({ chat: { id: "malformed-chat" } }))
    );
    const { actions, activateChat, chats, notices, thread } = createActionsForTest();

    await actions.branchChatFromMessage("message-1");
    await actions.checkoutBranch("message-2");

    expect(activateChat).not.toHaveBeenCalled();
    expect(chats()).toEqual([expect.objectContaining({ activeLeafMessageId: "message-1", id: "chat-b" })]);
    expect(thread().activeLeafId).toBe("message-1");
    expect(notices).toEqual([
      expect.objectContaining({ kind: "error", text: expect.stringContaining("branch chat malformed") }),
      expect.objectContaining({ kind: "error", text: expect.stringContaining("branch checkout malformed") })
    ]);
  });

  it("restores composer focus after the confirmed message row is removed", async () => {
    const composer = document.createElement("textarea");
    composer.id = "composer";
    document.body.append(composer);
    const deletedAction = document.createElement("button");
    document.body.append(deletedAction);
    deletedAction.focus();

    const fetchMock = vi.fn(async () => {
      deletedAction.remove();
      return Response.json({
        message: {
          activeLeafMessageId: "message-2",
          chatId: "chat-b",
          deletedMessageIds: ["message-1"]
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { actions } = createActionsForTest();

    await actions.deleteMessage("message-1");

    await vi.waitFor(() => expect(composer).toHaveFocus());
  });

  it("opens the share dialog for the visible branch leaf instead of publishing", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { actions, notices, openShareDialog } = createActionsForTest();

    actions.shareActiveBranch();

    expect(openShareDialog).toHaveBeenCalledWith({
      activeLeafMessageId: "message-1",
      chat: expect.objectContaining({ id: "chat-b" })
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it("opens the share dialog from a chat row with that chat's leaf and closes the row menu", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { actions, closeChatActions, openShareDialog } = createActionsForTest();
    const rowChat = chatSummary({ activeLeafMessageId: "leaf-c", id: "chat-c" });

    actions.shareChat(rowChat);

    expect(closeChatActions).toHaveBeenCalledOnce();
    expect(openShareDialog).toHaveBeenCalledWith({
      activeLeafMessageId: "leaf-c",
      chat: expect.objectContaining({ id: "chat-c" })
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to open the share dialog for an empty chat", () => {
    const { actions, notices, openShareDialog } = createActionsForTest();

    actions.shareChat(chatSummary({ activeLeafMessageId: null }));

    expect(openShareDialog).not.toHaveBeenCalled();
    expect(notices.at(-1)).toMatchObject({
      kind: "error",
      text: "Send a message before sharing."
    });
  });
});
