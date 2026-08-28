import type {
  MemoryRetrievalEntityMention,
  MemoryRetrievalFilters,
  MemoryRetrievalMode,
  MemoryRetrievalPlan,
  MemoryRetrievalPlannerInput,
  MemoryRetrievalSourceKind,
  MemorySemanticQueryVariant,
  MemoryTemporalQueryVariant,
  MemoryTemporalIntent
} from "./contracts";
import { MEMORY_RETRIEVAL_MODES, MEMORY_TEMPORAL_INTENTS } from "./contracts";
import {
  parseMemoryTemporalQuery,
  type MemoryTemporalQueryParseResult
} from "./temporal";
import { normalizeMemoryLexicalProjection } from "./lexical";

export const MEMORY_RETRIEVAL_PLANNER_VERSION = "memory-retrieval-query-v17";
export const MEMORY_RETRIEVAL_QUERY_MAX_CHARACTERS = 2_000;
export const MEMORY_RETRIEVAL_MAX_ENTITY_MENTIONS = 8;
export const MEMORY_RETRIEVAL_MAX_ENTITY_REF_CHARACTERS = 2_048;
export const MEMORY_RETRIEVAL_MAX_SEMANTIC_QUERY_VARIANTS = 4;
export const MEMORY_RETRIEVAL_MAX_DECOMPOSED_QUERY_VARIANTS = 2;
export const MEMORY_RETRIEVAL_MAX_TEMPORAL_QUERY_VARIANTS = 2;

const sourceKinds = new Set<MemoryRetrievalSourceKind>(["EVENT", "FACT", "HISTORY"]);
const scopeTypes = new Set(["GLOBAL_USER", "FOLDER", "ASSISTANT", "CHAT"]);
const opaqueTargetPattern = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const opaqueEntityRefPattern = /^[^\u0000-\u0020\u007f]{1,2048}$/u;

function boundedUnicode(value: string): string {
  return Array.from(value.normalize("NFKC").trim().replace(/\s+/gu, " "))
    .slice(0, MEMORY_RETRIEVAL_QUERY_MAX_CHARACTERS)
    .join("");
}

function lexicalQuery(values: readonly string[]): string | null {
  const tokens = values.flatMap((value) => value.match(/[\p{L}\p{N}]+/gu) ?? []);
  if (tokens.length === 0) return null;
  const seen = new Set<string>();
  return tokens.filter((token) => {
    const key = token.toLocaleLowerCase("und");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(" ").slice(0, MEMORY_RETRIEVAL_QUERY_MAX_CHARACTERS);
}

function validDate(value: Date | null): boolean {
  return value === null || value instanceof Date && Number.isFinite(value.getTime());
}

function validOpaqueRef(value: string): boolean {
  return opaqueEntityRefPattern.test(value);
}

function exactOccurrenceExists(
  query: string,
  mention: string,
  occurrenceIndex: number
): boolean {
  let from = 0;
  for (let occurrence = 0; occurrence <= occurrenceIndex; occurrence += 1) {
    const at = query.indexOf(mention, from);
    if (at < 0) return false;
    if (occurrence === occurrenceIndex) return true;
    from = at + mention.length;
  }
  return false;
}

function entityMentionsFor(
  input: MemoryRetrievalPlannerInput,
  queryTexts: readonly string[]
): readonly MemoryRetrievalEntityMention[] {
  const mentions = input.entityMentions ?? [];
  const allowedRefs = input.allowedEntityRefs ?? [];
  if (!Array.isArray(mentions) || mentions.length > MEMORY_RETRIEVAL_MAX_ENTITY_MENTIONS ||
    !Array.isArray(allowedRefs) || allowedRefs.length > 20 ||
    allowedRefs.some((ref) => !validOpaqueRef(ref))) {
    throw new Error("memory_retrieval_plan_invalid");
  }
  const allowed = new Set(allowedRefs);
  const seen = new Set<string>();
  return Object.freeze(mentions.flatMap((mention) => {
    if (!mention || typeof mention !== "object" ||
      typeof mention.text !== "string" || mention.text.trim() !== mention.text ||
      mention.text.length < 1 || mention.text.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(mention.text) ||
      !Number.isSafeInteger(mention.occurrenceIndex) ||
      mention.occurrenceIndex < 0 || mention.occurrenceIndex > 15 ||
      (mention.resolvedRef !== null && !validOpaqueRef(mention.resolvedRef))) {
      throw new Error("memory_retrieval_plan_invalid");
    }
    if (!queryTexts.some((query) =>
      exactOccurrenceExists(query, mention.text, mention.occurrenceIndex))) return [];
    const key = `${mention.text}\u0000${mention.occurrenceIndex}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [Object.freeze({
      occurrenceIndex: mention.occurrenceIndex,
      resolvedRef: mention.resolvedRef && allowed.has(mention.resolvedRef)
        ? mention.resolvedRef
        : null,
      text: mention.text
    })];
  }));
}

function semanticVariants(
  originalSanitizedQuery: string,
  semanticRewrite: string,
  semanticDecompositions: readonly string[],
  entityMentions: readonly MemoryRetrievalEntityMention[]
): readonly MemorySemanticQueryVariant[] {
  const values: MemorySemanticQueryVariant[] = [];
  const seen = new Set<string>();
  const add = (kind: MemorySemanticQueryVariant["kind"], text: string) => {
    if (!text) return;
    const key = text.toLocaleLowerCase("und");
    if (seen.has(key) || values.length >= MEMORY_RETRIEVAL_MAX_SEMANTIC_QUERY_VARIANTS) return;
    seen.add(key);
    values.push(Object.freeze({ kind, text }));
  };
  add("ORIGINAL", originalSanitizedQuery);
  add("PLANNER_REWRITE", semanticRewrite);
  for (const decomposition of semanticDecompositions) add("DECOMPOSED", decomposition);
  add("ENTITY_EXPANSION", boundedUnicode(
    [...new Set(entityMentions.map(({ text }) => text))].join(" ")
  ));
  return Object.freeze(values);
}

function temporalVariants(
  originalSanitizedQuery: string,
  intent: MemoryTemporalIntent,
  temporalQuery: MemoryTemporalQueryParseResult
): readonly MemoryTemporalQueryVariant[] {
  if (!originalSanitizedQuery) return Object.freeze([]);
  const variants: MemoryTemporalQueryVariant[] = [];
  if (intent === "AS_OF" || intent === "BETWEEN" || temporalQuery.state === "MATCHED") {
    variants.push(Object.freeze({ kind: "FILTERED", text: originalSanitizedQuery }));
  }
  variants.push(Object.freeze({ kind: "UNRESTRICTED", text: originalSanitizedQuery }));
  return Object.freeze(variants.slice(0, MEMORY_RETRIEVAL_MAX_TEMPORAL_QUERY_VARIANTS));
}

function filtersFor(
  input: MemoryRetrievalPlannerInput,
  applyResponsePreferences: boolean
): MemoryRetrievalFilters {
  const asOf = input.filters?.asOf ?? null;
  const from = input.filters?.from ?? null;
  const to = input.filters?.to ?? null;
  const scopeType = input.filters?.scopeType ?? null;
  const scopeTargetId = input.filters?.scopeTargetId ?? null;
  const requestedKinds = input.filters?.sourceKinds ?? ["EVENT", "FACT", "HISTORY"];
  if (
    !validDate(asOf) || !validDate(from) || !validDate(to) ||
    (asOf !== null && (from !== null || to !== null)) ||
    (from !== null && to !== null && from >= to) ||
    (scopeType !== null && !scopeTypes.has(scopeType)) ||
    (scopeTargetId !== null && !opaqueTargetPattern.test(scopeTargetId)) ||
    (scopeTargetId !== null && scopeType === null) ||
    (scopeType === "GLOBAL_USER" && scopeTargetId !== null) ||
    requestedKinds.length > sourceKinds.size ||
    (requestedKinds.length === 0 && !applyResponsePreferences) ||
    new Set(requestedKinds).size !== requestedKinds.length ||
    requestedKinds.some((kind) => !sourceKinds.has(kind))
  ) throw new Error("memory_retrieval_filter_invalid");
  return { asOf, from, scopeTargetId, scopeType, sourceKinds: [...requestedKinds], to };
}

function inferredMode(
  input: MemoryRetrievalPlannerInput,
  filters: MemoryRetrievalFilters,
  profileRequested: boolean
): MemoryRetrievalMode {
  if (input.mode) return input.mode;
  if (profileRequested) return "CURRENT_PROFILE";
  const facts = filters.sourceKinds.includes("FACT") || filters.sourceKinds.includes("EVENT");
  return !facts && filters.sourceKinds.includes("HISTORY")
    ? "PAST_CHAT_SEARCH"
    : "TARGETED_CURRENT";
}

function inferredTemporalIntent(
  input: MemoryRetrievalPlannerInput,
  filters: MemoryRetrievalFilters,
  mode: MemoryRetrievalMode
): MemoryTemporalIntent {
  if (input.temporalIntent) return input.temporalIntent;
  if (filters.asOf) return "AS_OF";
  if (filters.from || filters.to) return "BETWEEN";
  return mode === "HISTORICAL_MEMORY" ? "HISTORICAL" : "CURRENT";
}

function validModeContract(
  mode: MemoryRetrievalMode,
  temporalIntent: MemoryTemporalIntent,
  filters: MemoryRetrievalFilters,
  profileRequested: boolean,
  recencyRequested: boolean
): boolean {
  const facts = filters.sourceKinds.includes("FACT") || filters.sourceKinds.includes("EVENT");
  const history = filters.sourceKinds.includes("HISTORY");
  const temporalShape = temporalIntent === "AS_OF"
    ? filters.asOf !== null && filters.from === null && filters.to === null
    : temporalIntent === "BETWEEN"
      ? filters.asOf === null && (filters.from !== null || filters.to !== null)
      : filters.asOf === null && filters.from === null && filters.to === null;
  if (!temporalShape) return false;
  if (mode === "CURRENT_PROFILE") {
    return profileRequested && facts && !history && !recencyRequested &&
      temporalIntent === "CURRENT";
  }
  if (profileRequested) return false;
  if (mode === "TARGETED_CURRENT") {
    return (facts || filters.sourceKinds.length === 0) &&
      (temporalIntent === "CURRENT" || temporalIntent === "ANY");
  }
  if (mode === "HISTORICAL_MEMORY") {
    return facts && !history && temporalIntent !== "CURRENT";
  }
  if (mode === "PAST_CHAT_SEARCH") {
    return !facts && history && temporalIntent !== "HISTORICAL";
  }
  return mode === "HISTORY_OVERVIEW" && !facts && history && !recencyRequested;
}

/**
 * Produces only bounded syntax-level query material. It intentionally performs
 * no general language, topic, spelling, or semantic intent inference. The one
 * deliberate language-aware exception is the bounded deterministic EN/RU
 * calendar parser carried beside, never instead of, the original query.
 * Every non-empty Unicode query is eligible; a null lexical projection merely
 * means PostgreSQL FTS has no token to consume while vector and recency lanes
 * still run with the normalized raw query.
 */
export function planMemoryRetrieval(input: MemoryRetrievalPlannerInput): MemoryRetrievalPlan {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new Error("memory_retrieval_plan_invalid");
  }
  if (input.recencyRequested !== undefined && typeof input.recencyRequested !== "boolean") {
    throw new Error("memory_retrieval_plan_invalid");
  }
  if (input.applyResponsePreferences !== undefined &&
    typeof input.applyResponsePreferences !== "boolean") {
    throw new Error("memory_retrieval_plan_invalid");
  }
  if (input.aggregationRequested !== undefined &&
    typeof input.aggregationRequested !== "boolean") {
    throw new Error("memory_retrieval_plan_invalid");
  }
  if (input.includePatterns !== undefined && typeof input.includePatterns !== "boolean") {
    throw new Error("memory_retrieval_plan_invalid");
  }
  if (input.profileRequested !== undefined && typeof input.profileRequested !== "boolean") {
    throw new Error("memory_retrieval_plan_invalid");
  }
  if (input.semanticRewrite !== undefined && input.semanticRewrite !== null &&
    typeof input.semanticRewrite !== "string") {
    throw new Error("memory_retrieval_plan_invalid");
  }
  if (input.semanticDecompositions !== undefined && (
    !Array.isArray(input.semanticDecompositions) ||
    input.semanticDecompositions.length > MEMORY_RETRIEVAL_MAX_DECOMPOSED_QUERY_VARIANTS ||
    input.semanticDecompositions.some((value) => typeof value !== "string")
  )) {
    throw new Error("memory_retrieval_plan_invalid");
  }
  const applyResponsePreferences = input.applyResponsePreferences === true;
  const profileRequested = input.profileRequested === true;
  if (profileRequested && input.recencyRequested === true) {
    throw new Error("memory_retrieval_plan_invalid");
  }
  const normalizedQuery = boundedUnicode(input.currentUserText);
  const temporalQuery = parseMemoryTemporalQuery({
    now: input.now,
    query: normalizedQuery,
    timeZone: input.timeZone ?? "UTC"
  });
  const normalizedRewrite = boundedUnicode(input.semanticRewrite ?? "");
  const normalizedDecompositions = (input.semanticDecompositions ?? [])
    .map(boundedUnicode)
    .filter(Boolean);
  const entityMentions = entityMentionsFor(input, [
    input.currentUserText,
    input.semanticRewrite ?? ""
  ]);
  const filters = filtersFor(input, applyResponsePreferences);
  const mode = inferredMode(input, filters, profileRequested);
  const temporalIntent = inferredTemporalIntent(input, filters, mode);
  const includePatterns = input.includePatterns === true;
  const aggregationRequested = input.aggregationRequested === true;
  if (
    !MEMORY_RETRIEVAL_MODES.includes(mode) ||
    !MEMORY_TEMPORAL_INTENTS.includes(temporalIntent) ||
    !validModeContract(
      mode,
      temporalIntent,
      filters,
      profileRequested,
      input.recencyRequested === true
    ) || includePatterns && mode !== "TARGETED_CURRENT" ||
    aggregationRequested && mode !== "PAST_CHAT_SEARCH" &&
      mode !== "HISTORY_OVERVIEW"
  ) throw new Error("memory_retrieval_plan_invalid");
  const semanticQueryVariants = semanticVariants(
    normalizedQuery,
    normalizedRewrite,
    normalizedDecompositions,
    entityMentions
  );
  return {
    aggregationRequested,
    answerFocus: normalizedRewrite || null,
    applyResponsePreferences,
    entityMentions,
    filters,
    includePatterns,
    lexicalQuery: lexicalQuery(semanticQueryVariants.map(({ text }) => text)),
    mode,
    normalizedExactQuery: normalizeMemoryLexicalProjection(normalizedQuery),
    normalizedQuery,
    originalSanitizedQuery: normalizedQuery,
    plannerVersion: MEMORY_RETRIEVAL_PLANNER_VERSION,
    profileRequested,
    queryPresent: normalizedQuery.length > 0,
    recencyRequested: input.recencyRequested === true,
    semanticQueryVariants,
    temporalIntent,
    temporalQuery,
    temporalQueryVariants: temporalVariants(normalizedQuery, temporalIntent, temporalQuery)
  };
}
