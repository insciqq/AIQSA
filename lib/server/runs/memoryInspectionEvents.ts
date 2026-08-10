import type { MemoryReceipt } from "../../contracts/memory";
import type { ModelRunEventProjection } from "../../contracts/runs";

type StoredInspectionEvent = ModelRunEventProjection & { createdAt?: string };

function isMemoryEvent(event: StoredInspectionEvent): boolean {
  return event.eventType === "memory_retrieval";
}

function memoryDigestEvent(receipt: MemoryReceipt): StoredInspectionEvent {
  return {
    eventType: "memory_retrieval",
    payload: {
      degradationCode: receipt.degradationCode,
      itemCount: receipt.itemCount,
      outcome: receipt.outcome
    },
    sequence: 0
  };
}

/** Adds one content-free private Memory digest at its pre-answer position. */
export function projectMemoryInspectionEvents(input: Readonly<{
  events: readonly StoredInspectionEvent[];
  receipt: MemoryReceipt | null;
}>): StoredInspectionEvent[] {
  const events = input.events.map((event) => ({ ...event }));
  if (!input.receipt || events.some(isMemoryEvent)) return events;

  const runStartIndex = events.findIndex((event) => event.eventType === "run_start");
  const firstAnswerIndex = events.findIndex((event) =>
    event.eventType === "message_start" || event.eventType === "token" ||
    event.eventType === "usage" || event.eventType === "done" || event.eventType === "error");
  const insertionIndex = runStartIndex >= 0
    ? runStartIndex + 1
    : firstAnswerIndex >= 0 ? firstAnswerIndex : events.length;
  events.splice(insertionIndex, 0, memoryDigestEvent(input.receipt));
  return events.map((event, sequence) => ({ ...event, sequence }));
}
