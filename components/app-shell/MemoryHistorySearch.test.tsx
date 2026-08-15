import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMemoryHistorySearchStoreForTest, resetWorkspaceStoreForTest } from "@/tests/support/appShellStores";
import { MemoryHistorySearch } from "./MemoryHistorySearch";
import { useMemoryHistorySearchStore } from "./memoryHistorySearchStore";
import { useWorkspaceStore } from "./workspaceStore";
import type { MemoryHistorySearchResponse } from "@/lib/contracts/memory";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

const response: MemoryHistorySearchResponse = {
  indexing: {
    degradationCode: "memory_vector_unavailable",
    lexicalState: "READY",
    vectorState: "DEGRADED"
  },
  nextCursor: null,
  results: [{
    indexingState: "LEXICAL_READY",
    itemType: "RECALL_CHUNK",
    occurredAt: "2026-08-09T08:00:00.000Z",
    sourceChatId: "chat-archived",
    sourceChatTitle: "Решения по архитектуре",
    sourceFolderId: "folder-1",
    sourceFolderName: "Инфраструктура",
    sourceMessageIds: ["message-1", "message-2"],
    sourceState: "ARCHIVED",
    snippet: "Решили оставить локальный лексический индекс как безопасный базовый слой."
  }]
};

describe("MemoryHistorySearch", () => {
  beforeEach(() => {
    resetMemoryHistorySearchStoreForTest();
    resetWorkspaceStoreForTest();
    useWorkspaceStore.setState({
      chats: [{
        activeLeafMessageId: "message-live",
        createdAt: "2026-08-08T08:00:00.000Z",
        defaultModelId: "model",
        defaultProvider: "provider",
        folderId: "folder-1",
        id: "chat-live",
        memoryMode: "NORMAL",
        messageCount: 2,
        title: "Текущий чат",
        updatedAt: "2026-08-08T08:00:00.000Z"
      }],
      folders: [{
        id: "folder-1",
        name: "Инфраструктура",
        parentId: null,
        projectMemory: "",
        sortOrder: 0
      }]
    });
  });

  afterEach(() => {
    cleanup();
    resetMemoryHistorySearchStoreForTest();
    resetWorkspaceStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps English controls over retained RU data and cancels an abortable private request", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryHistorySearch
        accountId="account-a"
        onBack={vi.fn()}
        onOpenSource={vi.fn()}
      />
    );

    const heading = screen.getByRole("heading", { name: "Search chat history" });
    await waitFor(() => expect(heading).toHaveFocus());
    fireEvent.click(screen.getByText("Limit the source trail"));
    fireEvent.change(screen.getByLabelText("History search"), {
      target: { value: "закрытое архитектурное решение" }
    });
    fireEvent.change(screen.getByLabelText("Chat"), { target: { value: "chat-live" } });
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "folder-1" } });
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-08-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Search history" }));

    expect(await screen.findByRole("button", { name: "Cancel search" })).toBeVisible();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/me/memory/history/search");
    expect(path).not.toContain("архитектурное");
    expect(JSON.parse(String(init.body))).toMatchObject({
      chatIds: ["chat-live"],
      folderId: "folder-1",
      from: "2026-08-01T00:00:00.000Z",
      query: "закрытое архитектурное решение"
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel search" }));
    expect(await screen.findByText("Search cancelled. Your query and filters are still here.")).toBeVisible();
    expect(screen.getByLabelText("History search")).toHaveValue("закрытое архитектурное решение");
  });

  it("renders a flat source trail and opens an archived owner-only preview target", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(response)));
    const onOpenSource = vi.fn();
    render(
      <MemoryHistorySearch
        accountId="account-a"
        onBack={vi.fn()}
        onOpenSource={onOpenSource}
      />
    );
    fireEvent.change(screen.getByLabelText("History search"), {
      target: { value: "architecture decision" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Search history" }));

    const trail = await screen.findByRole("list", { name: "Source trail" });
    expect(within(trail).getByText(response.results[0]!.snippet)).toBeVisible();
    expect(within(trail).getByText("Решения по архитектуре")).toBeVisible();
    expect(within(trail).getByText("Инфраструктура")).toBeVisible();
    expect(screen.getByText(/semantic matching is temporarily unavailable/u)).toBeVisible();
    const open = screen.getByRole("button", { name: "Open archived preview" });
    expect(open).toHaveClass("min-h-touch", "sm:min-h-control");
    fireEvent.click(open);
    expect(onOpenSource).toHaveBeenCalledWith("chat-archived");
    expect(screen.getByTestId("memory-history-search").querySelectorAll(".overflow-y-auto"))
      .toHaveLength(0);
  });

  it("drops visible private results when the account owner changes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(response)));
    const props = {
      onBack: vi.fn(),
      onOpenSource: vi.fn()
    };
    const view = render(<MemoryHistorySearch accountId="account-a" {...props} />);
    fireEvent.change(screen.getByLabelText("History search"), { target: { value: "decision" } });
    fireEvent.click(screen.getByRole("button", { name: "Search history" }));
    expect(await screen.findByText(response.results[0]!.snippet)).toBeVisible();

    view.rerender(<MemoryHistorySearch accountId="account-b" {...props} />);
    await waitFor(() => expect(useMemoryHistorySearchStore.getState()).toMatchObject({
      accountId: "account-b",
      results: []
    }));
    expect(screen.queryByText(response.results[0]!.snippet)).not.toBeInTheDocument();
  });
});
