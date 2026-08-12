import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryOperations } from "./MemoryOperations";
import {
  resetMemoryOperationsStoreForTest,
  useMemoryOperationsStore
} from "./memoryOperationsStore";
import {
  memoryDeletionFixture,
  memoryRebuildFixture,
  memorySettingsFixture
} from "./memoryTestFixtures";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

describe("MemoryOperations", () => {
  beforeEach(() => {
    resetMemoryOperationsStoreForTest();
    useMemoryOperationsStore.setState({ accountId: "account-test" });
  });

  afterEach(() => {
    cleanup();
    resetMemoryOperationsStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("focuses the nested task, exposes exact capability reasons, and keeps clear available", async () => {
    const data = memorySettingsFixture({
      capabilities: { automaticLearning: false, historyRecall: false },
      settings: { embeddingDeployment: null, referenceChatHistory: true }
    }, "RU");
    render(<MemoryOperations data={data} locale="RU" onBack={vi.fn()} />);

    const heading = screen.getByRole("heading", { name: "Операции Памяти" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText(/Обычная перестройка останется только лексической/u)).toBeVisible();
    expect(screen.getAllByText(/Индексирование истории недоступно/u)).toHaveLength(3);
    const actionButtons = screen.getAllByRole("button", { name: "Проверить действие" });
    expect(actionButtons.slice(0, 3).every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(actionButtons.at(-1)).toBeEnabled();

    fireEvent.click(actionButtons.at(-1)!);
    const confirmation = screen.getByRole("heading", { name: "Подтвердите операцию Памяти" });
    await waitFor(() => expect(confirmation).toHaveFocus());
    expect(screen.getAllByText(/Исходные сохранённые чаты/u)).toHaveLength(2);
    expect(screen.getByText(/немедленный барьер извлечения/u)).toBeVisible();
  });

  it("distinguishes learned-memory deletion from retained chats and indexed history", async () => {
    render(<MemoryOperations data={memorySettingsFixture()} locale="EN" onBack={vi.fn()} />);

    const actionButtons = screen.getAllByRole("button", { name: "Review action" });
    fireEvent.click(actionButtons.at(-2)!);

    const confirmation = screen.getByRole("heading", { name: "Confirm Memory operation" });
    await waitFor(() => expect(confirmation).toHaveFocus());
    fireEvent.click(within(confirmation.closest("section")!).getByText("What is and is not deleted").closest("summary")!);
    expect(screen.getAllByText("Delete automatically learned memories")).toHaveLength(2);
    expect(screen.getAllByText(/explicitly saved memories, raw retained chats/iu)).toHaveLength(2);
    expect(screen.getByText(/old observed chat content, rebuilds, or delayed work/u)).toBeVisible();
    expect(screen.getByText(/genuinely new future evidence may be learned/u)).toBeVisible();
  });

  it("presents a calm all-Memory reset with exact retention details on demand", async () => {
    render(<MemoryOperations data={memorySettingsFixture()} locale="EN" onBack={vi.fn()} />);

    const label = screen.getByText("Delete everything Memory remembers");
    fireEvent.click(within(label.closest("li")!).getByRole("button", { name: "Review action" }));

    const confirmation = screen.getByRole("heading", { name: "Confirm Memory operation" });
    await waitFor(() => expect(confirmation).toHaveFocus());
    const section = confirmation.closest("section")!;
    expect(within(section).getByText(/turn off Memory now/iu)).toBeVisible();
    fireEvent.click(within(section).getByText("What is and is not deleted").closest("summary")!);
    expect(within(section).getByText(/raw chats remain/u)).toBeVisible();
    expect(within(section).getByText(/accepted past answers or runs is not rewritten/u)).toBeVisible();
    expect(within(section).getByText(/old chats do not refill it/u)).toBeVisible();
    expect(within(section).getByText(/Saved Memory, Reference chat history, and Learn automatically turn off immediately/u)).toBeVisible();
  });

  it("keeps blocked deletion prominent and never offers cancellation for a committed fence", () => {
    useMemoryOperationsStore.setState({
      clearLoadState: "ready",
      clearStatus: memoryDeletionFixture({
        deletionId: "clear-blocked",
        operation: "CLEAR_HISTORY_INDEX",
        state: "BLOCKED_REQUIRES_ADMIN"
      })
    });
    render(<MemoryOperations data={memorySettingsFixture()} locale="EN" onBack={vi.fn()} />);

    expect(screen.getByText(/administrator attention is required/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Check status" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel shadow job" })).not.toBeInTheDocument();
    expect(screen.getByText("clear-blocked")).toBeVisible();
  });

  it("cancels only a running shadow and renders the previous-generation boundary", async () => {
    const running = memoryRebuildFixture({
      completedUnits: 3,
      jobId: "rebuild-running",
      state: "RUNNING",
      totalUnits: 10
    });
    useMemoryOperationsStore.setState({
      rebuildLoadState: "ready",
      rebuildStatus: running
    });
    const fetchMock = vi.fn().mockResolvedValue(json({ ...running, state: "CANCELLED" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryOperations
      data={memorySettingsFixture({ settings: { referenceChatHistory: true } })}
      locale="EN"
      onBack={vi.fn()}
    />);

    expect(screen.getAllByText(/previous generation remains active/u).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel shadow job" }));
    await waitFor(() => expect(screen.getByText(/shadow operation was cancelled/u)).toBeVisible());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me/memory/rebuild/rebuild-running/cancel",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("keeps an unresolved persisted reference actionable without exposing content", () => {
    useMemoryOperationsStore.setState({
      clearError: "memory_rebuild_not_found",
      clearLoadState: "error",
      clearStatus: null
    });
    render(<MemoryOperations data={memorySettingsFixture()} locale="EN" onBack={vi.fn()} />);

    expect(screen.getByText(/saved operation reference is no longer available/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss saved reference" }));
    expect(screen.queryByText(/saved operation reference is no longer available/u)).not.toBeInTheDocument();
  });
});
