import { describe, expect, it } from "vitest";
import { projectMemoryInspectionEvents } from "./memoryInspectionEvents";

const quietReceipt = {
  degradationCode: null,
  itemCount: 0,
  items: [],
  outcome: "DISABLED" as const,
  summary: "memory_receipt:disabled:0"
};

describe("Memory inspection events", () => {
  it("inserts one passage-free digest before answer events and resequences", () => {
    const events = projectMemoryInspectionEvents({
      events: [
        { eventType: "run_start", payload: { status: "streaming" }, sequence: 4 },
        { eventType: "message_start", payload: {}, sequence: 9 },
        { eventType: "done", payload: { status: "complete" }, sequence: 12 }
      ],
      receipt: quietReceipt
    });

    expect(events.map(({ eventType, sequence }) => [eventType, sequence])).toEqual([
      ["run_start", 0],
      ["memory_retrieval", 1],
      ["message_start", 2],
      ["done", 3]
    ]);
    expect(events[1]?.payload).toEqual({
      automaticFactCount: 0,
      degradationCode: null,
      historyItemCount: 0,
      itemCount: 0,
      itemTypes: [],
      laterLifecycleCount: 0,
      lifecycleStates: [],
      outcome: "DISABLED",
      queryPlannerVersion: null,
      retrievalLanes: [],
      retrievalPipelineVersion: null,
      sourceModes: []
    });
    expect(JSON.stringify(events)).not.toMatch(
      /includedText|sourceChat|sourceMessage|bindingId/i
    );
  });

  it("includes content-free retrieval lane and pipeline evidence", () => {
    const events = projectMemoryInspectionEvents({
      events: [],
      inspection: {
        degradationCode: "memory_vector_unavailable",
        itemCount: 1,
        itemTypes: ["RECALL_CHUNK"],
        outcome: "DEGRADED",
        queryPlannerVersion: "memory-query-planner-v1",
        retrievalLanes: ["HISTORY_RECALL_FTS_ENGLISH"],
        retrievalPipelineVersion: "memory-retrieval-pipeline-v1"
      },
      receipt: {
        degradationCode: "memory_vector_unavailable",
        itemCount: 1,
        items: [{
          includedText: "private passage",
          itemType: "RECALL_CHUNK",
          lifecycleState: "CURRENT",
          ordinal: 0,
          scopeType: "CHAT",
          selectionReason: "history_recall_fts_english",
          sourceChatId: "chat-1",
          sourceMessageIds: ["message-1"],
          sourceMode: "HISTORY",
          versionId: null
        }],
        outcome: "DEGRADED",
        summary: "memory_receipt:degraded:1"
      }
    });

    expect(events[0]?.payload).toEqual({
      automaticFactCount: 0,
      degradationCode: "memory_vector_unavailable",
      historyItemCount: 1,
      itemCount: 1,
      itemTypes: ["RECALL_CHUNK"],
      laterLifecycleCount: 0,
      lifecycleStates: ["CURRENT"],
      outcome: "DEGRADED",
      queryPlannerVersion: "memory-query-planner-v1",
      retrievalLanes: ["HISTORY_RECALL_FTS_ENGLISH"],
      retrievalPipelineVersion: "memory-retrieval-pipeline-v1",
      sourceModes: ["HISTORY"]
    });
    expect(JSON.stringify(events)).not.toContain("private passage");
  });

  it("does not duplicate a stored Memory event", () => {
    const existing = [{
      eventType: "memory_retrieval",
      payload: { itemCount: 1, outcome: "USED" },
      sequence: 3
    }];
    expect(projectMemoryInspectionEvents({ events: existing, receipt: quietReceipt }))
      .toEqual(existing);
  });
});
