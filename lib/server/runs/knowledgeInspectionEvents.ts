import type {
  KnowledgeRunProjection,
  ModelRunEventProjection
} from "../../contracts/runs";

type StoredInspectionEvent = ModelRunEventProjection & {
  createdAt?: string;
};

type KnowledgeToolCallReference = Readonly<{
  id: string;
  providerCallId: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolResultCallId(event: StoredInspectionEvent): string | null {
  if (event.eventType !== "artifact" || !isRecord(event.payload)) return null;
  if (event.payload.artifactType !== "tool_result" || !isRecord(event.payload.payload)) return null;
  const callId = event.payload.payload.callId;
  return typeof callId === "string" && callId.length > 0 ? callId : null;
}

function knowledgeInvocationOrdinal(event: StoredInspectionEvent): number | null {
  if (event.eventType !== "knowledge_retrieval" || !isRecord(event.payload)) return null;
  const ordinal = event.payload.invocationOrdinal;
  return typeof ordinal === "number" && Number.isSafeInteger(ordinal) && ordinal > 0
    ? ordinal
    : null;
}

function knowledgeDigestEvent(receipt: KnowledgeRunProjection): StoredInspectionEvent {
  return {
    createdAt: receipt.createdAt,
    eventType: "knowledge_retrieval",
    payload: {
      candidateCount: receipt.candidateCount,
      durationMs: receipt.durationMs,
      invocationOrdinal: receipt.invocationOrdinal,
      outcome: receipt.outcome,
      query: receipt.query,
      resultCount: receipt.results.length
    },
    sequence: 0
  };
}

/**
 * Adds the private, passage-free Knowledge digest to an authorized run inspection
 * projection. The synthetic event follows its exact tool result; crash-recovery
 * receipts without a persisted result are kept before terminal accounting rows.
 */
export function projectKnowledgeInspectionEvents(input: Readonly<{
  events: readonly StoredInspectionEvent[];
  knowledgeRuns: readonly KnowledgeRunProjection[];
  toolCalls: readonly KnowledgeToolCallReference[];
}>): StoredInspectionEvent[] {
  if (input.knowledgeRuns.length === 0) {
    return input.events.map((event) => ({ ...event }));
  }

  const providerCallIdByStoredId = new Map(
    input.toolCalls.map((call) => [call.id, call.providerCallId] as const)
  );
  const receiptsByProviderCallId = new Map<string, KnowledgeRunProjection[]>();
  for (const receipt of input.knowledgeRuns) {
    const providerCallId = providerCallIdByStoredId.get(receipt.modelRunToolCallId);
    if (!providerCallId) continue;
    const receipts = receiptsByProviderCallId.get(providerCallId) ?? [];
    receipts.push(receipt);
    receiptsByProviderCallId.set(providerCallId, receipts);
  }

  const projected: StoredInspectionEvent[] = [];
  const existingInvocationOrdinals = new Set(
    input.events
      .map(knowledgeInvocationOrdinal)
      .filter((ordinal): ordinal is number => ordinal !== null)
  );
  const placedReceiptIds = new Set(
    input.knowledgeRuns
      .filter((receipt) => existingInvocationOrdinals.has(receipt.invocationOrdinal))
      .map((receipt) => receipt.id)
  );
  for (const event of input.events) {
    projected.push({ ...event });
    const callId = toolResultCallId(event);
    if (!callId) continue;
    for (const receipt of receiptsByProviderCallId.get(callId) ?? []) {
      if (placedReceiptIds.has(receipt.id)) continue;
      projected.push(knowledgeDigestEvent(receipt));
      placedReceiptIds.add(receipt.id);
    }
  }

  const unplaced = input.knowledgeRuns
    .filter((receipt) => !placedReceiptIds.has(receipt.id))
    .map(knowledgeDigestEvent);
  if (unplaced.length > 0) {
    const terminalIndex = projected.findIndex((event) =>
      event.eventType === "usage" || event.eventType === "done" || event.eventType === "error");
    projected.splice(terminalIndex < 0 ? projected.length : terminalIndex, 0, ...unplaced);
  }

  return projected.map((event, sequence) => ({ ...event, sequence }));
}
