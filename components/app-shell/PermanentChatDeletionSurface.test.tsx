import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryConsumerSettingsFixture } from "@/tests/support/memoryFixtures";
import { useMemorySettingsStore } from "./memorySettingsStore";
import { COMPLETED_NOTICE_DISMISS_MS, PermanentChatDeletionSurface } from "./PermanentChatDeletionSurface";
import { activatePermanentChatDeletionAccount, openPermanentChatDeletion, usePermanentChatDeletionStore } from "./permanentChatDeletionStore";
import { resetMemorySettingsStoreForTest, resetPermanentChatDeletionStoreForTest } from "@/tests/support/appShellStores";
import { simulatePageTranslation } from "@/tests/support/pageTranslation";

beforeEach(async () => {
  resetPermanentChatDeletionStoreForTest();
  resetMemorySettingsStoreForTest();
  window.sessionStorage.clear();
  useMemorySettingsStore.setState({
    data: memoryConsumerSettingsFixture({ capabilities: { permanentChatDeletion: true } }),
    error: null,
    loadState: "ready"
  });
  await activatePermanentChatDeletionAccount("account-a");
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  resetPermanentChatDeletionStoreForTest();
  resetMemorySettingsStoreForTest();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PermanentChatDeletionSurface", () => {
  it("keeps the ordinary confirmation concise and puts technical retention detail in Advanced", async () => {
    openPermanentChatDeletion({
      chatId: "chat-1",
      location: "WORKSPACE",
      title: "Research notes"
    });
    render(<PermanentChatDeletionSurface />);

    const dialog = screen.getByRole("dialog", { name: "Delete this chat permanently?" });
    expect(screen.getByTestId("permanent-chat-deletion-dialog").parentElement).toBe(document.body);
    expect(within(dialog).getByText("Research notes", { exact: false })).toBeVisible();
    expect(within(dialog).getByRole("checkbox", {
      name: /Also forget saved memories from this chat/i
    })).not.toBeChecked();
    const advanced = within(dialog).getByText("Advanced details").closest("details")!;
    expect(advanced).not.toHaveAttribute("open");
    expect(within(dialog).getByText(/AI provider or external tool/i)).not.toBeVisible();

    fireEvent.click(within(dialog).getByText("Advanced details"));
    expect(within(dialog).getByText(/AI provider or external tool/i)).toBeVisible();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    expect(usePermanentChatDeletionStore.getState().alsoForgetOriginMemories).toBe(true);
    await waitFor(() => expect(
      within(dialog).getByRole("button", { name: "Close" })
    ).toHaveFocus());
  });

  it("confirms on a translated page without crashing or abandoning the sent request", async () => {
    let settle!: (response: Response) => void;
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => {
      settle = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const crashes: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      crashes.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      openPermanentChatDeletion({ chatId: "chat-1", location: "WORKSPACE", title: "Research notes" });
      const { unmount } = render(<PermanentChatDeletionSurface />);
      const dialog = screen.getByRole("dialog", { name: "Delete this chat permanently?" });
      expect(simulatePageTranslation(dialog)).toBeGreaterThan(0);
      const confirm = within(dialog).getByRole("button", { name: "Delete permanently" });
      expect(confirm.querySelector("font")).not.toBeNull();

      fireEvent.click(confirm);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      expect(confirm).toBeDisabled();
      expect(confirm.querySelector(".animate-spin")).not.toBeNull();
      expect(screen.getByRole("dialog", { name: "Delete this chat permanently?" })).toBe(dialog);
      expect(crashes).toEqual([]);

      // The shell going away (a crash screen elsewhere, a navigation) leaves the request alone.
      unmount();
      resetPermanentChatDeletionStoreForTest();
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).not.toBe(true);
      await act(async () => {
        settle(Response.json({ status: "IN_PROGRESS" }));
      });
      expect(window.sessionStorage.getItem("aiqsa:chat-permanent-deletion:v2:account-a"))
        .toBe(JSON.stringify({ chatId: "chat-1", version: 2 }));
      expect(crashes).toEqual([]);
    } finally {
      window.removeEventListener("error", onError);
    }
  });

  it("shows private-safe blocked progress without technical identifiers", () => {
    usePermanentChatDeletionStore.setState({
      reference: { chatId: "chat-1" },
      status: { status: "NEEDS_ATTENTION" },
      statusLoadState: "ready",
      statusOpen: true
    });
    render(<PermanentChatDeletionSurface />);

    const dialog = screen.getByRole("dialog", { name: "Permanent deletion" });
    expect(within(dialog).getByText(/administrator attention/i)).toBeVisible();
    expect(within(dialog).queryByText("Research notes")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Advanced details")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("deletion-secret-1")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("memory_cleanup_residual")).not.toBeInTheDocument();
  });

  it("collapses background progress to a durable actionable notice", async () => {
    usePermanentChatDeletionStore.setState({
      reference: { chatId: "chat-1" },
      status: { status: "IN_PROGRESS" },
      statusLoadState: "ready",
      statusOpen: false
    });
    render(<PermanentChatDeletionSurface />);

    expect(screen.getByRole("status")).toHaveTextContent("Chat deleted · cleanup is finishing");
    fireEvent.click(screen.getByRole("button", { name: "View progress" }));
    const dialog = screen.getByRole("dialog", { name: "Permanent deletion" });
    expect(dialog).toBeVisible();
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() => expect(
      screen.getByRole("button", { name: "View progress" })
    ).toHaveFocus());
  });

  it("sits above a composer resting at the bottom instead of over its input", () => {
    usePermanentChatDeletionStore.setState({
      reference: { chatId: "chat-1" },
      status: { status: "NEEDS_ATTENTION" },
      statusLoadState: "ready",
      statusOpen: false
    });
    const { rerender } = render(<PermanentChatDeletionSurface composerInset={120} />);

    expect(screen.getByTestId("permanent-chat-deletion-notice").style.bottom).toBe("calc(120px + 0.5rem)");
    rerender(<PermanentChatDeletionSurface />);
    expect(screen.getByTestId("permanent-chat-deletion-notice").style.bottom).toBe("");
  });

  it("keeps polling an unchanged status until the deletion completes, then lets the notice go", async () => {
    vi.useFakeTimers();
    const replies = ["IN_PROGRESS", "IN_PROGRESS", "COMPLETE"];
    const fetchMock = vi.fn(async () => Response.json({ status: replies.shift() }));
    vi.stubGlobal("fetch", fetchMock);
    usePermanentChatDeletionStore.setState({
      reference: { chatId: "chat-1" },
      status: { status: "IN_PROGRESS" },
      statusLoadState: "ready",
      statusOpen: false
    });
    render(<PermanentChatDeletionSurface />);

    for (const calls of [1, 2, 3]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(fetchMock).toHaveBeenCalledTimes(calls);
    }
    expect(screen.getByRole("status")).toHaveTextContent("Chat deletion completed");
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPLETED_NOTICE_DISMISS_MS); });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("lets the user dismiss a notice only an administrator can move on", () => {
    usePermanentChatDeletionStore.setState({
      reference: { chatId: "chat-1" },
      status: { status: "NEEDS_ATTENTION" },
      statusLoadState: "ready",
      statusOpen: false
    });
    render(<PermanentChatDeletionSurface />);

    expect(screen.getByRole("button", { name: "View progress" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(usePermanentChatDeletionStore.getState().reference).toBeNull();
  });

  it("lets a completed notice go on its own, but not while it holds focus", () => {
    vi.useFakeTimers();
    usePermanentChatDeletionStore.setState({
      reference: { chatId: "chat-1" },
      status: { status: "COMPLETE" },
      statusLoadState: "ready",
      statusOpen: false
    });
    render(<PermanentChatDeletionSurface />);

    expect(screen.getByRole("status")).toHaveTextContent("Chat deletion completed");
    expect(screen.queryByRole("button", { name: "View progress" })).not.toBeInTheDocument();
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    act(() => dismiss.focus());
    act(() => vi.advanceTimersByTime(COMPLETED_NOTICE_DISMISS_MS * 2));
    expect(screen.getByRole("status")).toHaveTextContent("Chat deletion completed");

    act(() => dismiss.blur());
    act(() => vi.advanceTimersByTime(COMPLETED_NOTICE_DISMISS_MS));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(usePermanentChatDeletionStore.getState().reference).toBeNull();
  });

  it("dismisses a completed notice from its own button", () => {
    usePermanentChatDeletionStore.setState({
      reference: { chatId: "chat-1" },
      status: { status: "COMPLETE" },
      statusLoadState: "ready",
      statusOpen: false
    });
    render(<PermanentChatDeletionSurface />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(usePermanentChatDeletionStore.getState().reference).toBeNull();
  });

  it("leaves no notice behind when a completed status is closed with its X", () => {
    usePermanentChatDeletionStore.setState({
      reference: { chatId: "chat-1" },
      status: { status: "COMPLETE" },
      statusLoadState: "ready",
      statusOpen: true
    });
    render(<PermanentChatDeletionSurface />);

    const dialog = screen.getByRole("dialog", { name: "Permanent deletion" });
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(usePermanentChatDeletionStore.getState().reference).toBeNull();
  });
});
