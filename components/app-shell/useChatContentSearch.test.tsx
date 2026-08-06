import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatContentSearch } from "./useChatContentSearch";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useChatContentSearch", () => {
  it("debounces server content matches and clears loading on success", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          chats: [
            {
              activeLeafMessageId: null,
              createdAt: "2026-06-10T00:00:00.000Z",
              defaultModelId: null,
              defaultProvider: null,
              folderId: null,
              id: "chat-2",
              messageCount: 1,
              pinned: false,
              title: "Chat without a default model",
              updatedAt: "2026-06-10T00:00:01.000Z"
            }
          ],
          contentMatches: [{ chatId: "chat-2", snippet: "buried phrase" }],
          folders: []
        }),
        { headers: { "content-type": "application/json" }, status: 200 }
      )
    );
    const setNotice = vi.fn();
    const { result } = renderHook(() => useChatContentSearch(setNotice));

    act(() => result.current.setChatQuery("buried phrase"));
    expect(result.current.chatContentSearchLoading).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/chats?q=buried%20phrase", expect.any(Object));
    expect(result.current.chatContentMatchIds).toEqual(new Set(["chat-2"]));
    expect(result.current.chatContentSearchError).toBeNull();
    expect(result.current.chatContentSearchLoading).toBe(false);
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("keeps local filtering usable and exposes a scoped failure state", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 503 }));
    const setNotice = vi.fn();
    const { result } = renderHook(() => useChatContentSearch(setNotice));

    act(() => result.current.setChatQuery("planning"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(result.current.chatContentMatchIds).toEqual(new Set());
    expect(result.current.chatContentSearchError).toContain("chat_search_failed_503");
    expect(result.current.chatContentSearchLoading).toBe(false);
    expect(setNotice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error", text: expect.stringContaining("chat_search_failed_503") })
    );

    act(() => result.current.setChatQuery(""));
    expect(result.current.chatContentSearchError).toBeNull();
    expect(result.current.chatContentSearchLoading).toBe(false);
  });

  it("aborts stale requests when the query changes", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>(() => undefined);
    });
    const { result } = renderHook(() => useChatContentSearch(vi.fn()));

    act(() => result.current.setChatQuery("first"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(signals[0]?.aborted).toBe(false);

    act(() => result.current.setChatQuery("second"));
    expect(signals[0]?.aborted).toBe(true);
    expect(result.current.chatContentSearchLoading).toBe(true);
  });
});
