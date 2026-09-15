import { act, renderHook } from "@testing-library/react";
import {
  resetRunSurfaceStoreForTest,
  resetThreadStoreForTest,
  resetWorkspaceStoreForTest
} from "@/tests/support/appShellStores";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectRunSurface, useRunSurfaceStore } from "./runSurfaceStore";
import { selectThreadSnapshot, useThreadStore } from "./threadStore";
import type { WorkspaceChatSummary } from "./types";
import { useRunStreaming } from "./useRunStreaming";
import { useWorkspaceStore } from "./workspaceStore";

function chat(id: string, title: string): WorkspaceChatSummary {
  return {
    activeLeafMessageId: `assistant-${id}`,
    createdAt: "2026-07-12T08:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id,
    messageCount: 1,
    title,
    updatedAt: "2026-07-12T08:01:00.000Z"
  };
}

describe("run streaming", () => {
  it("publishes the answer before EOF and keeps late predecessor events out of the next run", async () => {
    const applyChatUpdate = vi.fn(() => false);
    const { result } = renderHook(() => useRunStreaming({ applyChatUpdate }));
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } }));
    const emit = (type: string, data: object) => writer.enqueue(new TextEncoder().encode(
      `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
    let publish!: () => void;
    const published = new Promise<void>((resolve) => { publish = resolve; });
    let current = true;
    const onAnswerComplete = vi.fn(() => { publish(); });
    const tokenBuffer = { flush: vi.fn(), push: vi.fn(), reset: vi.fn() };
    const running = result.current.consumeRunStream({ chatId: "chat-a", failurePrefix: "send_failed",
      isCurrent: () => current, onAnswerComplete, onRunId: vi.fn(), onMessageIds: vi.fn(), response, tokenBuffer });
    emit("message_start", { runId: "previous", assistantMessageId: "answer" });
    emit("token", { delta: "Finished." });
    emit("answer_complete", { runId: "previous", assistantMessageId: "answer" });
    await published;
    expect(onAnswerComplete).toHaveBeenCalledWith({ runId: "previous", assistantMessageId: "answer" });
    expect(tokenBuffer.flush).toHaveBeenCalled();
    current = false;
    useRunSurfaceStore.getState().resetSurface("chat-a");
    useRunSurfaceStore.getState().appendEvent("chat-a", { type: "start", data: { runId: "next" } });
    const nextSurface = selectRunSurface(useRunSurfaceStore.getState(), "chat-a");
    applyChatUpdate.mockClear();
    emit("token", { delta: "Late token" });
    emit("message_reset", {});
    emit("artifact", { runId: "previous", artifactType: "workspace_activity" });
    emit("chat_update", { runId: "previous" });
    emit("done", { runId: "previous", status: "complete" });
    writer.close();
    await running;
    expect(selectRunSurface(useRunSurfaceStore.getState(), "chat-a")).toBe(nextSurface);
    expect(applyChatUpdate).not.toHaveBeenCalled();
    expect(tokenBuffer.push).toHaveBeenCalledExactlyOnceWith("Finished.");
    expect(tokenBuffer.reset).not.toHaveBeenCalled();
    expect(onAnswerComplete).toHaveBeenCalledOnce();
  });

  it("does not publish a completion for another answer", async () => {
    const { result } = renderHook(() => useRunStreaming({ applyChatUpdate: vi.fn(() => false) }));
    const onAnswerComplete = vi.fn();
    await expect(result.current.consumeRunStream({ chatId: "chat-a", failurePrefix: "send_failed", onAnswerComplete,
      onRunId: vi.fn(), onMessageIds: vi.fn(), tokenBuffer: { flush: vi.fn(), push: vi.fn() },
      response: new Response('event: message_start\ndata: {"runId":"run","assistantMessageId":"answer"}\n\n' +
        'event: answer_complete\ndata: {"runId":"another-run","assistantMessageId":"answer"}\n\n')
    })).rejects.toThrow("run_answer_completion_malformed");
    expect(onAnswerComplete).not.toHaveBeenCalled();
  });

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

  it("clears provisional assistant text when a tool round resets the message", async () => {
    const chatA = chat("chat-a", "Chat A");
    useThreadStore.getState().replaceThread(chatA.id, {
      activeLeafId: "assistant-chat-a",
      messages: [{
        content: "",
        id: "assistant-chat-a",
        parentMessageId: null,
        role: "assistant",
        status: "streaming"
      }],
      usageStats: null
    });
    const { result } = renderHook(() => useRunStreaming({ applyChatUpdate: vi.fn(() => false) }));
    const tokenBuffer = result.current.createStreamTokenBuffer({
      chatId: chatA.id,
      getAssistantMessageId: () => "assistant-chat-a"
    });

    await act(async () => {
      tokenBuffer.push("provisional");
      tokenBuffer.flush();
      await result.current.consumeRunStream({
        chatId: chatA.id,
        failurePrefix: "send_failed",
        onMessageIds: vi.fn(),
        onRunId: vi.fn(),
        response: new Response(
          [
            'event: message_reset\ndata: {"round":1}',
            'event: done\ndata: {"runId":"run-a","status":"complete"}',
            ""
          ].join("\n\n")
        ),
        tokenBuffer
      });
    });

    expect(selectThreadSnapshot(useThreadStore.getState(), chatA.id).messages[0]?.content).toBe("");
    expect(selectRunSurface(useRunSurfaceStore.getState(), chatA.id).events.at(-2)).toEqual({
      data: { round: 1 },
      type: "message_reset"
    });
  });

  it("rejects an EOF without a terminal frame while retaining delivered tokens", async () => {
    const push = vi.fn();
    const flush = vi.fn();
    const { result } = renderHook(() =>
      useRunStreaming({ applyChatUpdate: vi.fn(() => false) })
    );

    await act(async () => {
      await expect(
        result.current.consumeRunStream({
          chatId: "chat-a",
          failurePrefix: "send_failed",
          onMessageIds: vi.fn(),
          onRunId: vi.fn(),
          response: new Response('event: token\ndata: {"delta":"partial answer"}\n\n'),
          tokenBuffer: { flush, push }
        })
      ).rejects.toThrow("stream_connection_lost");
    });

    expect(push).toHaveBeenCalledWith("partial answer");
    expect(flush).toHaveBeenCalled();
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
