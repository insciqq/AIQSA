import type { MemoryContextualFallbackReason } from "../history/rounds";

export const MEMORY_CONTEXTUAL_FALLBACK_COUNTER_KEYS = Object.freeze({
  DUPLICATE_STATEMENT: "contextualFallbackDuplicateStatement",
  EMPTY_STATEMENTS: "contextualFallbackEmptyStatements",
  HANDLE_MISMATCH: "contextualFallbackHandleMismatch",
  NOT_ELIGIBLE: "contextualFallbackNotEligible",
  PROVIDER_OUTPUT_INVALID: "contextualFallbackProviderOutputInvalid",
  PROVIDER_UNAVAILABLE: "contextualFallbackProviderUnavailable",
  SAFETY_REDACTED_OR_REJECTED: "contextualFallbackSafetyRedactedOrRejected",
  SEARCH_TEXT_BUDGET_EXCEEDED: "contextualFallbackSearchTextBudgetExceeded",
  SOURCE_REF_INVALID: "contextualFallbackSourceRefInvalid",
  STATEMENT_COUNT_INVALID: "contextualFallbackStatementCountInvalid",
  STATEMENT_TOO_LONG: "contextualFallbackStatementTooLong",
  UNSUPPORTED_DATE: "contextualFallbackUnsupportedDate",
  UNSUPPORTED_ENTITY: "contextualFallbackUnsupportedEntity",
  UNSUPPORTED_NUMBER: "contextualFallbackUnsupportedNumber",
  UNSUPPORTED_TOKEN: "contextualFallbackUnsupportedToken"
} as const satisfies Readonly<Record<MemoryContextualFallbackReason, string>>);

export const MEMORY_CONTEXTUAL_LANGUAGE_COUNTER_KEYS = Object.freeze({
  fallback: Object.freeze({
    en: "contextualFallbackEn",
    mixed: "contextualFallbackMixed",
    other: "contextualFallbackOther",
    ru: "contextualFallbackRu",
    und: "contextualFallbackUnd"
  }),
  generated: Object.freeze({
    en: "contextualGeneratedEn",
    mixed: "contextualGeneratedMixed",
    other: "contextualGeneratedOther",
    ru: "contextualGeneratedRu",
    und: "contextualGeneratedUnd"
  })
} as const);

const contextualCounterKeys = Object.freeze([
  ...Object.values(MEMORY_CONTEXTUAL_FALLBACK_COUNTER_KEYS),
  ...Object.values(MEMORY_CONTEXTUAL_LANGUAGE_COUNTER_KEYS.fallback),
  ...Object.values(MEMORY_CONTEXTUAL_LANGUAGE_COUNTER_KEYS.generated)
] as const);

export const MEMORY_OPERATIONAL_COUNTER_KEYS = Object.freeze([
  "digestFullRebuild",
  "digestIncremental",
  "digestNoop",
  "digestSegmentsProcessed",
  "digestSourceChunksProcessed",
  "contextualProviderRequests",
  "contextualRoundsFallback",
  "contextualRoundsGenerated",
  "embeddingBatchItems",
  "embeddingFailedItems",
  "embeddingProviderRequests",
  "embeddingSettledItems",
  "embeddingStaleItems",
  "historyChunksBuilt",
  "historyChunksReplaced",
  "historyChunksReused",
  "historyMessageContentRowsLoaded",
  "historyMessagesProjected",
  "historyModelRunRowsLoaded",
  "historyPathMetadataRowsRead",
  "historyRoundSegmentsBuilt",
  "historyRoundSegmentsReplaced",
  "historyRoundSegmentsReused",
  "historyRoundsBuilt",
  "historyRoundsReplaced",
  "historyRoundsReused",
  ...contextualCounterKeys,
  "synthesisClusterCount",
  "synthesisEligibleSourceCount",
  "synthesisEmptyOutputCount",
  "synthesisProposalCount"
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
