import type { MemoryBulkDeleteOperation } from "../../contracts/memory";

export type MemorySourceBarrierKind = "AUTOMATIC_FACTS" | "HISTORY_INDEX" | "ALL_REUSABLE";

export type MemoryDeletionOperationFixture = Readonly<{
  advancesMemoryGeneration: true;
  advancesMemoryRevision: true;
  operation: MemoryBulkDeleteOperation;
  sourceBarrier: MemorySourceBarrierKind | null;
  suppressesExactSourceEvidence: boolean;
}>;

export const MEMORY_DELETION_OPERATION_FIXTURES: readonly MemoryDeletionOperationFixture[] =
  Object.freeze([
    Object.freeze({
      advancesMemoryGeneration: true,
      advancesMemoryRevision: true,
      operation: "DELETE_EXPLICIT",
      sourceBarrier: null,
      suppressesExactSourceEvidence: true
    }),
    Object.freeze({
      advancesMemoryGeneration: true,
      advancesMemoryRevision: true,
      operation: "DELETE_LEARNED",
      sourceBarrier: "AUTOMATIC_FACTS",
      suppressesExactSourceEvidence: false
    }),
    Object.freeze({
      advancesMemoryGeneration: true,
      advancesMemoryRevision: true,
      operation: "CLEAR_HISTORY_INDEX",
      sourceBarrier: "HISTORY_INDEX",
      suppressesExactSourceEvidence: false
    }),
    Object.freeze({
      advancesMemoryGeneration: true,
      advancesMemoryRevision: true,
      operation: "DELETE_ALL_REUSABLE",
      sourceBarrier: "ALL_REUSABLE",
      suppressesExactSourceEvidence: true
    })
  ]);

export function memoryDeletionOperationFixture(
  operation: MemoryBulkDeleteOperation
): MemoryDeletionOperationFixture {
  const fixture = MEMORY_DELETION_OPERATION_FIXTURES.find((candidate) =>
    candidate.operation === operation
  );
  if (!fixture) throw new Error(`Unsupported Memory deletion operation: ${operation}`);
  return fixture;
}

export function memoryDeletionOperationMatches(
  operation: MemoryBulkDeleteOperation,
  proposed: Omit<MemoryDeletionOperationFixture, "operation">
): boolean {
  const expected = memoryDeletionOperationFixture(operation);
  return expected.advancesMemoryGeneration === proposed.advancesMemoryGeneration &&
    expected.advancesMemoryRevision === proposed.advancesMemoryRevision &&
    expected.sourceBarrier === proposed.sourceBarrier &&
    expected.suppressesExactSourceEvidence === proposed.suppressesExactSourceEvidence;
}
