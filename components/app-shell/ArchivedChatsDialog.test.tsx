import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchivedChatsDialog } from "./ArchivedChatsDialog";
import { useArchivedChatsStore } from "./archivedChatsStore";
import { memoryConsumerSettingsFixture } from "@/tests/support/memoryFixtures";
import { useMemorySettingsStore } from "./memorySettingsStore";
import { activatePermanentChatDeletionAccount, usePermanentChatDeletionStore } from "./permanentChatDeletionStore";
import { resetArchivedChatsStoreForTest, resetMemorySettingsStoreForTest, resetPermanentChatDeletionStoreForTest } from "@/tests/support/appShellStores";

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
  memoryMode: "EXCLUDED" as const,
  messageCount: 1,
  pinned: false,
  sourceRevision: 4,
  title: "Archived source",
  updatedAt
};

afterEach(() => {
  cleanup();
  resetArchivedChatsStoreForTest();
  resetPermanentChatDeletionStoreForTest();
  resetMemorySettingsStoreForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ArchivedChatsDialog", () => {
  it("offers a reachable owner archive without delete or new-run actions", () => {
    useArchivedChatsStore.setState({
      listLoadState: "ready",
      open: true,
      summaries: [summary]
    });

    render(<ArchivedChatsDialog onRestored={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "Archived chats" });
    expect(within(dialog).getByRole("button", { name: /^Archived source/ })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: /Delete/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /New chat/i })).not.toBeInTheDocument();
    return waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Close archive" })).toHaveFocus()
    );
  });

  it("renders a read-only preview with separate Exclude disclosure and Restore", () => {
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
        usageStats: null
      },
      detailLoadState: "ready",
      open: true
    });

    render(<ArchivedChatsDialog onRestored={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "Archived source" });
    expect(within(dialog).getByText("Retained evidence")).toBeVisible();
    expect(within(dialog).getByRole("list", { name: "Archived chat messages" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Restore" })).toBeVisible();
    expect(within(dialog).getByText(/stops using it as a source/i)).toBeVisible();
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("adds a distinct capability-gated permanent action to the owner preview", async () => {
    useMemorySettingsStore.setState({
      data: memoryConsumerSettingsFixture({ capabilities: { permanentChatDeletion: true } }),
      error: null,
      loadState: "ready"
    });
    await activatePermanentChatDeletionAccount("account-a");
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
        messages: [],
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
        usageStats: null
      },
      detailLoadState: "ready",
      open: true
    });

    render(<ArchivedChatsDialog onRestored={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    expect(usePermanentChatDeletionStore.getState().target).toEqual({
      chatId: "chat-1",
      location: "ARCHIVED",
      title: "Archived source"
    });
    expect(
      screen.getByTestId("archived-chats-dialog").querySelector('[role="dialog"]')
    ).toHaveAttribute("aria-hidden", "true");
  });

  it("restores and deletes directly from list rows with capability-gated delete", async () => {
    useMemorySettingsStore.setState({
      data: memoryConsumerSettingsFixture({ capabilities: { permanentChatDeletion: true } }),
      error: null,
      loadState: "ready"
    });
    await activatePermanentChatDeletionAccount("account-a");
    useArchivedChatsStore.setState({
      listLoadState: "ready",
      open: true,
      summaries: [
        summary,
        { ...summary, id: "chat-2", title: "Second archived" }
      ]
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
    });
    vi.stubGlobal("fetch", fetchMock);
    const onRestored = vi.fn();

    render(<ArchivedChatsDialog onRestored={onRestored} />);

    fireEvent.click(screen.getByRole("button", { name: "Restore: Archived source" }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith("chat-1"));
    expect(useArchivedChatsStore.getState().summaries.map((chat) => chat.id)).toEqual([
      "chat-2"
    ]);
    // The list dialog stays open after a row restore.
    expect(useArchivedChatsStore.getState().open).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Delete permanently: Second archived" })
    );
    expect(usePermanentChatDeletionStore.getState().target).toEqual({
      chatId: "chat-2",
      location: "ARCHIVED",
      title: "Second archived"
    });
  });

  it("filters the archived list client-side by title", () => {
    useArchivedChatsStore.setState({
      listLoadState: "ready",
      open: true,
      summaries: [
        summary,
        { ...summary, id: "chat-2", title: "Release checklist" }
      ]
    });

    render(<ArchivedChatsDialog onRestored={vi.fn()} />);

    expect(screen.getByRole("button", { name: /^Archived source/ })).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search archive" }), {
      target: { value: "release" }
    });
    expect(screen.queryByRole("button", { name: /^Archived source/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Release checklist/ })).toBeVisible();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search archive" }), {
      target: { value: "nothing here" }
    });
    expect(screen.getByText("No archived chats match.")).toBeVisible();
  });

  it("keeps direct source navigation in an explicit loading state", () => {
    useArchivedChatsStore.setState({ detailLoadState: "loading", open: true });
    render(<ArchivedChatsDialog onRestored={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading preview…");
    fireEvent.click(screen.getByRole("button", { name: "Close archive" }));
    expect(useArchivedChatsStore.getState().open).toBe(false);
  });
});
