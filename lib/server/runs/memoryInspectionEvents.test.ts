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
      degradationCode: null,
      itemCount: 0,
      outcome: "DISABLED"
    });
    expect(JSON.stringify(events)).not.toMatch(/includedText|version|source|binding/i);
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
