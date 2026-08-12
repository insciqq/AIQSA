import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySettingsFixture } from "./memoryTestFixtures";
import { resetMemorySettingsStoreForTest, useMemorySettingsStore } from "./memorySettingsStore";
import { PermanentChatDeletionSurface } from "./PermanentChatDeletionSurface";
import {
  activatePermanentChatDeletionAccount,
  openPermanentChatDeletion,
  resetPermanentChatDeletionStoreForTest,
  usePermanentChatDeletionStore
} from "./permanentChatDeletionStore";

const now = "2026-08-12T10:00:00.000Z";

beforeEach(async () => {
  resetPermanentChatDeletionStoreForTest();
  resetMemorySettingsStoreForTest();
  window.sessionStorage.clear();
  useMemorySettingsStore.setState({
    data: memorySettingsFixture({ capabilities: { permanentChatDeletion: true } }),
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
      expectedActiveLeafMessageId: "message-1",
      expectedChatRevision: 4,
      location: "WORKSPACE",
      title: "Research notes"
    });
    render(<PermanentChatDeletionSurface locale="EN" />);

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

  it("shows private-safe blocked progress, with identifiers only in Advanced", () => {
    usePermanentChatDeletionStore.setState({
      reference: { chatId: "chat-1", deletionId: "deletion-secret-1" },
      status: {
        attemptCount: 7,
        cleanupComplete: false,
        deletionId: "deletion-secret-1",
        errorCode: "memory_cleanup_residual",
        fencedAt: now,
        lastAuditAt: now,
        state: "BLOCKED_REQUIRES_ADMIN",
        updatedAt: now
      },
      statusLoadState: "ready",
      statusOpen: true
    });
    render(<PermanentChatDeletionSurface locale="EN" />);

    const dialog = screen.getByRole("dialog", { name: "Permanent deletion" });
    expect(within(dialog).getByText(/administrator attention/i)).toBeVisible();
    expect(within(dialog).queryByText("Research notes")).not.toBeInTheDocument();
    expect(within(dialog).getByText("deletion-secret-1")).not.toBeVisible();
    fireEvent.click(within(dialog).getByText("Advanced details"));
    expect(within(dialog).getByText("deletion-secret-1")).toBeVisible();
    expect(within(dialog).getByText("memory_cleanup_residual")).toBeVisible();
  });

  it("collapses background progress to a durable actionable notice", () => {
    usePermanentChatDeletionStore.setState({
      reference: { chatId: "chat-1", deletionId: "deletion-1" },
      status: {
        attemptCount: 0,
        cleanupComplete: false,
        deletionId: "deletion-1",
        errorCode: null,
        fencedAt: now,
        lastAuditAt: null,
        state: "RUNNING",
        updatedAt: now
      },
      statusLoadState: "ready",
      statusOpen: false
    });
    render(<PermanentChatDeletionSurface locale="RU" />);

    expect(screen.getByRole("status")).toHaveTextContent("Chat deleted · cleanup is finishing");
    fireEvent.click(screen.getByRole("button", { name: "View progress" }));
    expect(screen.getByRole("dialog", { name: "Permanent deletion" })).toBeVisible();
  });
});
