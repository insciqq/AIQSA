import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMemorySettingsStore } from "@/components/app-shell/memorySettingsStore";
import { memoryConsumerSettingsFixture } from "@/tests/support/memoryFixtures";
import { resetMemorySettingsStoreForTest } from "@/tests/support/appShellStores";
import { MemorySettingsRowsV2 } from "./MemorySettingsRowsV2";

const memoryApi = vi.hoisted(() => ({
  loadMemorySettings: vi.fn(),
  resetPersonalMemory: vi.fn()
}));

vi.mock("@/components/app-shell/memoryApi", async () => {
  const actual = await vi.importActual<typeof import("@/components/app-shell/memoryApi")>(
    "@/components/app-shell/memoryApi"
  );
  return { ...actual, ...memoryApi };
});

describe("MemorySettingsRowsV2", () => {
  beforeEach(() => {
    resetMemorySettingsStoreForTest();
    memoryApi.loadMemorySettings.mockReset();
    memoryApi.resetPersonalMemory.mockReset();
  });

  afterEach(() => {
    resetMemorySettingsStoreForTest();
  });

  it("renders one master switch and keeps saved-memory management available while paused", () => {
    const data = memoryConsumerSettingsFixture({
      settings: {
        learnAutomatically: true,
        referenceChatHistory: true,
        useMemoryFacts: false
      },
      status: "PAUSED"
    });
    useMemorySettingsStore.setState({ data, loadState: "ready" });
    const onOpenLibrary = vi.fn();
    render(<MemorySettingsRowsV2 onOpenLibrary={onOpenLibrary} />);

    expect(screen.getAllByRole("switch")).toHaveLength(5);
    expect(screen.getByRole("switch", { name: "Use memories in answers: off" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Search past chats: on" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Learn automatically: on" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Notice repeated details: off" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Learn from what you use: off" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.getByTestId("settings-memory-status")).toHaveTextContent("Memory is paused");
    fireEvent.click(screen.getByRole("button", { name: "Open in Library" }));
    expect(onOpenLibrary).toHaveBeenCalledOnce();
  });

  it("shows durable reset progress and prevents a second reset", () => {
    useMemorySettingsStore.setState({
      data: memoryConsumerSettingsFixture({ resetState: "IN_PROGRESS" }),
      loadState: "ready"
    });
    render(<MemorySettingsRowsV2 onOpenLibrary={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Memory is off. Reset cleanup is continuing in the background."
    );
    expect(screen.getByRole("button", { name: "Forget everything…" })).toBeDisabled();
  });

  it("resets only after the consequence-naming confirmation and supports Escape", async () => {
    const data = memoryConsumerSettingsFixture({
      settings: { useMemoryFacts: true },
      status: "ON"
    });
    useMemorySettingsStore.setState({ data, loadState: "ready" });
    memoryApi.resetPersonalMemory.mockResolvedValue({ status: "COMPLETE" });
    memoryApi.loadMemorySettings.mockResolvedValue(memoryConsumerSettingsFixture());
    render(<MemorySettingsRowsV2 onOpenLibrary={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "Forget everything…" });
    fireEvent.click(trigger);
    let confirmation = screen.getByRole("alertdialog", { name: "Forget everything?" });
    expect(confirmation).toHaveTextContent("your conversations are not deleted");
    expect(memoryApi.resetPersonalMemory).not.toHaveBeenCalled();
    const cancel = screen.getByRole("button", { name: "Keep my memories" });
    const confirm = screen.getByRole("button", { name: "Forget everything" });
    expect(cancel).toHaveFocus();
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(confirmation, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Forget everything…" }));
    confirmation = screen.getByRole("alertdialog", { name: "Forget everything?" });
    fireEvent.click(screen.getByRole("button", { name: "Forget everything" }));
    expect(memoryApi.resetPersonalMemory).toHaveBeenCalledOnce();
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(screen.getByTestId("settings-memory-reset")).toHaveTextContent("Personal Memory was reset.");
  });

  it("keeps reset open on failure and suppresses a duplicate in-flight request", async () => {
    useMemorySettingsStore.setState({
      data: memoryConsumerSettingsFixture({ status: "ON" }),
      loadState: "ready"
    });
    let rejectReset: ((reason?: unknown) => void) | undefined;
    memoryApi.resetPersonalMemory.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectReset = reject;
    }));
    render(<MemorySettingsRowsV2 onOpenLibrary={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Forget everything…" }));
    const confirm = screen.getByRole("button", { name: "Forget everything" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(memoryApi.resetPersonalMemory).toHaveBeenCalledOnce();
    rejectReset?.(new Error("offline"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Memory could not be reset. Nothing was reported as deleted."
    );
    expect(screen.getByRole("alertdialog", { name: "Forget everything?" })).toBeVisible();
  });
});
