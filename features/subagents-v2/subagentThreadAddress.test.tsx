import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetSubagentStoreForTest, useSubagentStore } from "./subagentStore";
import {
  closeSubagentThread,
  openSubagentThread,
  subagentThreadFromAddress,
  useOpenSubagentThread,
  useSubagentThreadAddress
} from "./subagentThreadAddress";

function at(href: string) {
  window.history.replaceState(null, "", href);
}

beforeEach(() => {
  resetSubagentStoreForTest();
  at("/c/chat-a");
});
afterEach(() => {
  cleanup();
  at("/");
});

describe("sub-agent thread address", () => {
  it("opens a thread as one history entry in its chat's address and goes back to the chat", () => {
    const length = window.history.length;
    at("/c/chat-a?library=mcp");
    openSubagentThread({ chatId: "chat-a", threadId: "thread-1" });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/c/chat-a?library=mcp&agent=thread-1");
    expect(window.history.length).toBe(length + 1);
    expect(useSubagentStore.getState().openThread).toEqual({ chatId: "chat-a", threadId: "thread-1" });
    closeSubagentThread();
    expect(`${window.location.pathname}${window.location.search}`).toBe("/c/chat-a?library=mcp");
    expect(useSubagentStore.getState().openThread).toBeNull();
  });

  it("settles another chat's thread on the entry its chat navigation added, without its parameters", () => {
    at("/c/chat-a?message=m1");
    openSubagentThread({ chatId: "chat-b", threadId: "thread-2" }, "replace");
    expect(`${window.location.pathname}${window.location.search}`).toBe("/c/chat-b?agent=thread-2");
  });

  it("reads only one valid thread id of the shown chat", () => {
    at("/c/chat-a?agent=thread-1");
    expect(subagentThreadFromAddress()).toEqual({ chatId: "chat-a", threadId: "thread-1" });
    at("/c/chat-a?agent=bad%20id");
    expect(subagentThreadFromAddress()).toBeNull();
    at("/c/chat-a?agent=a&agent=b");
    expect(subagentThreadFromAddress()).toBeNull();
    at("/?agent=thread-1");
    expect(subagentThreadFromAddress()).toBeNull();
  });

  it("follows reload, back and forward, and closes when another chat opens or the chat goes away", () => {
    at("/c/chat-a?agent=thread-1");
    const { rerender, result } = renderHook(({ chatId }: { chatId: string | null }) => {
      useSubagentThreadAddress(chatId);
      return useOpenSubagentThread(chatId);
    }, { initialProps: { chatId: "chat-a" as string | null } });
    expect(result.current).toEqual({ chatId: "chat-a", threadId: "thread-1" });
    act(() => {
      at("/c/chat-a");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current).toBeNull();
    act(() => {
      at("/c/chat-a?agent=thread-1");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current).toEqual({ chatId: "chat-a", threadId: "thread-1" });
    // Another chat (or none, after the chat was deleted) never shows this thread.
    rerender({ chatId: "chat-b" });
    expect(result.current).toBeNull();
    expect(useSubagentStore.getState().openThread).toBeNull();
    rerender({ chatId: null });
    expect(result.current).toBeNull();
  });
});
