import { describe, expect, it, vi } from "vitest";
import { loadMemoryRunActions } from "./runProjection";

function client(overrides: Record<string, unknown[]> = {}) {
  const rows = (key: string) => vi.fn(async () => overrides[key] ?? []);
  return {
    memoryDeletionOutbox: { findMany: rows("deletions") },
    memoryFactVersion: { findMany: rows("versions") },
    memoryFeedback: {
      findMany: vi.fn(async (input: { where?: { feedbackType?: string } }) =>
        input.where?.feedbackType === "RETRACT"
          ? overrides.retractions ?? []
          : overrides.feedback ?? [])
    },
    memoryOperationReceipt: { findMany: rows("operations") },
    modelRunToolCall: { findMany: rows("toolCalls") }
  };
}

describe("Memory run action projection", () => {
  it("projects a committed mutation only through its exact first-party tool call", async () => {
    const actions = await loadMemoryRunActions(client({
      operations: [{
        modelRunId: "run-1",
        operation: "SAVE",
        persistedToolCallId: "call-1",
        resultSnapshot: {},
        targetFactId: "fact-1",
        targetVersionId: "version-1"
      }],
      toolCalls: [{ id: "call-1", modelRunId: "run-1", toolName: "save_memory" }],
      versions: [{
        contentPurgedAt: null,
        displayText: "Prefers exact frozen text.",
        factId: "fact-1",
        id: "version-1",
        state: "ACTIVE"
      }]
    }) as never, { runIds: ["run-1"], userId: "user-1" });

    expect(actions.get("run-1")).toEqual({
      factId: "fact-1",
      operation: "SAVE",
      statement: "Prefers exact frozen text.",
      status: "COMMITTED",
      versionId: "version-1"
    });
  });

  it("drops mismatched and retracted action provenance", async () => {
    const mismatched = await loadMemoryRunActions(client({
      operations: [{
        modelRunId: "run-1",
        operation: "SAVE",
        persistedToolCallId: "call-1",
        resultSnapshot: {},
        targetFactId: null,
        targetVersionId: null
      }],
      toolCalls: [{ id: "call-1", modelRunId: "run-2", toolName: "save_memory" }]
    }) as never, { runIds: ["run-1"], userId: "user-1" });
    expect(mismatched.size).toBe(0);

    const retracted = await loadMemoryRunActions(client({
      feedback: [{
        feedbackType: "INCORRECT",
        id: "feedback-1",
        modelRunId: "run-1",
        modelRunToolCallId: "call-1",
        retractsFeedbackId: null
      }],
      retractions: [{
        feedbackType: "RETRACT",
        id: "retraction-1",
        modelRunId: null,
        modelRunToolCallId: null,
        retractsFeedbackId: "feedback-1"
      }],
      toolCalls: [{
        id: "call-1",
        modelRunId: "run-1",
        toolName: "mark_memory_incorrect"
      }]
    }) as never, { runIds: ["run-1"], userId: "user-1" });
    expect(retracted.size).toBe(0);
  });
});
