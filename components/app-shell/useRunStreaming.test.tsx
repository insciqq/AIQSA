import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetRunSurfaceStoreForTest,
  selectRunSurface,
  useRunSurfaceStore
} from "./runSurfaceStore";
import { resetThreadStoreForTest, selectThreadSnapshot, useThreadStore } from "./threadStore";
import type { WorkspaceChatSummary } from "./types";
import { useRunStreaming } from "./useRunStreaming";
import { resetWorkspaceStoreForTest, useWorkspaceStore } from "./workspaceStore";

function chat(id: string, title: string): WorkspaceChatSummary {
  return {
    activeLeafMessageId: `assistant-${id}`,
    createdAt: "2026-07-12T08:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultPromptPresetId: null,
    defaultProvider: "openai",
    folderId: null,
    id,
    messageCount: 1,
    title,
    updatedAt: "2026-07-12T08:01:00.000Z"
  };
}

describe("run streaming", () => {
  afterEach(() => {
    resetThreadStoreForTest();
    resetRunSurfaceStoreForTest();
    resetWorkspaceStoreForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("applies inactive-chat tokens without replacing workspace summaries or neighboring threads", () => {
    vi.useFakeTimers();
    const chatA = chat("chat-a", "Chat A");
    const chatB = chat("chat-b", "Chat B");
    useWorkspaceStore.setState({
      activeChatId: chatB.id,
      chats: [chatA, chatB]
    });
    useThreadStore.getState().replaceThread(chatA.id, {
      activeLeafId: "assistant-chat-a",
      messages: [
        {
          content: "",
          id: "assistant-chat-a",
          parentMessageId: null,
          role: "assistant",
          status: "streaming"
        }
      ],
      usageStats: null
    });
    useThreadStore.getState().replaceThread(chatB.id, {
      activeLeafId: "assistant-chat-b",
      messages: [
        {
          content: "Settled B",
          id: "assistant-chat-b",
          parentMessageId: null,
          role: "assistant",
          status: "complete"
        }
      ],
      usageStats: null
    });

    const workspaceBefore = useWorkspaceStore.getState().chats;
    const summaryABefore = workspaceBefore[0];
    const summaryBBefore = workspaceBefore[1];
    const threadABefore = selectThreadSnapshot(useThreadStore.getState(), chatA.id);
    const threadBBefore = selectThreadSnapshot(useThreadStore.getState(), chatB.id);
    const { result } = renderHook(() =>
      useRunStreaming({
        applyChatUpdate: vi.fn(() => false)
      })
    );

    act(() => {
      const tokenBuffer = result.current.createStreamTokenBuffer({
        chatId: chatA.id,
        getAssistantMessageId: () => "assistant-chat-a"
      });
      tokenBuffer.push("background token");
      tokenBuffer.flush();
    });

    const workspaceAfter = useWorkspaceStore.getState().chats;
    const threadAAfter = selectThreadSnapshot(useThreadStore.getState(), chatA.id);
    const threadBAfter = selectThreadSnapshot(useThreadStore.getState(), chatB.id);

    expect(workspaceAfter).toBe(workspaceBefore);
    expect(workspaceAfter[0]).toBe(summaryABefore);
    expect(workspaceAfter[1]).toBe(summaryBBefore);
    expect(threadAAfter).not.toBe(threadABefore);
    expect(threadAAfter.messages[0]?.content).toBe("background token");
    expect(threadBAfter).toBe(threadBBefore);
    expect(threadBAfter.messages[0]?.content).toBe("Settled B");
    expect(selectRunSurface(useRunSurfaceStore.getState(), chatA.id).events).toEqual([
      {
        data: {
          characterCount: 16,
          chunkCount: 1
        },
        type: "token"
      }
    ]);
    expect(selectRunSurface(useRunSurfaceStore.getState(), chatB.id).events).toEqual([]);
  });

  it("keeps late events and one parse warning on the explicit inactive source chat", async () => {
    const applyChatUpdate = vi.fn(() => false);
    const { result } = renderHook(() => useRunStreaming({ applyChatUpdate }));
    useRunSurfaceStore.getState().appendEvent("chat-b", {
      data: { runId: "run-b" },
      type: "start"
    });

    await act(async () => {
      await result.current.consumeRunStream({
        chatId: "chat-a",
        failurePrefix: "send_failed",
        onMessageIds: vi.fn(),
        onRunId: vi.fn(),
        response: new Response(
          [
            "event: artifact\ndata: {not-json}",
            "event: artifact\ndata: {still-not-json}",
            'event: done\ndata: {"runId":"run-a","status":"complete"}',
            ""
          ].join("\n\n")
        ),
        tokenBuffer: { flush: vi.fn(), push: vi.fn() }
      });
    });

    expect(selectRunSurface(useRunSurfaceStore.getState(), "chat-a").events).toEqual([
      {
        data: {
          eventType: "artifact",
          message: "Skipped malformed stream frame"
        },
        type: "warning"
      },
      {
        data: { runId: "run-a", status: "complete" },
        type: "done"
      }
    ]);
    expect(selectRunSurface(useRunSurfaceStore.getState(), "chat-b").events).toEqual([
      { data: { runId: "run-b" }, type: "start" }
    ]);
    expect(applyChatUpdate).toHaveBeenCalledOnce();
  });
});
