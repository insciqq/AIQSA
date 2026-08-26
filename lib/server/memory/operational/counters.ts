export const MEMORY_OPERATIONAL_COUNTER_KEYS = Object.freeze([
  "digestFullRebuild",
  "digestIncremental",
  "digestNoop",
  "digestSegmentsProcessed",
  "digestSourceChunksProcessed",
  "historyChunksBuilt",
  "historyChunksReplaced",
  "historyChunksReused",
  "historyMessageContentRowsLoaded",
  "historyMessagesProjected",
  "historyModelRunRowsLoaded",
  "historyPathMetadataRowsRead"
] as const);

export type MemoryOperationalCounterKey =
  (typeof MEMORY_OPERATIONAL_COUNTER_KEYS)[number];

export type MemoryOperationalCounters = Readonly<
  Partial<Record<MemoryOperationalCounterKey, number>>
>;

const allowedKeys = new Set<string>(MEMORY_OPERATIONAL_COUNTER_KEYS);

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 &&
    Number(value) <= 2_147_483_647;
}

/** Decode the only value shape that may enter the durable operational field. */
export function decodeMemoryOperationalCounters(
  value: unknown
): MemoryOperationalCounters | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([key, count]) => !allowedKeys.has(key) || !validCount(count))) {
    return null;
  }
  return Object.freeze(Object.fromEntries(entries)) as MemoryOperationalCounters;
}
