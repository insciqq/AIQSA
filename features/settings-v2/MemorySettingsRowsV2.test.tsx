import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMemorySettingsStore } from "@/components/app-shell/memorySettingsStore";
import { openMemoryManager, useMemoryManagerStore } from "@/components/app-shell/memoryManagerStore";
import { memoryConsumerItemFixture, memoryConsumerListFixture, memoryConsumerSettingsFixture } from "@/tests/support/memoryFixtures";
import { resetMemoryManagerStoreForTest, resetMemorySettingsStoreForTest } from "@/tests/support/appShellStores";
import { MemorySettingsRowsV2 } from "./MemorySettingsRowsV2";

const memoryApi = vi.hoisted(() => ({
  loadMemorySettings: vi.fn(),
  listMemories: vi.fn(),
  patchMemorySettings: vi.fn(),
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
    resetMemoryManagerStoreForTest();
    resetMemorySettingsStoreForTest();
    memoryApi.loadMemorySettings.mockReset();
    memoryApi.loadMemorySettings.mockResolvedValue(memoryConsumerSettingsFixture());
    memoryApi.listMemories.mockReset().mockResolvedValue(memoryConsumerListFixture([]));
    memoryApi.patchMemorySettings.mockReset();
    memoryApi.resetPersonalMemory.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetMemorySettingsStoreForTest();
    resetMemoryManagerStoreForTest();
  });

  it.each([
    ["Use memories in answers", "useMemoryFacts"],
    ["Search past chats", "referenceChatHistory"],
    ["Learn automatically", "learnAutomatically"],
    ["Learn from what you use", "decayEnabled"]
  ] as const)("can enable %s while its runtime capability is inactive", async (label, key) => {
    const data = memoryConsumerSettingsFixture({
      capabilities: {
        automaticLearningAvailable: false,
        decayAvailable: false,
        naturalLanguageActionsAvailable: false,
        pastChatIndexingAvailable: false,
        retrievalAvailable: false,
        synthesisAvailable: false
      }
    });
    useMemorySettingsStore.setState({ data, loadState: "ready" });
    memoryApi.patchMemorySettings.mockResolvedValue({
      ...data,
      settings: { ...data.settings, [key]: true }
    });
    render(<MemorySettingsRowsV2 />);

    const control = screen.getByRole("switch", { name: `${label}: off` });
    expect(control).toBeEnabled();
    fireEvent.click(control);

    await waitFor(() => expect(memoryApi.patchMemorySettings).toHaveBeenCalledWith({ [key]: true }));
    await waitFor(() => expect(screen.getByRole("switch", { name: `${label}: on` }))
      .toHaveAttribute("aria-checked", "true"));
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
    render(<MemorySettingsRowsV2 />);

    expect(screen.getAllByRole("switch")).toHaveLength(4);
    expect(screen.getByRole("switch", { name: "Use memories in answers: off" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Search past chats: on" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Learn automatically: on" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Learn from what you use: off" })).toBeEnabled();
    expect(screen.queryByRole("switch", { name: /Notice repeated details/u })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.getByTestId("settings-memory-status")).toHaveTextContent("Memory is paused");
    expect(screen.queryByRole("button", { name: "Open in Library" })).toBeNull();
  });

  it("hides a lost acknowledgement and reconciles by reading without repeating the mutation", async () => {
    const original = memoryConsumerSettingsFixture({ settings: { learnAutomatically: true }, status: "ON" });
    const current = memoryConsumerSettingsFixture({ settings: { learnAutomatically: false }, status: "ON" });
    useMemorySettingsStore.setState({ data: original, loadState: "ready" });
    // The server changed, but its acknowledgement did not reach the client.
    memoryApi.patchMemorySettings.mockRejectedValue(new TypeError("network error"));
    memoryApi.loadMemorySettings.mockResolvedValue(current);
    render(<MemorySettingsRowsV2 />);
    fireEvent.click(screen.getByRole("switch", { name: "Learn automatically: on" }));

    await waitFor(() => expect(screen.getByRole("switch", { name: "Learn automatically: off" })).toBeEnabled());
    for (const control of screen.getAllByRole("switch")) expect(control).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/could not|confirmed|error/iu)).toBeNull();
    expect(memoryApi.patchMemorySettings).toHaveBeenCalledOnce();
    expect(memoryApi.loadMemorySettings).toHaveBeenCalledOnce();
  });

  it("returns a failed switch to its saved value and keeps every switch usable", async () => {
    const original = memoryConsumerSettingsFixture({ settings: { referenceChatHistory: false }, status: "ON" });
    useMemorySettingsStore.setState({ data: original, loadState: "ready" });
    memoryApi.patchMemorySettings.mockRejectedValue(Object.assign(new Error("memory_action_failed"), { status: 500 }));
    memoryApi.loadMemorySettings.mockRejectedValue(new TypeError("offline"));
    vi.useFakeTimers();
    render(<MemorySettingsRowsV2 />);
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Search past chats: off" }));
      await vi.advanceTimersByTimeAsync(7_000);
    });

    expect(screen.getByRole("switch", { name: "Search past chats: off" })).toBeEnabled();
    for (const control of screen.getAllByRole("switch")) expect(control).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useMemorySettingsStore.getState()).toMatchObject({ busy: null, data: original, error: null });
  });

  it("shows no status for temporarily unavailable Memory and keeps the switches usual", () => {
    useMemorySettingsStore.setState({
      data: memoryConsumerSettingsFixture({ settings: { useMemoryFacts: true }, status: "UNAVAILABLE" }),
      loadState: "ready"
    });
    render(<MemorySettingsRowsV2 />);

    expect(screen.queryByTestId("settings-memory-status")).toBeNull();
    expect(screen.queryByText(/unavailable/iu)).toBeNull();
    expect(screen.getByRole("switch", { name: "Use memories in answers: on" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows administrator setup as a neutral status without an alert", () => {
    useMemorySettingsStore.setState({
      data: memoryConsumerSettingsFixture({ status: "NEEDS_ADMIN_SETUP" }),
      loadState: "ready"
    });
    render(<MemorySettingsRowsV2 />);

    const status = screen.getByTestId("settings-memory-status");
    expect(status).toHaveTextContent("Memory needs administrator setup");
    expect(status).toHaveAttribute("data-state", "off");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers a calm Reload after a failed first load, without an alert", async () => {
    vi.useFakeTimers();
    memoryApi.loadMemorySettings.mockReset()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue(memoryConsumerSettingsFixture({ status: "ON" }));
    render(<MemorySettingsRowsV2 />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Memory settings");
    await act(async () => { await vi.advanceTimersByTimeAsync(7_000); });

    expect(memoryApi.loadMemorySettings).toHaveBeenCalledTimes(4);
    const reload = screen.getByTestId("memory-settings-reload");
    expect(reload).toHaveTextContent("Reload to see your Memory settings.");
    expect(reload).not.toHaveAttribute("role");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/error|could not/iu)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getAllByRole("switch")).toHaveLength(4);
  });

  it("shows durable reset progress and prevents a second reset", () => {
    useMemorySettingsStore.setState({
      data: memoryConsumerSettingsFixture({ resetState: "IN_PROGRESS" }),
      loadState: "ready"
    });
    render(<MemorySettingsRowsV2 />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Memory is off. Reset cleanup is continuing in the background."
    );
    expect(screen.getByRole("button", { name: "Forget everything…" })).toBeDisabled();
    for (const control of screen.getAllByRole("switch")) expect(control).toBeDisabled();
  });

  it("resets only after the consequence-naming confirmation and supports Escape", async () => {
    const data = memoryConsumerSettingsFixture({
      settings: { useMemoryFacts: true },
      status: "ON"
    });
    useMemorySettingsStore.setState({ data, loadState: "ready" });
    useMemoryManagerStore.setState({
      memories: [memoryConsumerItemFixture()], queryInput: "old", queryApplied: "old",
      screen: "create", draft: { statement: "Unsaved detail" }, draftDirty: true
    });
    memoryApi.resetPersonalMemory.mockResolvedValue({ status: "COMPLETE" });
    memoryApi.loadMemorySettings.mockResolvedValue(memoryConsumerSettingsFixture());
    render(<MemorySettingsRowsV2 />);

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
    await waitFor(() => expect(memoryApi.listMemories).toHaveBeenCalledOnce());
    expect(useMemoryManagerStore.getState()).toMatchObject({
      memories: [], queryInput: "", queryApplied: "", draft: { statement: "" },
      draftDirty: false, resetPending: false, screen: "list"
    });
  });

  it("settles background reset progress and re-enables controls without reopening Settings", async () => {
    vi.useFakeTimers();
    useMemorySettingsStore.setState({
      data: memoryConsumerSettingsFixture({ status: "ON" }),
      loadState: "ready"
    });
    memoryApi.resetPersonalMemory.mockResolvedValue({ status: "IN_PROGRESS" });
    memoryApi.loadMemorySettings
      .mockResolvedValueOnce(memoryConsumerSettingsFixture({ resetState: "IN_PROGRESS" }))
      .mockResolvedValue(memoryConsumerSettingsFixture({ resetState: "IDLE" }));
    render(<MemorySettingsRowsV2 />);
    fireEvent.click(screen.getByRole("button", { name: "Forget everything…" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Forget everything" }));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Reset cleanup is continuing");
    for (const control of screen.getAllByRole("switch")) expect(control).toBeDisabled();

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(screen.getByRole("status")).toHaveTextContent("Personal Memory was reset.");
    for (const control of screen.getAllByRole("switch")) expect(control).toBeEnabled();
    expect(screen.getByRole("button", { name: "Forget everything…" })).toBeEnabled();
  });

  it("keeps reset open without a message on failure and suppresses a duplicate in-flight request", async () => {
    const retained = memoryConsumerItemFixture({ statement: "Still saved after an unconfirmed reset." });
    memoryApi.listMemories.mockResolvedValue(memoryConsumerListFixture([retained]));
    useMemorySettingsStore.setState({
      data: memoryConsumerSettingsFixture({ status: "ON" }),
      loadState: "ready"
    });
    let rejectReset: ((reason?: unknown) => void) | undefined;
    memoryApi.resetPersonalMemory.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectReset = reject;
    }));
    render(<MemorySettingsRowsV2 />);

    fireEvent.click(screen.getByRole("button", { name: "Forget everything…" }));
    const confirm = screen.getByRole("button", { name: "Forget everything" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(memoryApi.resetPersonalMemory).toHaveBeenCalledOnce();
    rejectReset?.(new Error("offline"));

    await waitFor(() => expect(useMemoryManagerStore.getState()).toMatchObject({
      memories: [retained], resetPending: false, listLoadState: "ready"
    }));
    expect(screen.getByRole("alertdialog", { name: "Forget everything?" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Forget everything" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/could not be confirmed/iu)).toBeNull();
    expect(screen.getByTestId("settings-memory-reset")).not.toHaveTextContent(/reset/iu);
  });

  it("reconciles a background reset after reopening the Memory page", async () => {
    vi.useFakeTimers();
    useMemoryManagerStore.setState({ resetPending: true });
    useMemorySettingsStore.setState({ data: memoryConsumerSettingsFixture(), loadState: "ready" });
    render(<MemorySettingsRowsV2 />);
    expect(screen.getByRole("button", { name: "Forget everything…" })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(useMemoryManagerStore.getState().resetPending).toBe(false);
    expect(memoryApi.listMemories).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Forget everything…" })).toBeEnabled();
  });

  it("keeps background reset polling when the manager binds its account after mount", async () => {
    vi.useFakeTimers();
    useMemorySettingsStore.setState({ data: memoryConsumerSettingsFixture({ resetState: "IN_PROGRESS" }), loadState: "ready" });
    render(<MemorySettingsRowsV2 />);
    await act(async () => { await openMemoryManager("owner"); });
    expect(useMemoryManagerStore.getState()).toMatchObject({ accountId: "owner", resetPending: true, memories: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(useMemoryManagerStore.getState()).toMatchObject({ accountId: "owner", resetPending: false, listLoadState: "ready" });
  });
});
