import type { Prisma, PrismaClient } from "@prisma/client";

/** Private, exact evidence retained by the native read-only search receipt. */
export type MemorySearchSourceEvidence = Readonly<{
  exactItemId: string;
  factVersionId: string | null;
  featureSnapshot: Prisma.JsonValue;
  includedText: string;
  itemType: "FACT_VERSION" | "RECALL_CHUNK" | "RECALL_ROUND";
  recallChunkId: string | null;
  recallRoundId: string | null;
  selectionReason: string;
  sourceBranchGenerationSnapshot: number | null;
  sourceChatId: string | null;
  sourceContentHashSnapshot: string | null;
  sourceMessageIds: string[];
  sourceRevisionSnapshot: number | null;
}>;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nullableId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 512);
}
function nullableCounter(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

export function decodeMemorySearchSourceEvidence(value: unknown): MemorySearchSourceEvidence[] {
  if (!object(value) || value.version !== "memory-search-v1" ||
    !Array.isArray(value.results) || value.results.length > 30) return [];
  const results: MemorySearchSourceEvidence[] = [];
  for (const entry of value.results) {
    if (!object(entry) || typeof entry.exactItemId !== "string" ||
      !nullableId(entry.exactItemId) || typeof entry.includedText !== "string" ||
      !entry.includedText || entry.includedText.length > 100_000 ||
      typeof entry.selectionReason !== "string" || !object(entry.featureSnapshot) ||
      !nullableId(entry.factVersionId) || !nullableId(entry.recallChunkId) ||
      !nullableId(entry.recallRoundId) || !nullableId(entry.sourceChatId) ||
      !nullableId(entry.sourceContentHashSnapshot) ||
      !nullableCounter(entry.sourceBranchGenerationSnapshot) ||
      !nullableCounter(entry.sourceRevisionSnapshot) ||
      !Array.isArray(entry.sourceMessageIds) || entry.sourceMessageIds.length > 256 ||
      !entry.sourceMessageIds.every((id) => typeof id === "string" && nullableId(id))) return [];
    const exact = entry.itemType === "FACT_VERSION"
      ? entry.factVersionId === entry.exactItemId && entry.recallChunkId === null && entry.recallRoundId === null
      : entry.itemType === "RECALL_CHUNK"
        ? entry.recallChunkId === entry.exactItemId && entry.factVersionId === null && entry.recallRoundId === null
        : entry.itemType === "RECALL_ROUND" && entry.recallRoundId === entry.exactItemId &&
          entry.factVersionId === null && entry.recallChunkId === null;
    if (!exact) return [];
    results.push(entry as MemorySearchSourceEvidence);
  }
  return results;
}

export async function loadDeliveredMemorySearchEvidence(
  client: Pick<PrismaClient, "memoryHistoryRun">,
  userId: string,
  runIds: readonly string[]
) {
  if (runIds.length === 0) return [];
  const receipts = await client.memoryHistoryRun.findMany({
    orderBy: [{ modelRunId: "asc" }, { invocationOrdinal: "asc" }],
    select: { id: true, modelRunId: true, modelRunToolCallId: true, results: true },
    where: {
      indexingEvidence: { path: ["delivered"], equals: true },
      modelRunId: { in: [...runIds] },
      modelRunToolCall: { state: "complete", toolName: "memory_search" },
      plaintextPurgedAt: null,
      retentionState: "RETAINED",
      state: "COMPLETE",
      userId
    }
  });
  return receipts.flatMap((receipt) => decodeMemorySearchSourceEvidence(receipt.results)
    .map((entry) => ({
      ...entry,
      receiptId: receipt.id,
      modelRunId: receipt.modelRunId,
      modelRunToolCallId: receipt.modelRunToolCallId,
      sourceChatIdSnapshot: entry.sourceChatId,
      sourceMessageIdsSnapshot: entry.sourceMessageIds
    })));
}
