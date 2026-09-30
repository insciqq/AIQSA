import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceChatSummary } from "./types";
import { chatSummaryFromApi } from "./shellApi";
import { useChatTitleReconciliation } from "./useChatTitleReconciliation";
import { initialWorkspaceSnapshot, useWorkspaceStore } from "./workspaceStore";
import { initialThreadStoreState, useThreadStore } from "./threadStore";
import { initialRunLifecycleSnapshot, useRunLifecycleStore } from "./runLifecycleStore";
import { useComposerSessionStore } from "./composerSessionStore";

const chat: WorkspaceChatSummary = chatSummaryFromApi({
  activeLeafMessageId: "answer", createdAt: "2026-01-01T00:00:00Z", defaultModelId: "model",
  defaultProvider: "provider", folderId: null, id: "chat", messageCount: 2, pinned: false,
  title: "First question", titlePending: true, updatedAt: "2026-01-01T00:00:00Z"
});
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe("chat title metadata reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useThreadStore.setState(initialThreadStoreState);
    useRunLifecycleStore.setState(initialRunLifecycleSnapshot);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    useWorkspaceStore.setState({ ...initialWorkspaceSnapshot, activeChatId: "another-chat", chats: [chat],
      navigationChats: [{ activeRun: true, assistant: null, folderId: null, id: chat.id, title: chat.title, updatedAt: chat.updatedAt }] });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); useWorkspaceStore.setState(initialWorkspaceSnapshot);
    useThreadStore.setState(initialThreadStoreState); useRunLifecycleStore.setState(initialRunLifecycleSnapshot); });

  const totals = { hasCompletedAnswer: true, recordCount: 2, knownCostRecordCount: 2,
    incompleteRecordCount: 0, totalTokens: 20, estimatedCostMicros: 2000 };
  function thread() {
    useThreadStore.getState().replaceThread(chat.id, { activeLeafId: "answer", sourceUpdatedAt: chat.updatedAt,
      messages: [], usageStats: { ...totals, recordCount: 1, knownCostRecordCount: 1, totalTokens: 10 } });
    return useThreadStore.getState().threadsByChatId[chat.id]!;
  }
  it("refreshes settled spending even when the title is unchanged, preserving a typed draft and thread", async () => {
    const before = thread();
    const composer = useComposerSessionStore.getState(); composer.setDraft("Keep my draft");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ pending: false, title: chat.title,
      updatedAt: "2026-01-01T00:00:01.000Z", usageStats: totals }));
    renderHook(() => useChatTitleReconciliation({ accountId: "user", chats: [chat] }));
    await advance(1000);
    expect(fetchMock).toHaveBeenCalledWith("/api/chats/chat/title?usage=1", expect.any(Object));
    expect(useThreadStore.getState().threadsByChatId[chat.id]).toEqual({ ...before, usageStats: totals });
    expect(useComposerSessionStore.getState().sessionsByKey[composer.activeSessionKey]?.draft).toBe("Keep my draft");
    await advance(30_000); expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["stream", "newer thread", "older revision", "account", "revoked"])("does not replace spending after %s changes", async boundary => {
    const before = thread(); let finish!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const hook = renderHook(({ accountId }) => useChatTitleReconciliation({ accountId, chats: [chat] }), { initialProps: { accountId: "user" } });
    await advance(1000);
    if (boundary === "stream") useRunLifecycleStore.getState().streamStarted({ chatId: chat.id, producer: "new" });
    if (boundary === "newer thread") useThreadStore.getState().mergeMessages(chat.id, [], { usageStats: { ...totals, totalTokens: 99 } });
    if (boundary === "account") hook.rerender({ accountId: "different" });
    const expected = useThreadStore.getState().threadsByChatId[chat.id]!.usageStats;
    await act(async () => { finish(Response.json({ pending: false, title: chat.title,
      updatedAt: boundary === "older revision" ? "2025-01-01T00:00:00Z" : "2026-01-01T00:00:01Z", usageStats: totals },
    { status: boundary === "revoked" ? 404 : 200 })); });
    expect(useThreadStore.getState().threadsByChatId[chat.id]!.usageStats).toEqual(expected);
    expect(before.messages).toEqual([]);
  });

  it("retries accounting at the existing cadence while a manual name and live stream keep their ownership", async () => {
    thread();
    useRunLifecycleStore.getState().streamStarted({ chatId: chat.id, producer: "current" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ pending: false, title: "Manual name", updatedAt: chat.updatedAt, usagePending: true }))
      .mockImplementation(async () => Response.json({ pending: false, title: "Manual name", updatedAt: chat.updatedAt, usagePending: false, usageStats: totals }));
    const hook = renderHook(({ chats }) => useChatTitleReconciliation({ accountId: "user", chats }), { initialProps: { chats: [chat] } });
    await advance(1000);
    const settled = useWorkspaceStore.getState().chats;
    hook.rerender({ chats: settled });
    await advance(2000);
    expect(useThreadStore.getState().threadsByChatId[chat.id]!.usageStats?.totalTokens).toBe(10);
    useRunLifecycleStore.getState().streamFinished({ chatId: chat.id, producer: "current" });
    await advance(4000);
    expect(useThreadStore.getState().threadsByChatId[chat.id]!.usageStats).toEqual(totals);
    expect(useWorkspaceStore.getState().chats[0]!.title).toBe("Manual name");
  });

  it("keeps the bounded accounting refresh when a manual rename removes pending title presentation", async () => {
    thread();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ pending: false, title: "Manual name",
      usagePending: false, updatedAt: chat.updatedAt, usageStats: totals }));
    const hook = renderHook(({ chats }) => useChatTitleReconciliation({ accountId: "user", chats }), { initialProps: { chats: [chat] } });
    const manuallyRenamed = { ...chat, title: "Manual name", titlePending: false };
    act(() => useWorkspaceStore.setState({ chats: [manuallyRenamed] }));
    hook.rerender({ chats: [manuallyRenamed] });
    await advance(1000);
    expect(useThreadStore.getState().threadsByChatId[chat.id]!.usageStats).toEqual(totals);
    expect(useWorkspaceStore.getState().chats[0]).toEqual(manuallyRenamed);
  });

  it("starts accounting reconciliation after cold entry with a settled-looking title but a pending receipt", async () => {
    thread();
    const manuallyNamed = { ...chat, title: "Manual name", titlePending: false };
    useWorkspaceStore.setState({ chats: [manuallyNamed] });
    useThreadStore.getState().mergeMessages(chat.id, [], { usageStats: { ...totals, totalTokens: 10, titleUsagePending: true } });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ pending: false, usagePending: false,
      title: "Manual name", updatedAt: chat.updatedAt, usageStats: totals }));
    renderHook(() => useChatTitleReconciliation({ accountId: "user", chats: [manuallyNamed] }));
    await advance(1000);
    expect(fetchMock).toHaveBeenCalledWith("/api/chats/chat/title?usage=1", expect.anything());
    expect(useThreadStore.getState().threadsByChatId[chat.id]!.usageStats).toEqual(totals);
    await advance(30_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refreshes a thread opened while the terminal title-only response was in flight", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(Response.json({ pending: false, usagePending: false, title: "Settled title",
        updatedAt: chat.updatedAt, usageStats: totals }));
    const hook = renderHook(({ chats }) => useChatTitleReconciliation({ accountId: "user", chats }), { initialProps: { chats: [chat] } });
    await advance(1000);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/chats/chat/title");
    thread();
    await act(async () => { finish(Response.json({ pending: false, title: "Settled title", updatedAt: chat.updatedAt })); });
    hook.rerender({ chats: useWorkspaceStore.getState().chats });
    await advance(2000);
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/chats/chat/title?usage=1");
    expect(useThreadStore.getState().threadsByChatId[chat.id]!.usageStats).toEqual(totals);
  });

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

  it("adopts the newer chat revision produced by the title write and never rewinds a newer copy", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ pending: true, title: chat.title, updatedAt: "2025-12-31T00:00:00.000Z" }))
      .mockResolvedValueOnce(Response.json({ pending: false, title: "Titled", updatedAt: "2026-01-01T00:00:05.000Z" }));
    renderHook(() => useChatTitleReconciliation({ accountId: "user", chats: [chat] }));
    await advance(1_000);
    expect(useWorkspaceStore.getState().chats[0]).toMatchObject({ titlePending: true, updatedAt: chat.updatedAt });
    await advance(2_000);
    expect(useWorkspaceStore.getState().chats[0]).toMatchObject({
      title: "Titled",
      titlePending: false,
      updatedAt: "2026-01-01T00:00:05.000Z"
    });
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

  it("applies a completed title while preserving unrelated concurrent chat updates", async () => {
    let finish!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    renderHook(() => useChatTitleReconciliation({ accountId: "user", chats: [chat] }));
    await advance(1_000);
    const newer = { ...chat, defaultModelId: "new-model", messageCount: 4 };
    act(() => useWorkspaceStore.setState({ chats: [newer] }));
    await act(async () => { finish(Response.json({ pending: false, title: "Network protocols" })); });
    expect(useWorkspaceStore.getState().chats).toEqual([{ ...newer, title: "Network protocols", titlePending: false }]);
  });

  it("resumes reconciliation after a hidden tab outlives the polling window", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ pending: false, title: "A finished title" }));
    renderHook(() => useChatTitleReconciliation({ accountId: "user", chats: [chat] }));
    await advance(400_000);
    expect(fetchMock).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(1_000);
    expect(useWorkspaceStore.getState().chats[0]).toMatchObject({ title: "A finished title", titlePending: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the existing backoff when another chat starts waiting for a title", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ pending: true, title: chat.title }));
    const { rerender } = renderHook((chats: WorkspaceChatSummary[]) => useChatTitleReconciliation({ accountId: "user", chats }), {
      initialProps: [chat]
    });
    await advance(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = { ...chat, id: "second" };
    act(() => useWorkspaceStore.setState({ chats: [chat, second] }));
    rerender([chat, second]);
    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.slice(2).map(([url]) => url)).toEqual(["/api/chats/chat/title", "/api/chats/second/title"]);
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
