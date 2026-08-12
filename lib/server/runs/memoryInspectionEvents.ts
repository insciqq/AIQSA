import type { MemoryReceipt } from "../../contracts/memory";
import type { ModelRunEventProjection } from "../../contracts/runs";
import type { MemoryRunEvidenceProjection } from "../memory/receipts/projection";

type StoredInspectionEvent = ModelRunEventProjection & { createdAt?: string };

function isMemoryEvent(event: StoredInspectionEvent): boolean {
  return event.eventType === "memory_retrieval";
}

function memoryDigestEvent(
  receipt: MemoryReceipt,
  inspection: MemoryRunEvidenceProjection["inspection"]
): StoredInspectionEvent {
  const sourceModes = [...new Set(receipt.items.map(({ sourceMode }) => sourceMode))].sort();
  const lifecycleStates = [...new Set(receipt.items.map(({ lifecycleState }) =>
    lifecycleState))].sort();
  return {
    eventType: "memory_retrieval",
    payload: {
      degradationCode: receipt.degradationCode,
      automaticFactCount: receipt.items.filter((item) =>
        item.itemType === "FACT_VERSION" && item.sourceMode === "AUTOMATIC").length,
      historyItemCount: receipt.items.filter((item) =>
        item.sourceMode === "HISTORY").length,
      itemCount: receipt.itemCount,
      itemTypes: inspection?.itemTypes ?? [],
      laterLifecycleCount: receipt.items.filter((item) =>
        item.lifecycleState !== "CURRENT").length,
      lifecycleStates,
      outcome: receipt.outcome,
      queryPlannerVersion: inspection?.queryPlannerVersion ?? null,
      retrievalLanes: inspection?.retrievalLanes ?? [],
      retrievalPipelineVersion: inspection?.retrievalPipelineVersion ?? null,
      sourceModes
    },
    sequence: 0
  };
}

/** Adds one content-free private Memory digest at its pre-answer position. */
export function projectMemoryInspectionEvents(input: Readonly<{
  events: readonly StoredInspectionEvent[];
  inspection?: MemoryRunEvidenceProjection["inspection"];
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
  events.splice(insertionIndex, 0, memoryDigestEvent(
    input.receipt,
    input.inspection ?? null
  ));
  return events.map((event, sequence) => ({ ...event, sequence }));
}
