import { describe, expect, it, vi } from "vitest";
import { loadMemoryRunEvidence } from "./projection";

function client(overrides: Record<string, unknown[]> = {}) {
  const rows = (key: string) => vi.fn(async () => overrides[key] ?? []);
  return {
    chat: { findMany: rows("chats") },
    memoryFact: { findMany: rows("facts") },
    memoryFactVersion: { findMany: rows("versions") },
    memoryOperationReceipt: { findMany: rows("operations") },
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
  retrievalAttemptId: "attempt-1"
};

const item = {
  bindingId: "binding-1",
  factVersionId: "version-1",
  includedText: "Prefers exact frozen text.",
  itemType: "FACT_VERSION",
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
        persistedToolCallId: "call-1"
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
        factId: "fact-1",
        id: "version-1",
        sourceMode: "EXPLICIT",
        state: "SUPERSEDED"
      }]
    }) as never, { runIds: ["run-1"], userId: "user-1" });

    expect(evidence.get("run-1")).toEqual({
      action: { operation: "SAVE", status: "COMMITTED" },
      receipt: {
        degradationCode: null,
        itemCount: 1,
        items: [{
          includedText: "Prefers exact frozen text.",
          itemType: "FACT_VERSION",
          lifecycleState: "CURRENT",
          ordinal: 0,
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
});
