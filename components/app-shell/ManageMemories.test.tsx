import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManageMemories } from "./ManageMemories";
import {
  resetMemoryManagerStoreForTest,
  useMemoryManagerStore
} from "./memoryManagerStore";
import {
  memoryDeletionFixture,
  memoryEvidenceFixture,
  memorySummaryFixture
} from "./memoryTestFixtures";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

describe("ManageMemories", () => {
  beforeEach(() => resetMemoryManagerStoreForTest());
  afterEach(() => {
    cleanup();
    resetMemoryManagerStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders a responsive evidence ledger and preserves a dirty edit before leaving", async () => {
    const memory = memorySummaryFixture();
    useMemoryManagerStore.setState({
      listLoadState: "ready",
      memories: [memory],
      nextCursor: null
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/evidence")) return json(memoryEvidenceFixture());
      if (path === `/api/me/memories/${memory.id}`) return json({ memory });
      throw new Error(`unexpected request: ${path}`);
    }));
    const onBack = vi.fn();
    const onDirtyChange = vi.fn();
    render(
      <ManageMemories
        locale="EN"
        onBack={onBack}
        onDirtyChange={onDirtyChange}
        useMemoryFacts
      />
    );

    const listPane = screen.getByTestId("memory-list-pane");
    const detailPane = screen.getByTestId("memory-detail-pane");
    expect(listPane.parentElement).toHaveClass("block");
    expect(detailPane).toHaveClass("hidden", "md:block");
    fireEvent.click(screen.getByRole("button", { name: /I prefer concise answers in Russian/u }));

    expect(await screen.findByRole("heading", { name: "Memory detail" })).toBeVisible();
    expect(screen.getAllByText("I prefer concise answers in Russian.", { selector: "p" })).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Evidence history" })).toBeVisible();
    expect(screen.getByText("Explicit user action")).toBeVisible();
    expect(screen.getAllByText("memory-version-1", { exact: false }).length).toBeGreaterThanOrEqual(1);
    expect(detailPane).toHaveClass("block");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const statement = screen.getByLabelText("Exact statement");
    fireEvent.change(statement, { target: { value: "Keep this exact draft" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    expect(screen.getByRole("button", { name: "New memory" })).toBeDisabled();
    expect(listPane.parentElement).toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "Back to Memory settings" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Discard Memory draft?");
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(statement).toHaveValue("Keep this exact draft");
    fireEvent.click(screen.getByRole("button", { name: "Back to Memory settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("keeps raw chats and accepted runs explicit in the exact bulk confirmation", () => {
    useMemoryManagerStore.setState({ listLoadState: "ready", screen: "list" });
    render(<ManageMemories locale="EN" onBack={vi.fn()} useMemoryFacts />);

    fireEvent.click(screen.getByRole("button", { name: "Delete all saved memories" }));

    expect(screen.getByRole("heading", { name: "Delete all saved memories?" })).toBeVisible();
    expect(screen.getByText(/immediately fences all currently saved explicit memories/u)).toBeVisible();
    expect(screen.getByText(/Retained raw chats are not deleted/u)).toBeVisible();
    expect(screen.getByText(/immutable accepted destination runs are not rewritten/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete all saved memories" })).toBeVisible();
  });

  it("renders blocked durable deletion without exposing memory text", async () => {
    const memory = memorySummaryFixture({ displayText: "private value must stay absent" });
    useMemoryManagerStore.setState({ listLoadState: "ready", memories: [memory] });
    render(<ManageMemories locale="EN" onBack={vi.fn()} useMemoryFacts />);
    act(() => {
      useMemoryManagerStore.setState({
        deletionLoadState: "ready",
        deletionStatus: memoryDeletionFixture({
          completedUnits: 2,
          state: "BLOCKED_REQUIRES_ADMIN"
        }),
        screen: "delete"
      });
    });

    expect(await screen.findByRole("heading", { name: "Durable deletion progress" })).toBeVisible();
    expect(screen.getByText(/physical deletion needs administrator attention/u)).toBeVisible();
    expect(screen.getByText("2 / 4", { exact: false })).toBeVisible();
    expect(screen.queryByText("private value must stay absent")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check deletion status" })).toBeVisible();
  });

  it("uses one local Settings scroll owner instead of nested list/detail scrollers", () => {
    useMemoryManagerStore.setState({ listLoadState: "ready" });
    render(<ManageMemories locale="RU" onBack={vi.fn()} useMemoryFacts={false} />);

    const manager = screen.getByTestId("manage-memories");
    expect(manager.querySelectorAll(".overflow-y-auto")).toHaveLength(0);
    expect(within(manager).getByRole("heading", { name: "Управление памятью" })).toBeVisible();
  });
});
