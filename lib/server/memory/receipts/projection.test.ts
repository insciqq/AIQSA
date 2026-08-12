import { describe, expect, it, vi } from "vitest";
import { loadMemoryRunEvidence } from "./projection";

function client(overrides: Record<string, unknown[]> = {}) {
  const rows = (key: string) => vi.fn(async () => overrides[key] ?? []);
  return {
    chat: { findMany: rows("chats") },
    memoryEpisode: { findMany: rows("episodes") },
    memoryFact: { findMany: rows("facts") },
    memoryFactVersion: { findMany: rows("versions") },
    memoryFeedback: {
      findMany: vi.fn(async (input: { where?: { feedbackType?: string } }) =>
        input.where?.feedbackType === "RETRACT"
          ? overrides.feedbackRetractions ?? []
          : overrides.feedback ?? [])
    },
    memoryDeletionOutbox: { findMany: rows("deletions") },
    memoryOperationReceipt: { findMany: rows("operations") },
    memoryRecallChunk: { findMany: rows("recallChunks") },
    memoryRetrievalAttemptItem: { findMany: rows("attemptItems") },
    modelRunMemoryBinding: { findMany: rows("bindings") },
    modelRunMemoryItem: { findMany: rows("items") },
    modelRunToolCall: { findMany: rows("toolCalls") }
  };
}

const binding = {
  createdAt: new Date("2026-08-10T10:00:00.000Z"),
  degradationCode: null,
  id: "binding-1",
  modelRunId: "run-1",
  outcome: "USED",
  queryPlannerVersion: "memory-query-planner-v1",
  retrievalPipelineVersion: "memory-retrieval-pipeline-v1",
  retrievalAttemptId: "attempt-1"
};

const item = {
  bindingId: "binding-1",
  factVersionId: "version-1",
  id: "run-item-1",
  includedText: "Prefers exact frozen text.",
  itemType: "FACT_VERSION",
  laneRanks: { FACT_FTS_ENGLISH: 1 },
  ordinal: 0,
  selectionReason: "explicit_lexical_relevance",
  sourceChatIdSnapshot: null,
  sourceMessageIdsSnapshot: []
};

describe("Memory run evidence projection", () => {
  it("projects immutable admission text and only committed same-run action feedback", async () => {
    const evidence = await loadMemoryRunEvidence(client({
      attemptItems: [{
        attemptId: "attempt-1",
        ordinal: 0,
        sourceSnapshot: { schemaVersion: 1, sourceMode: "EXPLICIT" },
        versionSnapshot: { schemaVersion: 1, scopeType: "GLOBAL_USER" }
      }],
      bindings: [binding],
      facts: [{ id: "fact-1", state: "ACTIVE" }],
      items: [item],
      operations: [{
        modelRunId: "run-1",
        operation: "SAVE",
        persistedToolCallId: "call-1",
        resultSnapshot: {},
        targetFactId: "fact-1",
        targetVersionId: "version-1"
      }, {
        modelRunId: "run-1",
        operation: "FORGET",
        persistedToolCallId: "call-from-other-run"
      }],
      toolCalls: [
        {
          id: "call-1",
          modelRunId: "run-1",
          toolName: "save_memory"
        },
        {
          id: "call-from-other-run",
          modelRunId: "run-2",
          toolName: "forget_memory"
        }
      ],
      versions: [{
        contentPurgedAt: null,
        displayText: "Prefers exact frozen text.",
        factId: "fact-1",
        id: "version-1",
        sourceMode: "EXPLICIT",
        state: "ACTIVE"
      }]
    }) as never, { runIds: ["run-1"], userId: "user-1" });

    expect(evidence.get("run-1")).toEqual({
      action: {
        factId: "fact-1",
        operation: "SAVE",
        statement: "Prefers exact frozen text.",
        status: "COMMITTED",
        versionId: "version-1"
      },
      inspection: {
        degradationCode: null,
        itemCount: 1,
        itemTypes: ["FACT_VERSION"],
        outcome: "USED",
        queryPlannerVersion: "memory-query-planner-v1",
        retrievalLanes: ["FACT_FTS_ENGLISH"],
        retrievalPipelineVersion: "memory-retrieval-pipeline-v1"
      },
      receipt: {
        degradationCode: null,
        itemCount: 1,
        items: [{
          factId: "fact-1",
          feedbackState: "UNAVAILABLE",
          includedText: "Prefers exact frozen text.",
          itemType: "FACT_VERSION",
          lifecycleState: "CURRENT",
          ordinal: 0,
          runId: "run-1",
          runItemId: "run-item-1",
          scopeType: "GLOBAL_USER",
          selectionReason: "explicit_lexical_relevance",
          sourceChatId: null,
          sourceMessageIds: [],
          sourceMode: "EXPLICIT",
          versionId: "version-1"
        }],
        outcome: "USED",
        summary: "memory_receipt:used:1"
      }
    });
  });

  it("suppresses feedback unless the receipt rejoins the exact first-party tool", async () => {
    const evidence = await loadMemoryRunEvidence(client({
      operations: [{
        modelRunId: "run-1",
        operation: "FORGET",
        persistedToolCallId: "call-1"
      }],
      toolCalls: [{
        id: "call-1",
        modelRunId: "run-1",
        toolName: "unrelated_tool"
      }]
    }) as never, { runIds: ["run-1"], userId: "user-1" });

    expect(evidence.has("run-1")).toBe(false);
  });

  it("projects an unbound retraction against the exact run feedback signal", async () => {
    const evidence = await loadMemoryRunEvidence(client({
      attemptItems: [{
        attemptId: "attempt-1",
        ordinal: 0,
        sourceSnapshot: { sourceMode: "AUTOMATIC" },
        versionSnapshot: { scopeType: "GLOBAL_USER" }
      }],
      bindings: [binding],
      facts: [{ id: "fact-1", state: "ACTIVE" }],
      feedback: [{
        feedbackType: "INCORRECT",
        id: "feedback-1",
        modelRunId: "run-1",
        modelRunMemoryItemId: "run-item-1",
        modelRunToolCallId: null,
        retractsFeedbackId: null
      }],
      feedbackRetractions: [{
        feedbackType: "RETRACT",
        id: "feedback-retract-1",
        modelRunId: null,
        modelRunMemoryItemId: null,
        modelRunToolCallId: null,
        retractsFeedbackId: "feedback-1"
      }],
      items: [item],
      versions: [{
        contentPurgedAt: null,
        factId: "fact-1",
        id: "version-1",
        sourceMode: "AUTOMATIC",
        state: "ACTIVE"
      }]
    }) as never, { runIds: ["run-1"], userId: "user-1" });

    expect(evidence.get("run-1")?.receipt?.items[0]?.feedbackState).toBe("AVAILABLE");
  });

  it("keeps exact text while labeling a later Forget and a deleted source", async () => {
    const evidence = await loadMemoryRunEvidence(client({
      attemptItems: [{
        attemptId: "attempt-1",
        ordinal: 0,
        sourceSnapshot: { sourceMode: "EXPLICIT" },
        versionSnapshot: { scopeType: "GLOBAL_USER" }
      }, {
        attemptId: "attempt-1",
        ordinal: 1,
        sourceSnapshot: { sourceMode: "HISTORY" },
        versionSnapshot: { scopeType: "CHAT" }
      }],
      bindings: [binding],
      facts: [
        { id: "fact-1", state: "FORGOTTEN" },
        { id: "fact-2", state: "ACTIVE" }
      ],
      items: [item, {
        ...item,
        factVersionId: "version-2",
        includedText: "Frozen previous-chat text.",
        ordinal: 1,
        sourceChatIdSnapshot: "deleted-chat",
        sourceMessageIdsSnapshot: ["message-1"]
      }],
      versions: [{
        contentPurgedAt: new Date("2026-08-10T11:00:00.000Z"),
        factId: "fact-1",
        id: "version-1",
        sourceMode: "EXPLICIT",
        state: "FORGOTTEN"
      }, {
        contentPurgedAt: null,
        factId: "fact-2",
        id: "version-2",
        sourceMode: "HISTORY",
        state: "ACTIVE"
      }]
    }) as never, { runIds: ["run-1"], userId: "user-1" });

    const receipt = evidence.get("run-1")?.receipt;
    expect(receipt?.items.map((value) => [
      value.includedText,
      value.lifecycleState,
      value.sourceChatId
    ])).toEqual([
      ["Prefers exact frozen text.", "LATER_FORGOTTEN", null],
      ["Frozen previous-chat text.", "SOURCE_DELETED", null]
    ]);
  });

  it("projects frozen chunk and episode sources with later lifecycle state", async () => {
    const evidence = await loadMemoryRunEvidence(client({
      attemptItems: [{
        attemptId: "attempt-1",
        ordinal: 0,
        sourceSnapshot: { sourceMode: "HISTORY" },
        versionSnapshot: { scopeType: "CHAT" }
      }, {
        attemptId: "attempt-1",
        ordinal: 1,
        sourceSnapshot: { sourceMode: "HISTORY" },
        versionSnapshot: { scopeType: "CHAT" }
      }],
      bindings: [binding],
      chats: [{ id: "source-chat" }],
      episodes: [{ id: "episode-1", invalidatedAt: null, state: "ACTIVE" }],
      items: [{
        ...item,
        episodeId: "episode-1",
        factVersionId: null,
        includedText: "Frozen episode summary.",
        itemType: "EPISODE",
        laneRanks: { HISTORY_EPISODE_FTS_ENGLISH: 1 },
        sourceChatIdSnapshot: "source-chat",
        sourceMessageIdsSnapshot: ["message-episode"]
      }, {
        ...item,
        factVersionId: null,
        includedText: "Frozen previous-chat passage.",
        itemType: "RECALL_CHUNK",
        laneRanks: { HISTORY_RECALL_FTS_ENGLISH: 1 },
        ordinal: 1,
        recallChunkId: "chunk-1",
        sourceChatIdSnapshot: "source-chat",
        sourceMessageIdsSnapshot: ["message-chunk"]
      }],
      recallChunks: [{
        id: "chunk-1",
        invalidatedAt: new Date("2026-08-10T11:00:00.000Z"),
        state: "INVALIDATED"
      }]
    }) as never, { runIds: ["run-1"], userId: "user-1" });

    expect(evidence.get("run-1")?.receipt?.items).toEqual([
      expect.objectContaining({
        includedText: "Frozen episode summary.",
        itemType: "EPISODE",
        lifecycleState: "CURRENT",
        sourceChatId: "source-chat",
        sourceMode: "HISTORY",
        versionId: null
      }),
      expect.objectContaining({
        includedText: "Frozen previous-chat passage.",
        itemType: "RECALL_CHUNK",
        lifecycleState: "LATER_FORGOTTEN",
        sourceChatId: "source-chat",
        sourceMode: "HISTORY",
        versionId: null
      })
    ]);
    expect(evidence.get("run-1")?.inspection).toMatchObject({
      itemTypes: ["EPISODE", "RECALL_CHUNK"],
      retrievalLanes: ["HISTORY_EPISODE_FTS_ENGLISH", "HISTORY_RECALL_FTS_ENGLISH"]
    });
  });

  it("keeps receipts keyed to their exact answer and projects quiet outcomes without items", async () => {
    const evidence = await loadMemoryRunEvidence(client({
      bindings: [
        binding,
        {
          ...binding,
          id: "binding-2",
          modelRunId: "run-2",
          outcome: "DISABLED",
          retrievalAttemptId: "attempt-2"
        }
      ],
      facts: [{ id: "fact-1", state: "ACTIVE" }],
      items: [item],
      versions: [{
        contentPurgedAt: null,
        factId: "fact-1",
        id: "version-1",
        sourceMode: "EXPLICIT",
        state: "ACTIVE"
      }]
    }) as never, { runIds: ["run-2", "run-1", "run-1"], userId: "user-1" });

    expect(evidence.get("run-1")?.receipt?.items[0]?.includedText)
      .toBe("Prefers exact frozen text.");
    expect(evidence.get("run-2")?.receipt).toMatchObject({
      itemCount: 0,
      items: [],
      outcome: "DISABLED"
    });
  });

  it("projects Forget Undo only while the exact purge obligation is pending", async () => {
    const operation = {
      modelRunId: "run-forget",
      operation: "FORGET",
      persistedToolCallId: "call-forget",
      resultSnapshot: {
        deletionId: "deletion-1",
        undoExpiresAt: "2099-08-10T12:01:00.000Z"
      },
      targetFactId: "fact-1",
      targetVersionId: "version-1"
    };
    const base = {
      deletions: [{
        id: "deletion-1",
        nextAttemptAt: new Date("2099-08-10T12:01:00.000Z"),
        state: "PENDING"
      }],
      operations: [operation],
      toolCalls: [{
        id: "call-forget",
        modelRunId: "run-forget",
        toolName: "forget_memory"
      }],
      versions: [{
        contentPurgedAt: null,
        displayText: "I prefer aisle seats.",
        factId: "fact-1",
        id: "version-1",
        sourceMode: "EXPLICIT",
        state: "FORGOTTEN"
      }]
    };
    const pending = await loadMemoryRunEvidence(client(base) as never, {
      runIds: ["run-forget"],
      userId: "user-1"
    });
    expect(pending.get("run-forget")?.action).toEqual({
      deletionId: "deletion-1",
      expiresAt: "2099-08-10T12:01:00.000Z",
      factId: "fact-1",
      operation: "FORGET",
      statement: "I prefer aisle seats.",
      status: "COMMITTED",
      versionId: "version-1"
    });

    const cancelled = await loadMemoryRunEvidence(client({
      ...base,
      deletions: [{ id: "deletion-1", nextAttemptAt: null, state: "CANCELLED" }]
    }) as never, { runIds: ["run-forget"], userId: "user-1" });
    expect(cancelled.get("run-forget")?.action).toEqual({
      factId: "fact-1",
      operation: "FORGET",
      statement: "I prefer aisle seats.",
      status: "COMMITTED",
      versionId: "version-1"
    });
  });
});
