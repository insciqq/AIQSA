import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useArchivedChatsStore } from "@/components/app-shell/archivedChatsStore";
import { useMemorySettingsStore } from "@/components/app-shell/memorySettingsStore";
import {
  activatePermanentChatDeletionAccount,
  usePermanentChatDeletionStore
} from "@/components/app-shell/permanentChatDeletionStore";
import {
  resetArchivedChatsStoreForTest,
  resetMemorySettingsStoreForTest,
  resetPermanentChatDeletionStoreForTest
} from "@/tests/support/appShellStores";
import { memoryConsumerSettingsFixture } from "@/tests/support/memoryFixtures";
import { ArchivedChatsPanelV2 } from "./ArchivedChatsPanelV2";

const updatedAt = "2026-08-10T08:00:00.000Z";
const summary = {
  activeLeafMessageId: "message-1",
  archived: true as const,
  createdAt: updatedAt,
  defaultKnowledgePlan: null,
  defaultModelId: null,
  defaultProvider: null,
  folderId: null,
  id: "chat-1",
  lastMessageAt: updatedAt,
  memoryMode: "EXCLUDED" as const,
  messageCount: 1,
  pinned: false,
  sourceRevision: 4,
  title: "Archived source",
  updatedAt,
  workspace: {
    available: false,
    enabled: false,
    internetEnabled: null,
    sessionState: null,
    unavailableReason: "installation_disabled" as const
  }
};

function readyList() {
  useArchivedChatsStore.setState({
    listLoadState: "ready",
    summaries: [summary]
  });
}

function readyDetail() {
  useArchivedChatsStore.setState({
    detail: {
      activeLeafMessageId: "message-1",
      archived: true,
      contextStats: { approximateActiveBranchInputTokens: 2 },
      createdAt: updatedAt,
      defaultKnowledgePlan: null,
      defaultModelId: "",
      defaultProvider: "",
      folderId: null,
      id: "chat-1",
      memoryMode: "EXCLUDED",
      messageCount: 1,
      messages: [{
        content: "Retained evidence",
        id: "message-1",
        parentMessageId: null,
        role: "user",
        status: "complete"
      }],
      pageInfo: {
        activeLeafMessageId: "message-1",
        beforeCursor: null,
        hasOlder: false,
        snapshotUpdatedAt: updatedAt
      },
      pinned: false,
      sourceRevision: 4,
      title: "Archived source",
      updatedAt,
      usageStats: null,
      workspace: summary.workspace
    },
    detailLoadState: "ready"
  });
}

afterEach(() => {
  cleanup();
  resetArchivedChatsStoreForTest();
  resetPermanentChatDeletionStoreForTest();
  resetMemorySettingsStoreForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ArchivedChatsPanelV2", () => {
  it("shows owner archive truth without a second dialog or invented archive date", () => {
    readyList();

    render(<ArchivedChatsPanelV2 onRestored={vi.fn()} />);

    const panel = screen.getByTestId("settings-archived-panel");
    expect(within(panel).getByRole("button", {
      description: /Last message Aug 10, 2026 · 1 message · Excluded from Memory/u,
      name: "Open preview: Archived source"
    })).toBeVisible();
    expect(within(panel).getByText(/Last message Aug 10, 2026 · 1 message/u)).toBeVisible();
    expect(within(panel).getByRole("button", { name: "Restore Archived source" })).toBeVisible();
    expect(within(panel).queryByRole("button", { name: /Delete/u })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(panel).getByText(/Restore the chat, then choose/u)).toBeVisible();
  });

  it("renders a read-only preview with explicit Exclude consequences", () => {
    readyDetail();

    render(<ArchivedChatsPanelV2 onRestored={vi.fn()} />);

    const panel = screen.getByTestId("settings-archived-panel");
    expect(within(panel).getByRole("heading", { name: "Archived source" })).toBeVisible();
    expect(within(panel).getByText("Retained evidence")).toBeVisible();
    expect(within(panel).getByRole("list", { name: "Archived chat messages" })).toBeVisible();
    expect(within(panel).getByRole("button", { name: "Restore Archived source" })).toBeVisible();
    expect(within(panel).getByText(/stops using it as a source/i)).toBeVisible();
    expect(within(panel).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("offers permanent deletion in the always-visible row menu only when allowed", async () => {
    useMemorySettingsStore.setState({
      data: memoryConsumerSettingsFixture({ capabilities: { permanentChatDeletion: true } }),
      error: null,
      loadState: "ready"
    });
    await activatePermanentChatDeletionAccount("account-a");
    readyList();

    render(<ArchivedChatsPanelV2 onRestored={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions: Archived source" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete permanently…" }));

    expect(usePermanentChatDeletionStore.getState().target).toEqual({
      chatId: "chat-1",
      location: "ARCHIVED",
      title: "Archived source"
    });
    expect(screen.getByTestId("settings-archived-panel")).toHaveAttribute("aria-hidden", "true");
  });

  it("restores directly from a list row and keeps the Settings task mounted", async () => {
    readyList();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/chats/chat-1/restore" && init?.method === "POST") {
        return Response.json({
          chat: {
            archived: false,
            id: "chat-1",
            memoryMode: "EXCLUDED",
            sourceRevision: 5,
            updatedAt
          }
        });
      }
      return new Response("", { status: 500 });
    }));
    const onRestored = vi.fn();

    render(<ArchivedChatsPanelV2 onRestored={onRestored} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore Archived source" }));

    await waitFor(() => expect(onRestored).toHaveBeenCalledWith("chat-1"));
    expect(screen.getByTestId("settings-archived-panel")).toBeVisible();
    expect(useArchivedChatsStore.getState().summaries).toEqual([]);
    await waitFor(() => expect(
      screen.getByRole("searchbox", { name: "Search archived chats" })
    ).toHaveFocus());
  });

  it("filters loaded rows by title and exposes truthful pagination", () => {
    useArchivedChatsStore.setState({
      listLoadState: "ready",
      nextCursor: "next-page",
      summaries: [summary, { ...summary, id: "chat-2", title: "Release checklist" }]
    });

    render(<ArchivedChatsPanelV2 onRestored={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search archived chats" }), {
      target: { value: "release" }
    });

    expect(screen.queryByRole("button", { name: "Open preview: Archived source" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open preview: Release checklist" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Load more" })).toBeVisible();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search archived chats" }), {
      target: { value: "nothing here" }
    });
    expect(screen.getByRole("heading", { name: "No matching chats" })).toBeVisible();
  });

  it("moves focus into preview and returns it to the originating row", async () => {
    readyList();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    render(<ArchivedChatsPanelV2 onRestored={vi.fn()} />);
    const origin = screen.getByRole("button", { name: "Open preview: Archived source" });

    fireEvent.click(origin);
    await waitFor(() => expect(screen.getByRole("status")).toHaveFocus());
    act(() => readyDetail());
    const back = await screen.findByRole("button", { name: "Archived chats" });
    await waitFor(() => expect(back).toHaveFocus());

    fireEvent.click(back);
    await waitFor(() => expect(
      screen.getByRole("button", { name: "Open preview: Archived source" })
    ).toHaveFocus());
  });

  it("states when an archived chat has no messages", () => {
    useArchivedChatsStore.setState({
      listLoadState: "ready",
      summaries: [{ ...summary, activeLeafMessageId: null, lastMessageAt: null, messageCount: 0 }]
    });

    render(<ArchivedChatsPanelV2 onRestored={vi.fn()} />);

    expect(screen.getByText(/No messages yet · 0 messages/u)).toBeVisible();
  });

  it("settles archive requests and state when the Settings subview leaves", () => {
    readyDetail();
    const view = render(<ArchivedChatsPanelV2 onRestored={vi.fn()} />);

    view.unmount();

    expect(useArchivedChatsStore.getState()).toMatchObject({
      detail: null,
      detailLoadState: "idle",
      listLoadState: "idle",
      summaries: []
    });
  });
});
