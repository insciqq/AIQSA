import { describe, expect, it } from "vitest";
import { initialRunLifecycleSnapshot, reduceRunLifecycle } from "./runLifecycleStore";

function baseState() {
  return {
    ...initialRunLifecycleSnapshot,
    cancelledRunIds: new Set<string>()
  };
}

describe("run lifecycle store transitions", () => {
  it("does not finish, cancel, or complete a newer producer with predecessor events", () => {
    const state = reduceRunLifecycle(baseState(), {
      type: "STREAM_STARTED", chatId: "chat-a", producer: "next-producer", runId: "next"
    });
    for (const type of ["STREAM_FINISHED", "RUN_CANCELLED", "ANSWER_COMPLETED"] as const) {
      const next = reduceRunLifecycle(state, { type, chatId: "chat-a", runId: "previous" });
      expect(next.activeStreams["chat-a"]).toEqual(state.activeStreams["chat-a"]);
    }
    for (const transition of [
      { type: "RUN_ID_RECEIVED", chatId: "chat-a", producer: "previous-producer", runId: "previous" },
      { type: "STREAM_FINISHED", chatId: "chat-a", producer: "previous-producer" },
      { type: "ANSWER_COMPLETED", chatId: "chat-a", producer: "previous-producer", runId: "next" }
    ] as const) {
      expect(reduceRunLifecycle(state, transition).activeStreams["chat-a"])
        .toEqual(state.activeStreams["chat-a"]);
    }
  });

  it("binds a run id to a record without one only through its own producer token", () => {
    const successor = reduceRunLifecycle(baseState(), {
      assistantMessageId: "assistant-y", chatId: "chat-a", producer: "producer-y", type: "STREAM_STARTED"
    });
    const lateFetch = reduceRunLifecycle(successor, {
      chatId: "chat-a", producer: "producer-x", runId: "run-x", type: "RUN_ID_RECEIVED"
    });
    const lateCompletion = reduceRunLifecycle(lateFetch, {
      chatId: "chat-a", runId: "run-x", type: "ANSWER_COMPLETED"
    });
    expect(lateCompletion.activeStreams["chat-a"]).toEqual({
      optimisticAssistantMessageId: "assistant-y", producer: "producer-y", resuming: false, runId: null
    });

    const own = reduceRunLifecycle(lateCompletion, {
      chatId: "chat-a", producer: "producer-y", runId: "run-y", type: "RUN_ID_RECEIVED"
    });
    const foreign = reduceRunLifecycle(own, {
      chatId: "chat-a", producer: "producer-y", runId: "run-z", type: "RUN_ID_RECEIVED"
    });
    expect(foreign.activeStreams["chat-a"]).toMatchObject({ runId: "run-y" });
    const finished = reduceRunLifecycle(foreign, {
      chatId: "chat-a", producer: "producer-y", type: "STREAM_FINISHED"
    });
    expect(finished.activeStreams).toEqual({});
  });

  it("tracks independent producers and applies metadata only to its keyed owner", () => {
    const chatA = reduceRunLifecycle(baseState(), {
      assistantMessageId: "assistant-a",
      chatId: "chat-a",
      producer: "producer-a",
      type: "STREAM_STARTED"
    });
    const twoChats = reduceRunLifecycle(chatA, {
      assistantMessageId: "assistant-b",
      chatId: "chat-b",
      runId: "run-b",
      type: "STREAM_STARTED"
    });
    const tokensApplied = reduceRunLifecycle(twoChats, {
      assistantMessageId: "assistant-a-persisted",
      chatId: "chat-a",
      type: "TOKENS_APPLIED"
    });
    const runReceived = reduceRunLifecycle(tokensApplied, {
      chatId: "chat-a",
      producer: "producer-a",
      runId: "run-a",
      type: "RUN_ID_RECEIVED"
    });

    expect(runReceived.activeStreams).toEqual({
      "chat-a": {
        optimisticAssistantMessageId: "assistant-a-persisted",
        producer: "producer-a",
        resuming: false,
        runId: "run-a"
      },
      "chat-b": {
        optimisticAssistantMessageId: "assistant-b",
        resuming: false,
        runId: "run-b"
      }
    });
  });

  it("ignores metadata for chats without an active producer", () => {
    const state = reduceRunLifecycle(baseState(), {
      chatId: "chat-a",
      producer: "producer-a",
      runId: "run-a",
      type: "RUN_ID_RECEIVED"
    });

    expect(state.activeStreams).toEqual({});
  });

  it("finishes only the requested producer", () => {
    const state = baseState();
    state.activeStreams = {
      "chat-a": { optimisticAssistantMessageId: "assistant-a", resuming: false, runId: "run-a" },
      "chat-b": { optimisticAssistantMessageId: "assistant-b", resuming: false, runId: "run-b" }
    };

    const finished = reduceRunLifecycle(state, {
      chatId: "chat-a",
      type: "STREAM_FINISHED"
    });

    expect(finished.activeStreams).not.toHaveProperty("chat-a");
    expect(finished.activeStreams).toHaveProperty("chat-b");
  });

  it("cancels an explicit chat without disturbing neighboring producers", () => {
    const state = baseState();
    state.activeStreams = {
      "chat-a": { optimisticAssistantMessageId: "assistant-a", resuming: false, runId: "run-a" },
      "chat-b": { optimisticAssistantMessageId: "assistant-b", resuming: false, runId: "run-b" }
    };

    const cancelled = reduceRunLifecycle(state, {
      chatId: "chat-a",
      runId: "run-a",
      type: "RUN_CANCELLED"
    });

    expect(cancelled.cancelledRunIds.has("run-a")).toBe(true);
    expect(cancelled.activeStreams).not.toHaveProperty("chat-a");
    expect(cancelled.activeStreams).toHaveProperty("chat-b");
  });

  it("serializes resume ownership per chat", () => {
    const chatA = reduceRunLifecycle(baseState(), {
      chatId: "chat-a",
      runId: "run-a",
      type: "RESUME_STARTED"
    });
    const duplicateChatA = reduceRunLifecycle(chatA, {
      chatId: "chat-a",
      runId: "run-a-new",
      type: "RESUME_STARTED"
    });
    const chatB = reduceRunLifecycle(duplicateChatA, {
      chatId: "chat-b",
      runId: "run-b",
      type: "RESUME_STARTED"
    });

    expect(chatB.activeStreams["chat-a"]).toMatchObject({ resuming: true, runId: "run-a" });
    expect(chatB.activeStreams["chat-b"]).toMatchObject({ resuming: true, runId: "run-b" });
  });

  it("marks only the matching resume owner as waiting in the background", () => {
    const resuming = reduceRunLifecycle(baseState(), { chatId: "chat-a", runId: "run-a", type: "RESUME_STARTED" });
    const foreground = reduceRunLifecycle(baseState(), { chatId: "chat-a", runId: "run-a", type: "STREAM_STARTED" });
    for (const state of [resuming, foreground]) {
      expect(reduceRunLifecycle(state, { chatId: "chat-a", runId: "other", type: "RESUME_BACKGROUNDED" })
        .activeStreams["chat-a"]?.waitingInBackground).toBeUndefined();
    }
    expect(reduceRunLifecycle(foreground, { chatId: "chat-a", runId: "run-a", type: "RESUME_BACKGROUNDED" })
      .activeStreams["chat-a"]?.waitingInBackground).toBeUndefined();
    expect(reduceRunLifecycle(resuming, { chatId: "chat-a", runId: "run-a", type: "RESUME_BACKGROUNDED" })
      .activeStreams["chat-a"]).toEqual({
      optimisticAssistantMessageId: null, resuming: true, runId: "run-a", waitingInBackground: true
    });
  });

  it("exits only a matching resume producer", () => {
    const resuming = reduceRunLifecycle(baseState(), {
      chatId: "chat-a",
      runId: "run-a",
      type: "RESUME_STARTED"
    });
    const mismatched = reduceRunLifecycle(resuming, {
      chatId: "chat-a",
      runId: "other-run",
      type: "RESUME_EXITED"
    });
    const exited = reduceRunLifecycle(mismatched, {
      chatId: "chat-a",
      runId: "run-a",
      type: "RESUME_EXITED"
    });

    expect(mismatched.activeStreams).toHaveProperty("chat-a");
    expect(exited.activeStreams).not.toHaveProperty("chat-a");
  });

  it("does not let a stale resume finalizer clear a foreground owner with the same run id", () => {
    const resuming = reduceRunLifecycle(baseState(), {
      chatId: "chat-a",
      runId: "run-a",
      type: "RESUME_STARTED"
    });
    const foreground = reduceRunLifecycle(resuming, {
      assistantMessageId: "assistant-a",
      chatId: "chat-a",
      runId: "run-a",
      type: "STREAM_STARTED"
    });
    const staleExit = reduceRunLifecycle(foreground, {
      chatId: "chat-a",
      runId: "run-a",
      type: "RESUME_EXITED"
    });

    expect(staleExit.activeStreams["chat-a"]).toEqual({
      optimisticAssistantMessageId: "assistant-a",
      resuming: false,
      runId: "run-a"
    });
  });

  it("keeps ambiguous transport state source-keyed until an explicit clear", () => {
    const ambiguous = reduceRunLifecycle(baseState(), {
      assistantMessageId: "assistant-a",
      chatId: "chat-a",
      runId: "run-a",
      type: "STREAM_AMBIGUOUS"
    });
    const finished = reduceRunLifecycle(ambiguous, {
      chatId: "chat-a",
      type: "STREAM_FINISHED"
    });
    const neighboring = reduceRunLifecycle(finished, {
      assistantMessageId: "assistant-b",
      chatId: "chat-b",
      runId: null,
      type: "STREAM_AMBIGUOUS"
    });
    const cleared = reduceRunLifecycle(neighboring, {
      chatId: "chat-a",
      type: "AMBIGUITY_CLEARED"
    });

    expect(finished.ambiguousFailures["chat-a"]).toEqual({
      assistantMessageId: "assistant-a",
      runId: "run-a"
    });
    expect(cleared.ambiguousFailures).toEqual({
      "chat-b": { assistantMessageId: "assistant-b", runId: null }
    });
  });

  it("clears stale ambiguity only when its source starts or cancels a run", () => {
    const state = baseState();
    state.ambiguousFailures = {
      "chat-a": { assistantMessageId: "assistant-a", runId: "run-a" },
      "chat-b": { assistantMessageId: "assistant-b", runId: "run-b" }
    };

    const restarted = reduceRunLifecycle(state, {
      assistantMessageId: "assistant-a-next",
      chatId: "chat-a",
      type: "STREAM_STARTED"
    });

    expect(restarted.ambiguousFailures).toEqual({
      "chat-b": { assistantMessageId: "assistant-b", runId: "run-b" }
    });
  });
});
