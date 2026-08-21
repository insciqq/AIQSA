export const MEMORY_ACTION_LIFECYCLE_SNAPSHOT_KEY =
  "memoryActionLifecycleSnapshot" as const;

export type MemoryActionLifecycleSnapshot = Readonly<{
  activeLeafMessageId: string;
  branchGeneration: number;
  sourceRevision: number;
  version: 1;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function counter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function memoryActionLifecycleBudgetSnapshot(input: Readonly<{
  activeLeafMessageId: string;
  branchGeneration: number;
  sourceRevision: number;
}>): Readonly<Record<typeof MEMORY_ACTION_LIFECYCLE_SNAPSHOT_KEY,
  MemoryActionLifecycleSnapshot>> {
  return Object.freeze({
    [MEMORY_ACTION_LIFECYCLE_SNAPSHOT_KEY]: Object.freeze({
      ...input,
      version: 1 as const
    })
  });
}

export function decodeMemoryActionLifecycleSnapshot(
  budgetSnapshot: unknown
): MemoryActionLifecycleSnapshot | null {
  const budget = record(budgetSnapshot);
  const snapshot = record(budget?.[MEMORY_ACTION_LIFECYCLE_SNAPSHOT_KEY]);
  if (
    !snapshot || snapshot.version !== 1 ||
    typeof snapshot.activeLeafMessageId !== "string" ||
    snapshot.activeLeafMessageId.length === 0 ||
    snapshot.activeLeafMessageId.length > 256 ||
    !counter(snapshot.branchGeneration) ||
    !counter(snapshot.sourceRevision)
  ) return null;
  return {
    activeLeafMessageId: snapshot.activeLeafMessageId,
    branchGeneration: snapshot.branchGeneration,
    sourceRevision: snapshot.sourceRevision,
    version: 1
  };
}
