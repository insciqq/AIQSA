import { afterEach, describe, expect, it, vi } from "vitest";
import { resetComposerControlStoreForTest } from "./composerControlStore";
import {
  createShareMutationCoordinator,
  createThreadActions,
  type BranchCheckoutSettlement
} from "./threadActions";
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
  const shareMutationCoordinator = createShareMutationCoordinator();
  const setSharing = vi.fn();

  return {
    actions: createThreadActions({
      activeChat,
      activeChatId: activeChat.id,
      activeChatStreaming: input.activeChatStreaming ?? false,
      activeChatTitle: activeChat.title,
      activateChat,
      closeChatActions: vi.fn(),
      confirmDeleteMessage,
      pendingBranchCheckouts,
      refreshActiveChat,
      resetThreadToLatest: vi.fn(),
      shareMutationCoordinator,
      setNotice: (notice) => {
        notices.push(notice);
      },
      setSharing
    }),
    activateChat,
    chats: () => useWorkspaceStore.getState().chats,
    confirmDeleteMessage,
    messages: () => selectThreadSnapshot(useThreadStore.getState(), activeChat.id).messages,
    notices,
    pendingBranchCheckouts,
    refreshActiveChat,
    setSharing,
    shareMutationCoordinator,
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

  it("keeps a created share link available and revokes it through the notice action", async () => {
    const shareButton = document.createElement("button");
    shareButton.setAttribute("aria-label", "Share anonymously");
    document.body.append(shareButton);
    const revokeButton = document.createElement("button");
    document.body.append(revokeButton);
    revokeButton.focus();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText
      }
    });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);

      if (href === "/api/chats/chat-b/share" && init?.method === "POST") {
        return Response.json({
          share: {
            id: "share-1",
            publicPath: "/s/share-token"
          }
        });
      }

      if (href === "/api/shares/share-1/revoke" && init?.method === "POST") {
        return Response.json({
          share: {
            id: "share-1",
            revoked: true
          }
        });
      }

      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { actions, notices, setSharing, shareMutationCoordinator } = createActionsForTest();

    await actions.shareChat(chatSummary());

    const shareNotice = notices.at(-1);
    expect(shareNotice).toMatchObject({
      action: {
        label: "Revoke link",
        tone: "destructive"
      },
      href: "http://localhost:3000/s/share-token",
      kind: "success",
      persistent: true
    });
    expect(writeText).toHaveBeenCalledWith("http://localhost:3000/s/share-token");
    expect(shareMutationCoordinator.visibleShare).toMatchObject({
      chatId: "chat-b",
      href: "http://localhost:3000/s/share-token",
      shareId: "share-1"
    });

    shareNotice?.action?.onClick();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/shares/share-1/revoke", {
        method: "POST"
      });
      expect(notices.at(-1)).toMatchObject({
        kind: "success",
        text: "Public share link revoked"
      });
      expect(shareButton).toHaveFocus();
    });
    expect(setSharing.mock.calls).toEqual([[true], [false], [true], [false]]);
    expect(shareMutationCoordinator.visibleShare).toBeNull();
  });

  it("serializes rapid share creation and keeps the existing live owner visible", async () => {
    let resolveCreate!: (response: Response) => void;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    });
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveCreate = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { actions, notices, setSharing, shareMutationCoordinator } = createActionsForTest();

    const firstCreate = actions.shareChat(chatSummary());
    const duplicateCreate = actions.shareChat(chatSummary({ id: "chat-c" }));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(setSharing.mock.calls).toEqual([[true]]);
    resolveCreate(
      Response.json({
        share: {
          id: "share-1",
          publicPath: "/s/share-token"
        }
      })
    );
    await Promise.all([firstCreate, duplicateCreate]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(setSharing.mock.calls).toEqual([[true], [false]]);
    expect(shareMutationCoordinator.visibleShare).toMatchObject({
      chatId: "chat-b",
      shareId: "share-1"
    });

    await actions.shareChat(chatSummary({ id: "chat-c" }));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(notices.at(-1)).toMatchObject({
      action: { label: "Revoke link" },
      href: "http://localhost:3000/s/share-token",
      persistent: true,
      text: "A public share link is already active. Revoke it before creating another."
    });
  });

  it("blocks create and duplicate revoke while revocation is pending, then permits a new share", async () => {
    let resolveRevoke!: (response: Response) => void;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    });
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === "/api/chats/chat-b/share" && init?.method === "POST") {
        return Promise.resolve(
          Response.json({ share: { id: "share-1", publicPath: "/s/share-token-1" } })
        );
      }
      if (href === "/api/shares/share-1/revoke" && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          resolveRevoke = resolve;
        });
      }
      if (href === "/api/chats/chat-c/share" && init?.method === "POST") {
        return Promise.resolve(
          Response.json({ share: { id: "share-2", publicPath: "/s/share-token-2" } })
        );
      }

      return Promise.resolve(new Response("", { status: 500 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { actions, notices, setSharing, shareMutationCoordinator } = createActionsForTest();

    await actions.shareChat(chatSummary());
    const revokeAction = notices.at(-1)?.action;
    revokeAction?.onClick();
    revokeAction?.onClick();
    const blockedCreate = actions.shareChat(chatSummary({ id: "chat-c" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith("/api/shares/share-1/revoke", { method: "POST" });
    expect(setSharing.mock.calls).toEqual([[true], [false], [true]]);

    resolveRevoke(Response.json({ share: { id: "share-1", revoked: true } }));
    await blockedCreate;
    await vi.waitFor(() => expect(shareMutationCoordinator.visibleShare).toBeNull());

    await actions.shareChat(chatSummary({ id: "chat-c" }));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(shareMutationCoordinator.visibleShare).toMatchObject({
      chatId: "chat-c",
      href: "http://localhost:3000/s/share-token-2",
      shareId: "share-2"
    });
    expect(setSharing.mock.calls).toEqual([
      [true],
      [false],
      [true],
      [false],
      [true],
      [false]
    ]);
  });

  it("keeps a clipboard-failed link visible and revocable through a failed retry", async () => {
    const shareButton = document.createElement("button");
    shareButton.setAttribute("aria-label", "Share anonymously");
    document.body.append(shareButton);
    const revokeButton = document.createElement("button");
    document.body.append(revokeButton);
    revokeButton.focus();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("clipboard_denied"))
      }
    });
    let revokeAttempts = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === "/api/chats/chat-b/share" && init?.method === "POST") {
        return Response.json({ share: { id: "share-1", publicPath: "/s/exact-token" } });
      }
      if (href === "/api/shares/share-1/revoke" && init?.method === "POST") {
        revokeAttempts += 1;
        if (revokeAttempts === 1) {
          return Response.json({ error: "temporary_failure" }, { status: 503 });
        }
        revokeButton.remove();
        return Response.json({ share: { id: "share-1", revoked: true } });
      }

      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { actions, notices, shareMutationCoordinator } = createActionsForTest();

    await actions.shareChat(chatSummary());

    expect(notices.at(-1)).toMatchObject({
      action: { label: "Revoke link" },
      href: "http://localhost:3000/s/exact-token",
      persistent: true,
      text: "Share link created. Copy it from here."
    });
    notices.at(-1)?.action?.onClick();
    await vi.waitFor(() =>
      expect(notices.at(-1)).toMatchObject({
        action: { label: "Retry revoke" },
        href: "http://localhost:3000/s/exact-token",
        persistent: true
      })
    );

    notices.at(-1)?.action?.onClick();
    await vi.waitFor(() => {
      expect(revokeAttempts).toBe(2);
      expect(notices.at(-1)).toMatchObject({ text: "Public share link revoked" });
      expect(shareMutationCoordinator.visibleShare).toBeNull();
      expect(shareButton).toHaveFocus();
    });
  });
});
