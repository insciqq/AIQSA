import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellFetch } from "./shellApi";
import type { ThreadMessage } from "./types";
import { useWorkspaceOutputReconciliation } from "./useWorkspaceOutputReconciliation";

const pending: ThreadMessage = {
  id: "answer", parentMessageId: null, role: "assistant", status: "complete", content: "Answer stays complete",
  workspaceActivity: { entries: [], outputStatus: { state: "retrying" } },
  artifactSummary: { citations: [], reasoningText: [], sources: [], generatedFiles: [{ attachmentId: "ready", byteSize: 6, fileName: "ready.txt", mimeType: "text/plain", relativePath: "ready.txt" }] }
};
const props = { accountId: "account-a", chatId: "chat-a", messages: [pending], streaming: false, projectId: null as string | null };
type RefreshOptions = Parameters<Parameters<typeof useWorkspaceOutputReconciliation>[0]["refreshActiveChat"]>[1];
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe("personal Workspace output reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("refreshes an already pending answer and stops once files settle without changing the answer", async () => {
    const refresh = vi.fn(async () => ({}));
    const { rerender } = renderHook((value) => useWorkspaceOutputReconciliation({ ...value, refreshActiveChat: refresh }), { initialProps: props });
    await advance(1_999); expect(refresh).not.toHaveBeenCalled();
    await advance(1);
    expect(refresh).toHaveBeenCalledExactlyOnceWith("chat-a", expect.objectContaining({ forceDetail: true, preserveControls: true, resumeRuns: false }));
    rerender({ ...props, messages: [{ ...pending, workspaceActivity: { entries: [], outputStatus: { state: "complete" } } }] });
    await advance(120_000); expect(refresh).toHaveBeenCalledOnce();
    expect(pending.content).toBe("Answer stays complete");
    expect(pending.artifactSummary?.generatedFiles).toHaveLength(1);
  });

  it.each(["project", "streaming", "terminal", "no_chat"] as const)("does not create an extra refresh owner for %s", async (kind) => {
    const refresh = vi.fn(async () => ({}));
    renderHook(() => useWorkspaceOutputReconciliation({ ...props, refreshActiveChat: refresh,
      ...(kind === "project" ? { projectId: "project-a" } : {}),
      ...(kind === "streaming" ? { streaming: true } : {}),
      ...(kind === "terminal" ? { messages: [{ ...pending, workspaceActivity: { entries: [], outputStatus: { state: "failed" } } }] } : {}),
      ...(kind === "no_chat" ? { chatId: null } : {})
    }));
    await advance(120_000); expect(refresh).not.toHaveBeenCalled();
  });

  it("starts after SSE terminates, backs off failures, and pauses hidden tabs", async () => {
    const refresh = vi.fn(async () => { throw new Error("synthetic_network_failure"); });
    const { rerender } = renderHook((value) => useWorkspaceOutputReconciliation({ ...value, refreshActiveChat: refresh }), { initialProps: { ...props, streaming: true } });
    await advance(60_000); expect(refresh).not.toHaveBeenCalled();
    rerender(props);
    await advance(30_000); expect(refresh).toHaveBeenCalledTimes(4); // 2, 6, 14, 30 seconds
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(120_000); expect(refresh).toHaveBeenCalledTimes(4);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(2_000); expect(refresh).toHaveBeenCalledTimes(5);
  });

  it("keeps one request per source and aborts stale work on navigation, account change and disposal", async () => {
    const releases: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    const refresh = vi.fn((_chat: string, options: RefreshOptions) => {
      signals.push(options.signal);
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    const { rerender, unmount } = renderHook((value) => useWorkspaceOutputReconciliation({ ...value, refreshActiveChat: refresh }), { initialProps: props });
    await advance(2_000);
    rerender({ ...props, messages: [...props.messages] });
    await advance(60_000); expect(refresh).toHaveBeenCalledOnce();
    expect(signals[0]!.aborted).toBe(true);
    rerender({ ...props, chatId: "chat-b" }); await advance(2_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    rerender({ ...props, chatId: "chat-b", accountId: "account-b" }); await advance(2_000);
    expect(signals[1]!.aborted).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(3);
    unmount(); expect(signals[2]!.aborted).toBe(true);
    await act(async () => { releases.forEach((release) => release()); });
    await advance(120_000); expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("stops its timer immediately when another request reports an expired session", async () => {
    const refresh = vi.fn(async () => ({}));
    renderHook(() => useWorkspaceOutputReconciliation({ ...props, refreshActiveChat: refresh }));
    await advance(2_000);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({}, { status: 401 }));
    await act(async () => { await shellFetch("/api/catalog"); });
    await advance(120_000);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("stops permanently for unavailable authority while leaving existing files readable", async () => {
    const refresh = vi.fn(async (_chat: string, options: { onUnavailable(): void }) => { options.onUnavailable(); return null; });
    renderHook(() => useWorkspaceOutputReconciliation({ ...props, refreshActiveChat: refresh }));
    await advance(120_000); expect(refresh).toHaveBeenCalledOnce();
    expect(pending.artifactSummary?.generatedFiles?.[0]?.attachmentId).toBe("ready");
  });
});
