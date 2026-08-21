import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryConsumerSettingsFixture } from "@/tests/support/memoryFixtures";
import { useMemorySettingsStore } from "./memorySettingsStore";
import { PermanentChatDeletionSurface } from "./PermanentChatDeletionSurface";
import { activatePermanentChatDeletionAccount, openPermanentChatDeletion, usePermanentChatDeletionStore } from "./permanentChatDeletionStore";
import { resetMemorySettingsStoreForTest, resetPermanentChatDeletionStoreForTest } from "@/tests/support/appShellStores";

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
      within(dialog).getAllByRole("button", { name: "Cancel" })[0]
    ).toHaveFocus());
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

  it("collapses background progress to a durable actionable notice", () => {
    usePermanentChatDeletionStore.setState({
      reference: { chatId: "chat-1" },
      status: { status: "IN_PROGRESS" },
      statusLoadState: "ready",
      statusOpen: false
    });
    render(<PermanentChatDeletionSurface />);

    expect(screen.getByRole("status")).toHaveTextContent("Chat deleted · cleanup is finishing");
    fireEvent.click(screen.getByRole("button", { name: "View progress" }));
    expect(screen.getByRole("dialog", { name: "Permanent deletion" })).toBeVisible();
  });
});
