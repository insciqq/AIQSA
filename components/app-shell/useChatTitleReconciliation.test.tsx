import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceChatSummary } from "./types";
import { chatSummaryFromApi } from "./shellApi";
import { useChatTitleReconciliation } from "./useChatTitleReconciliation";
import { initialWorkspaceSnapshot, useWorkspaceStore } from "./workspaceStore";

const chat: WorkspaceChatSummary = chatSummaryFromApi({
  activeLeafMessageId: "answer", createdAt: "2026-01-01T00:00:00Z", defaultModelId: "model",
  defaultProvider: "provider", folderId: null, id: "chat", messageCount: 2, pinned: false,
  title: "First question", titlePending: true, updatedAt: "2026-01-01T00:00:00Z"
});
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe("chat title metadata reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    useWorkspaceStore.setState({ ...initialWorkspaceSnapshot, activeChatId: "another-chat", chats: [chat],
      navigationChats: [{ activeRun: true, folderId: null, id: chat.id, title: chat.title, updatedAt: chat.updatedAt }] });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); useWorkspaceStore.setState(initialWorkspaceSnapshot); });

  it("updates an inactive chat's title without changing its controls or the active chat and stops on settlement", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ pending: false, title: "Network protocol comparison" }));
    renderHook(() => useChatTitleReconciliation({ accountId: "user", chats: [chat] }));
    await advance(1_000);
    expect(useWorkspaceStore.getState().chats).toEqual([{ ...chat, title: "Network protocol comparison", titlePending: false }]);
    expect(useWorkspaceStore.getState().activeChatId).toBe("another-chat");
    expect(useWorkspaceStore.getState().navigationChats[0]).toMatchObject({ activeRun: true, title: "Network protocol comparison" });
    await advance(360_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves a newer manual rename and second-turn controls while an old metadata request is pending", async () => {
    let finish!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    renderHook(() => useChatTitleReconciliation({ accountId: "user", chats: [chat] }));
    await advance(1_000);
    const newer = { ...chat, title: "My manual name", titlePending: false, defaultModelId: "new-model", messageCount: 4 };
    act(() => useWorkspaceStore.setState({ chats: [newer] }));
    await act(async () => { finish(Response.json({ pending: false, title: "Stale generated title" })); });
    expect(useWorkspaceStore.getState().chats).toEqual([newer]);
    await advance(360_000);
  });

  it("aborts outstanding metadata work on account change and disposal", async () => {
    const signals: AbortSignal[] = [];
    const releases: Array<(response: Response) => void> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, options) => {
      signals.push(options!.signal!);
      return new Promise<Response>((resolve) => releases.push(resolve));
    });
    const { rerender, unmount } = renderHook((value) => useChatTitleReconciliation(value), {
      initialProps: { accountId: "user", chats: [chat] }
    });
    await advance(1_000);
    rerender({ accountId: "next-user", chats: [chat] });
    expect(signals[0]!.aborted).toBe(true);
    await advance(1_000);
    unmount();
    expect(signals[1]!.aborted).toBe(true);
    await act(async () => { releases.forEach((resolve) => resolve(Response.json({ pending: false, title: "Ignored" }))); });
    expect(useWorkspaceStore.getState().chats).toEqual([chat]);
  });
});
