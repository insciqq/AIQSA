import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatSummaryFromApi } from "@/components/app-shell/shellApi";
import type { WorkspaceChatSummary } from "@/components/app-shell/types";
import {
  branchSnapshotCoversRevision,
  useBranchGraphController
} from "./useBranchGraphController";

const T0 = "2026-09-27T10:00:00.000Z";
const T1 = "2026-09-27T10:00:05.000Z";
const T2 = "2026-09-27T10:01:00.000Z";

function summary(id: string, updatedAt: string): WorkspaceChatSummary {
  return chatSummaryFromApi({
    activeLeafMessageId: `${id}-answer`,
    createdAt: T0,
    defaultModelId: "model",
    defaultProvider: "provider",
    folderId: null,
    id,
    messageCount: 2,
    pinned: false,
    title: id,
    updatedAt
  });
}

function graphResponse(chatId: string, snapshotUpdatedAt: string): Response {
  return Response.json({
    branchGraph: {
      activeLeafMessageId: `${chatId}-answer`,
      nodes: [
        { id: `${chatId}-question`, parentMessageId: null, preview: "Question", role: "user", status: "complete" },
        { id: `${chatId}-answer`, parentMessageId: `${chatId}-question`, preview: "Answer", role: "assistant", status: "complete" }
      ],
      snapshotUpdatedAt
    }
  });
}

type HookProps = Parameters<typeof useBranchGraphController>[0];

const flush = async (ms = 0) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

function branchRequests(fetchMock: { mock: { calls: unknown[][] } }, chatId = "chat-a"): number {
  return fetchMock.mock.calls.filter((call) =>
    String(call[0]) === `/api/chats/${chatId}/branches`
  ).length;
}

function renderController(initial: HookProps) {
  return renderHook((props: HookProps) => useBranchGraphController(props), {
    initialProps: initial
  });
}

describe("branch graph request liveness", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("treats a server snapshot at or after the summary revision as current", () => {
    expect(branchSnapshotCoversRevision(T1, T0)).toBe(true);
    expect(branchSnapshotCoversRevision(T0, T0)).toBe(true);
    expect(branchSnapshotCoversRevision(T0, T1)).toBe(false);
    expect(branchSnapshotCoversRevision(null, T0)).toBe(false);
    expect(branchSnapshotCoversRevision("not-a-date", T0)).toBe(false);
  });

  it("does not chase a newer server snapshot that the summary has not seen yet", async () => {
    // Title generation or a leaf deletion bumped the server revision to T1
    // while the browser summary still says T0.
    const fetchMock = vi.fn(async () => graphResponse("chat-a", T1));
    vi.stubGlobal("fetch", fetchMock);
    const props: HookProps = {
      activeChatId: "chat-a",
      activeChatStreaming: false,
      branchDrawerOpen: false,
      chats: [summary("chat-a", T0)]
    };
    const hook = renderController(props);
    await flush();
    await flush(60_000);
    hook.rerender({ ...props, chats: [summary("chat-a", T0)] });
    await flush(60_000);
    expect(branchRequests(fetchMock)).toBe(1);
    expect(hook.result.current.branchGraph).toMatchObject({ loading: false, snapshotUpdatedAt: T1 });

    // Adopting the server revision needs no further request.
    hook.rerender({ ...props, chats: [summary("chat-a", T1)] });
    await flush(60_000);
    expect(branchRequests(fetchMock)).toBe(1);

    // A genuinely newer revision refreshes exactly once.
    fetchMock.mockImplementation(async () => graphResponse("chat-a", T2));
    hook.rerender({ ...props, chats: [summary("chat-a", T2)] });
    await flush(60_000);
    expect(branchRequests(fetchMock)).toBe(2);
    expect(hook.result.current.branchGraph).toMatchObject({ snapshotUpdatedAt: T2 });
  });

  it("requests at most once per distinct summary revision when the server snapshot stays older", async () => {
    const fetchMock = vi.fn(async () => graphResponse("chat-a", T0));
    vi.stubGlobal("fetch", fetchMock);
    const props: HookProps = {
      activeChatId: "chat-a",
      activeChatStreaming: false,
      branchDrawerOpen: true,
      chats: [summary("chat-a", T1)]
    };
    const hook = renderController(props);
    await flush(60_000);
    hook.rerender({ ...props, chats: [summary("chat-a", T1)] });
    await flush(60_000);
    expect(branchRequests(fetchMock)).toBe(1);

    hook.rerender({ ...props, chats: [summary("chat-a", T2)] });
    await flush(60_000);
    expect(branchRequests(fetchMock)).toBe(2);
  });

  it("keeps a failed HTTP outcome steady until an explicit retry or a new revision", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "internal_error" }, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const props: HookProps = {
      activeChatId: "chat-a",
      activeChatStreaming: false,
      branchDrawerOpen: true,
      chats: [summary("chat-a", T0)]
    };
    const hook = renderController(props);
    await flush(10 * 60_000);
    hook.rerender({ ...props, chats: [summary("chat-a", T0)] });
    await flush(10 * 60_000);
    expect(branchRequests(fetchMock)).toBe(1);
    expect(hook.result.current.branchGraph).toMatchObject({ graph: null, loading: false });
    expect(hook.result.current.branchGraph?.error).toBeTruthy();

    fetchMock.mockImplementation(async () => graphResponse("chat-a", T0));
    await act(async () => { await hook.result.current.loadBranchGraph(); });
    await flush();
    expect(branchRequests(fetchMock)).toBe(2);
    expect(hook.result.current.branchGraph).toMatchObject({ error: null, loading: false, snapshotUpdatedAt: T0 });
  });

  it("keeps state per chat and cancels a stale request when the active chat changes", async () => {
    const signals = new Map<string, AbortSignal>();
    const pending = new Map<string, (response: Response) => void>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const chatId = String(input).split("/")[3]!;
      if (init?.signal) signals.set(chatId, init.signal);
      return new Promise<Response>((resolve, reject) => {
        pending.set(chatId, resolve);
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const chats = [summary("chat-a", T0), summary("chat-b", T0)];
    const props: HookProps = {
      activeChatId: "chat-a",
      activeChatStreaming: false,
      branchDrawerOpen: false,
      chats
    };
    const hook = renderController(props);
    await flush();
    expect(branchRequests(fetchMock, "chat-a")).toBe(1);

    hook.rerender({ ...props, activeChatId: "chat-b" });
    await flush();
    expect(signals.get("chat-a")?.aborted).toBe(true);
    expect(branchRequests(fetchMock, "chat-b")).toBe(1);
    // A late answer for the abandoned chat cannot become the visible graph.
    pending.get("chat-a")?.(graphResponse("chat-a", T0));
    pending.get("chat-b")?.(graphResponse("chat-b", T0));
    await flush();
    expect(hook.result.current.branchGraph).toMatchObject({ chatId: "chat-b", loading: false });

    // The cancelled chat gets one fresh attempt on return.
    hook.rerender({ ...props, activeChatId: "chat-a" });
    await flush();
    expect(branchRequests(fetchMock, "chat-a")).toBe(2);
    pending.get("chat-a")?.(graphResponse("chat-a", T0));
    await flush();
    expect(hook.result.current.branchGraph).toMatchObject({ chatId: "chat-a", loading: false });

    // Both chats now hold a current graph: switching back and forth is free.
    hook.rerender({ ...props, activeChatId: "chat-b" });
    await flush();
    hook.rerender({ ...props, activeChatId: "chat-a" });
    await flush(60_000);
    expect(branchRequests(fetchMock, "chat-a")).toBe(2);
    expect(branchRequests(fetchMock, "chat-b")).toBe(1);
    expect(hook.result.current.branchGraph).toMatchObject({ chatId: "chat-a", loading: false });
  });

  it("defers background refresh during a live stream and for a chat without messages", async () => {
    const fetchMock = vi.fn(async () => graphResponse("chat-a", T0));
    vi.stubGlobal("fetch", fetchMock);
    const props: HookProps = {
      activeChatId: "chat-a",
      activeChatStreaming: true,
      branchDrawerOpen: false,
      chats: [summary("chat-a", T0)]
    };
    const hook = renderController(props);
    await flush(60_000);
    hook.rerender({ ...props, activeChatStreaming: false, chats: [{ ...summary("chat-a", T0), messageCount: 0 }] });
    await flush(60_000);
    expect(branchRequests(fetchMock)).toBe(0);
    hook.rerender({ ...props, activeChatStreaming: false });
    await flush();
    expect(branchRequests(fetchMock)).toBe(1);
  });
});
