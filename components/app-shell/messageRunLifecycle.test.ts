import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetRunLifecycleStoreForTest,
  resetRunSurfaceStoreForTest,
  resetThreadStoreForTest
} from "@/tests/support/appShellStores";
import { executeMessageRunLifecycle } from "./messageRunLifecycle";
import { useRunLifecycleStore } from "./runLifecycleStore";
import {
  selectRunSurface,
  useRunSurfaceStore
} from "./runSurfaceStore";
import { selectThreadSnapshot, useThreadStore } from "./threadStore";

function prepareThread(chatId = "chat-1", assistantMessageId = "assistant-optimistic") {
  useThreadStore.getState().replaceThread(chatId, {
    activeLeafId: assistantMessageId,
    messages: [
      {
        content: "",
        id: assistantMessageId,
        parentMessageId: "user-1",
        role: "assistant",
        status: "streaming"
      }
    ],
    usageStats: null
  });
}

function surfaceEvents(chatId = "chat-1") {
  return selectRunSurface(useRunSurfaceStore.getState(), chatId).events;
}

describe("message run lifecycle", () => {
  afterEach(() => {
    resetRunLifecycleStoreForTest();
    resetRunSurfaceStoreForTest();
    resetThreadStoreForTest();
    vi.restoreAllMocks();
  });

  it("owns successful stream reconciliation, active-chat refresh, notification, and cleanup", async () => {
    prepareThread();
    const activeChatIdRef = { current: "chat-1" as string | null };
    const activeStreamAbortRef = { current: new Map<string, AbortController>() };
    useRunSurfaceStore.getState().appendEvent("chat-1", { data: null, type: "stale" });
    const fetchRun = vi.fn(async () => null);
    const notifyAnswerReady = vi.fn(async () => undefined);
    const primeAnswerSound = vi.fn(async () => undefined);
    const refreshActiveChat = vi.fn(async () => ({ id: "chat-1" }));
    let getAssistantMessageId!: () => string;

    const result = await executeMessageRunLifecycle({
      activeChatIdRef,
      activeStreamAbortRef,
      chatId: "chat-1",
      consumeRunStream: async ({ onMessageIds, onRunId }) => {
        expect(activeStreamAbortRef.current.has("chat-1")).toBe(true);
        expect(getAssistantMessageId()).toBe("assistant-optimistic");
        onRunId("run-1");
        onMessageIds({ assistantMessageId: "assistant-persisted" }, "run-1");
        expect(getAssistantMessageId()).toBe("assistant-persisted");
        return {
          failed: false,
          receivedChatUpdate: false,
          runId: "run-1",
          terminalStatus: "complete"
        };
      },
      createStreamTokenBuffer: (input) => {
        getAssistantMessageId = input.getAssistantMessageId;
        return { flush: vi.fn(), push: vi.fn() };
      },
      failurePrefix: "regenerate_failed",
      fetchRun,
      notifyAnswerReady,
      optimisticAssistantMessageId: "assistant-optimistic",
      primeAnswerSound,
      reconcileMessageIds({ currentRunId, messageIds, optimisticAssistantMessageId }) {
        useThreadStore.getState().updateMessages("chat-1", (current) =>
          current.map((message) =>
            message.id === optimisticAssistantMessageId && messageIds.assistantMessageId
              ? {
                  ...message,
                  id: messageIds.assistantMessageId,
                  runId: currentRunId
                }
              : message
          )
        );
      },
      refreshActiveChat,
      request: async () => new Response("", { status: 200 })
    });

    const thread = selectThreadSnapshot(useThreadStore.getState(), "chat-1");
    expect(result).toEqual({
      assistantMessageId: "assistant-persisted",
      cancelled: false,
      failed: false,
      receivedChatUpdate: false,
      runId: "run-1"
    });
    expect(thread.messages).toEqual([
      expect.objectContaining({
        id: "assistant-persisted",
        runId: "run-1",
        status: "complete"
      })
    ]);
    expect(fetchRun).toHaveBeenCalledWith("run-1", "chat-1");
    expect(refreshActiveChat).toHaveBeenCalledWith("chat-1", {
      forceDetail: true,
      preserveControls: true
    });
    expect(notifyAnswerReady).toHaveBeenCalledOnce();
    expect(primeAnswerSound).toHaveBeenCalledOnce();
    expect(surfaceEvents()).toEqual([]);
    expect(activeStreamAbortRef.current.has("chat-1")).toBe(false);
    expect(useRunLifecycleStore.getState().activeStreams).toEqual({});
  });

  it("trusts chat_update reconciliation and skips the detail fallback", async () => {
    prepareThread();
    const refreshActiveChat = vi.fn(async () => null);

    await executeMessageRunLifecycle({
      activeChatIdRef: { current: "chat-1" },
      activeStreamAbortRef: { current: new Map() },
      chatId: "chat-1",
      consumeRunStream: async () => ({
        failed: false,
        receivedChatUpdate: true,
        runId: null,
        terminalStatus: "complete" as const
      }),
      createStreamTokenBuffer: () => ({ flush: vi.fn(), push: vi.fn() }),
      failurePrefix: "send_failed",
      fetchRun: vi.fn(async () => null),
      notifyAnswerReady: vi.fn(async () => undefined),
      optimisticAssistantMessageId: "assistant-optimistic",
      primeAnswerSound: vi.fn(async () => undefined),
      reconcileMessageIds: vi.fn(),
      refreshActiveChat,
      request: async () => new Response("", { status: 200 })
    });

    expect(refreshActiveChat).not.toHaveBeenCalled();
  });

  it("treats an SSE error result as failed without notifying or synthesizing a second error event", async () => {
    prepareThread();
    const fetchRun = vi.fn(async () => null);
    const notifyAnswerReady = vi.fn(async () => undefined);

    const result = await executeMessageRunLifecycle({
      activeChatIdRef: { current: "chat-1" },
      activeStreamAbortRef: { current: new Map() },
      chatId: "chat-1",
      consumeRunStream: async ({ onRunId }) => {
        onRunId("run-failed");
        return {
          failed: true,
          receivedChatUpdate: true,
          runId: "run-failed",
          terminalStatus: "error"
        };
      },
      createStreamTokenBuffer: () => ({ flush: vi.fn(), push: vi.fn() }),
      failurePrefix: "send_failed",
      fetchRun,
      notifyAnswerReady,
      optimisticAssistantMessageId: "assistant-optimistic",
      primeAnswerSound: vi.fn(async () => undefined),
      reconcileMessageIds: vi.fn(),
      refreshActiveChat: vi.fn(async () => null),
      request: async () => new Response("", { status: 200 })
    });

    expect(result).toMatchObject({ failed: true, runId: "run-failed" });
    expect(fetchRun).toHaveBeenCalledWith("run-failed", "chat-1");
    expect(notifyAnswerReady).not.toHaveBeenCalled();
    expect(surfaceEvents()).toEqual([]);
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-1").messages[0]).toMatchObject({
      content: "",
      runId: "run-failed",
      status: "error"
    });
    expect(useRunLifecycleStore.getState().activeStreams).toEqual({});
  });

  it("settles a server-confirmed cancellation without answer-ready notification", async () => {
    prepareThread();
    const notifyAnswerReady = vi.fn(async () => undefined);

    const result = await executeMessageRunLifecycle({
      activeChatIdRef: { current: "chat-1" },
      activeStreamAbortRef: { current: new Map() },
      chatId: "chat-1",
      consumeRunStream: async () => ({
        failed: false,
        receivedChatUpdate: true,
        runId: "run-cancelled",
        terminalStatus: "cancelled"
      }),
      createStreamTokenBuffer: () => ({ flush: vi.fn(), push: vi.fn() }),
      failurePrefix: "send_failed",
      fetchRun: vi.fn(async () => null),
      notifyAnswerReady,
      optimisticAssistantMessageId: "assistant-optimistic",
      primeAnswerSound: vi.fn(async () => undefined),
      reconcileMessageIds: vi.fn(),
      refreshActiveChat: vi.fn(async () => null),
      request: async () => new Response("", { status: 200 })
    });

    expect(result).toMatchObject({ cancelled: true, failed: false });
    expect(notifyAnswerReady).not.toHaveBeenCalled();
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-1").messages[0]).toMatchObject({
      status: "cancelled"
    });
  });

  it("keeps a user-cancelled run cancelled when the closing stream reports an error", async () => {
    prepareThread();
    const notifyAnswerReady = vi.fn(async () => undefined);

    const result = await executeMessageRunLifecycle({
      activeChatIdRef: { current: "chat-1" },
      activeStreamAbortRef: { current: new Map() },
      chatId: "chat-1",
      consumeRunStream: async ({ onRunId }) => {
        onRunId("run-user-cancelled");
        useRunLifecycleStore.getState().runCancelled({
          chatId: "chat-1",
          runId: "run-user-cancelled"
        });
        return {
          failed: true,
          receivedChatUpdate: true,
          runId: "run-user-cancelled",
          terminalStatus: "error"
        };
      },
      createStreamTokenBuffer: () => ({ flush: vi.fn(), push: vi.fn() }),
      failurePrefix: "send_failed",
      fetchRun: vi.fn(async () => null),
      notifyAnswerReady,
      optimisticAssistantMessageId: "assistant-optimistic",
      primeAnswerSound: vi.fn(async () => undefined),
      reconcileMessageIds: vi.fn(),
      refreshActiveChat: vi.fn(async () => null),
      request: async () => new Response("", { status: 200 })
    });

    expect(result).toMatchObject({
      cancelled: true,
      failed: false,
      runId: "run-user-cancelled"
    });
    expect(notifyAnswerReady).not.toHaveBeenCalled();
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-1").messages[0]).toMatchObject({
      content: "",
      status: "cancelled"
    });
  });

  it("keeps a user-cancelled run cancelled when its closing stream throws", async () => {
    prepareThread();
    const settleFailedRunState = vi.fn();

    const result = await executeMessageRunLifecycle({
      activeChatIdRef: { current: "chat-1" },
      activeStreamAbortRef: { current: new Map() },
      chatId: "chat-1",
      consumeRunStream: async ({ onRunId }) => {
        onRunId("run-user-cancelled");
        useRunLifecycleStore.getState().runCancelled({
          chatId: "chat-1",
          runId: "run-user-cancelled"
        });
        throw new Error("closing stream failed");
      },
      createStreamTokenBuffer: () => ({ flush: vi.fn(), push: vi.fn() }),
      failurePrefix: "send_failed",
      fetchRun: vi.fn(async () => null),
      notifyAnswerReady: vi.fn(async () => undefined),
      optimisticAssistantMessageId: "assistant-optimistic",
      primeAnswerSound: vi.fn(async () => undefined),
      reconcileMessageIds: vi.fn(),
      refreshActiveChat: vi.fn(async () => null),
      request: async () => new Response("", { status: 200 }),
      settleFailedRunState
    });

    expect(result).toEqual({
      assistantMessageId: "assistant-optimistic",
      cancelled: true,
      failed: false,
      receivedChatUpdate: false,
      runId: "run-user-cancelled"
    });
    expect(settleFailedRunState).not.toHaveBeenCalled();
    expect(useRunLifecycleStore.getState().ambiguousFailures).toEqual({});
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-1").messages[0]).toMatchObject({
      content: "Stopped.",
      status: "cancelled"
    });
  });

  it("refreshes a background source chat without painting it into the active surface", async () => {
    prepareThread();
    useThreadStore.getState().mergeMessages("chat-1", [], {
      sourceUpdatedAt: "2026-06-10T00:00:00.000Z"
    });
    const activeChatIdRef = { current: "chat-1" as string | null };
    const fetchRun = vi.fn(async () => null);
    const notifyAnswerReady = vi.fn(async () => undefined);
    const refreshActiveChat = vi.fn(async () => null);

    await executeMessageRunLifecycle({
      activeChatIdRef,
      activeStreamAbortRef: { current: new Map() },
      chatId: "chat-1",
      consumeRunStream: async () => {
        activeChatIdRef.current = "chat-2";
        return {
          failed: false,
          receivedChatUpdate: false,
          runId: "run-1",
          terminalStatus: "complete"
        };
      },
      createStreamTokenBuffer: () => ({ flush: vi.fn(), push: vi.fn() }),
      failurePrefix: "regenerate_failed",
      fetchRun,
      notifyAnswerReady,
      optimisticAssistantMessageId: "assistant-optimistic",
      primeAnswerSound: vi.fn(async () => undefined),
      reconcileMessageIds: vi.fn(),
      refreshActiveChat,
      request: async () => new Response("", { status: 200 })
    });

    expect(fetchRun).toHaveBeenCalledWith("run-1", "chat-1");
    expect(refreshActiveChat).toHaveBeenCalledWith("chat-1", {
      forceDetail: true,
      preserveControls: true
    });
    expect(notifyAnswerReady).toHaveBeenCalledOnce();
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-1").messages[0]).toMatchObject({
      status: "complete"
    });
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-1").sourceUpdatedAt).toBeNull();
  });

  it("records an inactive HTTP failure only on its owning chat and releases the stream", async () => {
    prepareThread();
    useRunSurfaceStore.getState().appendEvent("chat-2", {
      data: { runId: "run-2" },
      type: "start"
    });
    const flush = vi.fn();
    const notifyAnswerReady = vi.fn(async () => undefined);
    const settleFailedRunState = vi.fn();

    const result = await executeMessageRunLifecycle({
      activeChatIdRef: { current: "chat-2" },
      activeStreamAbortRef: { current: new Map() },
      chatId: "chat-1",
      consumeRunStream: vi.fn(async () => ({
        failed: false,
        receivedChatUpdate: false,
        runId: null,
        terminalStatus: "complete" as const
      })),
      createStreamTokenBuffer: () => ({ flush, push: vi.fn() }),
      failurePrefix: "regenerate_failed",
      fetchRun: vi.fn(async () => null),
      notifyAnswerReady,
      optimisticAssistantMessageId: "assistant-optimistic",
      primeAnswerSound: vi.fn(async () => undefined),
      reconcileMessageIds: vi.fn(),
      refreshActiveChat: vi.fn(async () => null),
      request: async () => Response.json({ error: "regenerate_failed_503" }, { status: 503 }),
      settleFailedRunState
    });

    expect(result).toMatchObject({
      cancelled: false,
      failed: true,
      failureCode: "regenerate_failed_503"
    });
    expect(flush).toHaveBeenCalledOnce();
    expect(surfaceEvents()).toEqual([
      {
        data: {
          message: "Regeneration failed with HTTP 503 (regenerate_failed_503)"
        },
        type: "error"
      }
    ]);
    expect(surfaceEvents("chat-2")).toEqual([
      { data: { runId: "run-2" }, type: "start" }
    ]);
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-1").messages[0]).toMatchObject({
      content: "Regeneration failed with HTTP 503 (regenerate_failed_503)",
      status: "error"
    });
    expect(notifyAnswerReady).not.toHaveBeenCalled();
    expect(settleFailedRunState).toHaveBeenCalledWith({
      assistantMessageId: "assistant-optimistic",
      kind: "rejected",
      optimisticAssistantMessageId: "assistant-optimistic",
      runId: null
    });
    expect(useRunLifecycleStore.getState().activeStreams).toEqual({});
  });

  it("classifies a network failure as ambiguous and asks the source owner to reconcile", async () => {
    prepareThread();
    const consumeRunStream = vi.fn();
    const settleFailedRunState = vi.fn();

    const result = await executeMessageRunLifecycle({
      activeChatIdRef: { current: "chat-2" },
      activeStreamAbortRef: { current: new Map() },
      chatId: "chat-1",
      consumeRunStream,
      createStreamTokenBuffer: () => ({ flush: vi.fn(), push: vi.fn() }),
      failurePrefix: "send_failed",
      fetchRun: vi.fn(async () => null),
      notifyAnswerReady: vi.fn(async () => undefined),
      optimisticAssistantMessageId: "assistant-optimistic",
      primeAnswerSound: vi.fn(async () => undefined),
      reconcileMessageIds: vi.fn(),
      refreshActiveChat: vi.fn(async () => null),
      request: async () => {
        throw new TypeError("network disconnected");
      },
      settleFailedRunState
    });

    expect(result).toMatchObject({ cancelled: false, failed: true, runId: null });
    expect(consumeRunStream).not.toHaveBeenCalled();
    expect(settleFailedRunState).toHaveBeenCalledWith({
      assistantMessageId: "assistant-optimistic",
      kind: "ambiguous",
      optimisticAssistantMessageId: "assistant-optimistic",
      runId: null
    });
    expect(useRunLifecycleStore.getState().ambiguousFailures["chat-1"]).toEqual({
      assistantMessageId: "assistant-optimistic",
      runId: null
    });
  });

  it("reconciles an accepted stream that truncates after canonical ids arrive", async () => {
    prepareThread();
    const settleFailedRunState = vi.fn();

    const result = await executeMessageRunLifecycle({
      activeChatIdRef: { current: "chat-1" },
      activeStreamAbortRef: { current: new Map() },
      chatId: "chat-1",
      consumeRunStream: async ({ onMessageIds, onRunId }) => {
        onRunId("run-persisted");
        onMessageIds({ assistantMessageId: "assistant-persisted" }, "run-persisted");
        useThreadStore.getState().updateMessages("chat-1", (current) =>
          current.map((message) =>
            message.id === "assistant-persisted"
              ? { ...message, content: "Partial answer" }
              : message
          )
        );
        throw new Error("stream truncated");
      },
      createStreamTokenBuffer: () => ({ flush: vi.fn(), push: vi.fn() }),
      failurePrefix: "send_failed",
      fetchRun: vi.fn(async () => null),
      notifyAnswerReady: vi.fn(async () => undefined),
      optimisticAssistantMessageId: "assistant-optimistic",
      primeAnswerSound: vi.fn(async () => undefined),
      reconcileMessageIds({ messageIds, optimisticAssistantMessageId }) {
        useThreadStore.getState().updateMessages("chat-1", (current) =>
          current.map((message) =>
            message.id === optimisticAssistantMessageId && messageIds.assistantMessageId
              ? { ...message, id: messageIds.assistantMessageId }
              : message
          )
        );
      },
      refreshActiveChat: vi.fn(async () => null),
      request: async () => new Response("", { status: 200 }),
      settleFailedRunState
    });

    expect(result).toMatchObject({
      assistantMessageId: "assistant-persisted",
      failed: true,
      runId: "run-persisted"
    });
    expect(settleFailedRunState).toHaveBeenCalledWith({
      assistantMessageId: "assistant-persisted",
      kind: "ambiguous",
      optimisticAssistantMessageId: "assistant-optimistic",
      runId: "run-persisted"
    });
    expect(useRunLifecycleStore.getState().ambiguousFailures["chat-1"]).toEqual({
      assistantMessageId: "assistant-persisted",
      runId: "run-persisted"
    });
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-1").messages[0]).toMatchObject({
      content: "Partial answer",
      id: "assistant-persisted"
    });
  });

  it("keeps the optimistic owner when caller message-id reconciliation throws", async () => {
    prepareThread();

    const result = await executeMessageRunLifecycle({
      activeChatIdRef: { current: "chat-1" },
      activeStreamAbortRef: { current: new Map() },
      chatId: "chat-1",
      consumeRunStream: async ({ onMessageIds }) => {
        onMessageIds({ assistantMessageId: "assistant-never-applied" }, null);
        return {
          failed: false,
          receivedChatUpdate: false,
          runId: null,
          terminalStatus: "complete"
        };
      },
      createStreamTokenBuffer: () => ({ flush: vi.fn(), push: vi.fn() }),
      failurePrefix: "send_failed",
      fetchRun: vi.fn(async () => null),
      notifyAnswerReady: vi.fn(async () => undefined),
      optimisticAssistantMessageId: "assistant-optimistic",
      primeAnswerSound: vi.fn(async () => undefined),
      reconcileMessageIds() {
        throw new Error("reconciliation failed");
      },
      refreshActiveChat: vi.fn(async () => null),
      request: async () => new Response("", { status: 200 })
    });

    expect(result).toMatchObject({
      assistantMessageId: "assistant-optimistic",
      failed: true
    });
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-1").messages).toEqual([
      expect.objectContaining({
        content: "",
        id: "assistant-optimistic",
        status: "error"
      })
    ]);
    expect(surfaceEvents()).toEqual([]);
    expect(useRunLifecycleStore.getState().ambiguousFailures["chat-1"]).toEqual({
      assistantMessageId: "assistant-optimistic",
      runId: null
    });
    expect(useRunLifecycleStore.getState().activeStreams).toEqual({});
  });

  it("does not write a stale failure or clear a newer same-chat owner", async () => {
    prepareThread();
    const activeStreamAbortRef = { current: new Map<string, AbortController>() };
    const replacement = new AbortController();
    const settleFailedRunState = vi.fn();

    await executeMessageRunLifecycle({
      activeChatIdRef: { current: "chat-1" },
      activeStreamAbortRef,
      chatId: "chat-1",
      consumeRunStream: async () => {
        activeStreamAbortRef.current.set("chat-1", replacement);
        useRunLifecycleStore.getState().streamStarted({
          assistantMessageId: "assistant-replacement",
          chatId: "chat-1",
          runId: "run-replacement"
        });
        throw new Error("stale stream failed");
      },
      createStreamTokenBuffer: () => ({ flush: vi.fn(), push: vi.fn() }),
      failurePrefix: "send_failed",
      fetchRun: vi.fn(async () => null),
      notifyAnswerReady: vi.fn(async () => undefined),
      optimisticAssistantMessageId: "assistant-optimistic",
      primeAnswerSound: vi.fn(async () => undefined),
      reconcileMessageIds: vi.fn(),
      refreshActiveChat: vi.fn(async () => null),
      request: async () => new Response("", { status: 200 }),
      settleFailedRunState
    });

    expect(activeStreamAbortRef.current.get("chat-1")).toBe(replacement);
    expect(useRunLifecycleStore.getState().activeStreams["chat-1"]).toMatchObject({
      optimisticAssistantMessageId: "assistant-replacement",
      runId: "run-replacement"
    });
    expect(Object.keys(useRunLifecycleStore.getState().activeStreams)).toEqual(["chat-1"]);
    expect(surfaceEvents()).toEqual([]);
    expect(settleFailedRunState).not.toHaveBeenCalled();
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-1").messages[0]).toMatchObject({
      status: "error"
    });
  });

  it("records cancellation without surfacing an error", async () => {
    prepareThread();
    const activeStreamAbortRef = { current: new Map<string, AbortController>() };
    const execution = executeMessageRunLifecycle({
      activeChatIdRef: { current: "chat-1" },
      activeStreamAbortRef,
      chatId: "chat-1",
      consumeRunStream: vi.fn(async () => ({
        failed: false,
        receivedChatUpdate: false,
        runId: null,
        terminalStatus: "complete" as const
      })),
      createStreamTokenBuffer: () => ({ flush: vi.fn(), push: vi.fn() }),
      failurePrefix: "regenerate_failed",
      fetchRun: vi.fn(async () => null),
      notifyAnswerReady: vi.fn(async () => undefined),
      optimisticAssistantMessageId: "assistant-optimistic",
      primeAnswerSound: vi.fn(async () => undefined),
      reconcileMessageIds: vi.fn(),
      refreshActiveChat: vi.fn(async () => null),
      request(signal) {
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
    });
    const owningController = activeStreamAbortRef.current.get("chat-1")!;
    owningController.abort();

    const result = await execution;

    expect(result).toMatchObject({ cancelled: true, failed: false });
    expect(surfaceEvents()).toEqual([
      {
        data: { runId: null, status: "cancelled" },
        type: "done"
      }
    ]);
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-1").messages[0]).toMatchObject({
      content: "Stopped.",
      status: "cancelled"
    });
    expect(activeStreamAbortRef.current.has("chat-1")).toBe(false);
  });
});
