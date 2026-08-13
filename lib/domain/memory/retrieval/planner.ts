import type {
  MemoryRetrievalFilters,
  MemoryRetrievalPlan,
  MemoryRetrievalPlannerInput,
  MemoryRetrievalSourceKind
} from "./contracts";

export const MEMORY_RETRIEVAL_PLANNER_VERSION = "memory-retrieval-query-v4";
export const MEMORY_RETRIEVAL_QUERY_MAX_CHARACTERS = 2_000;

const sourceKinds = new Set<MemoryRetrievalSourceKind>(["EVENT", "FACT", "HISTORY"]);
const scopeTypes = new Set(["GLOBAL_USER", "FOLDER", "ASSISTANT", "CHAT"]);
const opaqueTargetPattern = /^[^\u0000-\u001f\u007f]{1,256}$/u;

function boundedUnicode(value: string): string {
  return Array.from(value.normalize("NFKC").trim().replace(/\s+/gu, " "))
    .slice(0, MEMORY_RETRIEVAL_QUERY_MAX_CHARACTERS)
    .join("");
}

function lexicalQuery(value: string): string | null {
  const tokens = value.match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.join(" ").slice(0, MEMORY_RETRIEVAL_QUERY_MAX_CHARACTERS);
}

function validDate(value: Date | null): boolean {
  return value === null || value instanceof Date && Number.isFinite(value.getTime());
}

function filtersFor(input: MemoryRetrievalPlannerInput): MemoryRetrievalFilters {
  const from = input.filters?.from ?? null;
  const to = input.filters?.to ?? null;
  const scopeType = input.filters?.scopeType ?? null;
  const scopeTargetId = input.filters?.scopeTargetId ?? null;
  const requestedKinds = input.filters?.sourceKinds ?? ["EVENT", "FACT", "HISTORY"];
  if (
    !validDate(from) || !validDate(to) ||
    (from !== null && to !== null && from >= to) ||
    (scopeType !== null && !scopeTypes.has(scopeType)) ||
    (scopeTargetId !== null && !opaqueTargetPattern.test(scopeTargetId)) ||
    (scopeTargetId !== null && scopeType === null) ||
    (scopeType === "GLOBAL_USER" && scopeTargetId !== null) ||
    requestedKinds.length < 1 || requestedKinds.length > sourceKinds.size ||
    new Set(requestedKinds).size !== requestedKinds.length ||
    requestedKinds.some((kind) => !sourceKinds.has(kind))
  ) throw new Error("memory_retrieval_filter_invalid");
  return { from, scopeTargetId, scopeType, sourceKinds: [...requestedKinds], to };
}

/**
 * Produces only bounded syntax-level query material. It intentionally performs
 * no language, intent, punctuation, spelling, topic, entity, or date inference.
 * Every non-empty Unicode query is eligible; a null lexical projection merely
 * means PostgreSQL FTS has no token to consume while vector and recency lanes
 * still run with the normalized raw query.
 */
export function planMemoryRetrieval(input: MemoryRetrievalPlannerInput): MemoryRetrievalPlan {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new Error("memory_retrieval_plan_invalid");
  }
  const normalizedQuery = boundedUnicode(input.currentUserText);
  return {
    filters: filtersFor(input),
    lexicalQuery: lexicalQuery(normalizedQuery),
    normalizedExactQuery: normalizedQuery.toLocaleLowerCase("und"),
    normalizedQuery,
    plannerVersion: MEMORY_RETRIEVAL_PLANNER_VERSION,
    queryPresent: normalizedQuery.length > 0
  };
}
