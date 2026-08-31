import { createHash, randomUUID } from "node:crypto";
import type { MemorySearchItemType } from "@prisma/client";
import {
  assertMemoryLexicalSearchRequest,
  type MemoryLexicalMatchMode,
  type MemoryLexicalRawCandidate,
  type MemoryLexicalSearchRequest
} from "../../memory/retrieval/lexical/contract";
import { AIQSA_OPENSEARCH_VERSION } from "./contract";
import {
  BoundedOpenSearchCoreTransport,
  OpenSearchTransportError
} from "./coreTransport";
import {
  MEMORY_OPENSEARCH_ANALYZER_GOLDEN,
  MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
  MEMORY_OPENSEARCH_BACKEND_KIND,
  MEMORY_OPENSEARCH_INTEGRITY_PAGE_SIZE,
  MEMORY_OPENSEARCH_MAPPING_VERSION,
  MEMORY_OPENSEARCH_MAX_INTEGRITY_DOCUMENTS,
  MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
  MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
  assertMemoryOpenSearchDocument,
  memoryOpenSearchConfigurationFromEnv,
  memoryOpenSearchDocumentId,
  memoryOpenSearchIndexDefinition,
  memoryOpenSearchIntegrityFingerprintMaterial,
  memoryOpenSearchUserScope,
  type MemoryOpenSearchConfiguration,
  type MemoryOpenSearchDocument,
  type MemoryOpenSearchMutation
} from "./memoryContract";

const HEALTH_RESPONSE_MAX_BYTES = 1024 * 1024;
const maximumSignedInt64 = 9_223_372_036_854_775_807n;
const hashPattern = /^[a-f0-9]{64}$/u;
const memoryPhysicalIndexPattern =
  /^aiqsa-memory-lexical-v1-[a-z0-9][a-z0-9-]{0,31}$/u;
const maximumAliasBindings = 4;
const MEMORY_MSEARCH_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MEMORY_MSEARCH_MAX_SUBSEARCHES = 8;
const MEMORY_NGRAM_MINIMUM_SHOULD_MATCH = "3<60%";
const memoryNamedClausePattern =
  /^v([0-3]):t((?:0|[1-5]?[0-9]|6[0-3])):m([UFTN]):l([1-9][0-9]{0,3})$/u;

type MemoryOpenSearchMatchCode = "F" | "N" | "T" | "U";

type MemoryOpenSearchMode = Readonly<{
  boost: number;
  code: MemoryOpenSearchMatchCode;
  field: string;
  matchMode: MemoryLexicalMatchMode;
}>;

const memoryOpenSearchModes = Object.freeze({
  F: Object.freeze({
    boost: 0.55,
    code: "F",
    field: "lexical_text.folded",
    matchMode: "FOLDED"
  }),
  N: Object.freeze({
    boost: 0.2,
    code: "N",
    field: "lexical_text.ngram",
    matchMode: "NGRAM"
  }),
  T: Object.freeze({
    boost: 0.35,
    code: "T",
    field: "lexical_text.transliterated",
    matchMode: "TRANSLITERATED"
  }),
  U: Object.freeze({
    boost: 1,
    code: "U",
    field: "lexical_text",
    matchMode: "UNICODE"
  })
} as const satisfies Record<MemoryOpenSearchMatchCode, MemoryOpenSearchMode>);

const memoryModeConfidence = new Map<MemoryLexicalMatchMode, number>([
  ["UNICODE", 0],
  ["FOLDED", 1],
  ["TRANSLITERATED", 2],
  ["NGRAM", 3]
]);

export type MemoryOpenSearchLexicalPhase = "FALLBACK" | "PRIMARY";

export type MemoryOpenSearchLexicalSearchResult = Readonly<{
  candidates: readonly MemoryLexicalRawCandidate[];
  durationMs: number;
  opaqueId: string;
}>;

export type MemoryOpenSearchGenerationInventory = Readonly<{
  documentCount: number;
  fingerprint: string;
}>;

export type MemoryOpenSearchBulkResult = Readonly<{
  applied: number;
  opaqueId: string;
  superseded: number;
}>;

export interface MemoryOpenSearchClient {
  activateReplacementIndex(): Promise<void>;
  applyMutations(
    mutations: readonly MemoryOpenSearchMutation[],
    refresh: "NONE" | "WAIT_FOR"
  ): Promise<MemoryOpenSearchBulkResult>;
  ensureIndex(): Promise<void>;
  inspectGeneration(input: Readonly<{
    generationId: string;
    routing: string;
    userScope: string;
  }>): Promise<MemoryOpenSearchGenerationInventory>;
  purgeGeneration(input: Readonly<{
    generationId: string;
    routing: string;
    userScope: string;
  }>): Promise<void>;
  purgeUser(input: Readonly<{
    routing: string;
    userScope: string;
  }>): Promise<void>;
  prepareReplacementIndex(): Promise<void>;
  refreshIndex(): Promise<void>;
  searchLexical(input: Readonly<{
    phase: MemoryOpenSearchLexicalPhase;
    request: MemoryLexicalSearchRequest;
    signal?: AbortSignal;
  }>): Promise<MemoryOpenSearchLexicalSearchResult>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function effectiveSearchAnalyzer(value: Record<string, unknown>): string | null {
  if ("search_analyzer" in value) {
    return typeof value.search_analyzer === "string"
      ? value.search_analyzer
      : null;
  }
  return typeof value.analyzer === "string" ? value.analyzer : "standard";
}

function exactMemoryMapping(value: unknown): boolean {
  if (!record(value) || value.dynamic !== "strict" || !record(value._source) ||
    value._source.enabled !== false || !record(value._routing) ||
    value._routing.required !== true || !record(value._meta) ||
    !record(value.properties)) return false;
  if (value._meta.analysis_profile !== MEMORY_OPENSEARCH_ANALYSIS_PROFILE ||
    value._meta.mapping_version !== MEMORY_OPENSEARCH_MAPPING_VERSION ||
    value._meta.normalization_version !== MEMORY_OPENSEARCH_NORMALIZATION_VERSION ||
    value._meta.retrieval_pipeline_version !==
      MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION) return false;
  const expected = memoryOpenSearchIndexDefinition({ replicas: 0, shards: 1 })
    .mappings.properties;
  if (!exactKeys(value.properties, Object.keys(expected))) return false;
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    const actual = value.properties[key];
    const wanted = expected[key];
    if (!record(actual) || actual.type !== wanted.type ||
      ("store" in wanted && actual.store !== wanted.store) ||
      ("analyzer" in wanted && actual.analyzer !== wanted.analyzer) ||
      ("search_analyzer" in wanted &&
        effectiveSearchAnalyzer(actual) !== wanted.search_analyzer)) return false;
    if (key === "lexical_text") {
      if (!record(actual.fields) || !exactKeys(actual.fields, [
        "folded", "ngram", "transliterated"
      ])) return false;
      const wantedLexical = expected.lexical_text;
      for (const field of ["folded", "ngram", "transliterated"] as const) {
        const actualField = actual.fields[field];
        const wantedField = wantedLexical.fields[field];
        if (!record(actualField) || actualField.type !== wantedField.type ||
          actualField.analyzer !== wantedField.analyzer ||
          effectiveSearchAnalyzer(actualField) !==
            wantedField.search_analyzer) return false;
      }
    }
  }
  return true;
}

function exactMemorySettings(
  value: unknown,
  configuration: MemoryOpenSearchConfiguration
): boolean {
  if (!record(value) || !record(value.index) || !record(value.index.analysis) ||
    !record(value.index.analysis.analyzer) ||
    !record(value.index.analysis.char_filter) ||
    !record(value.index.analysis.filter) ||
    !record(value.index.analysis.tokenizer) ||
    Number(value.index.number_of_shards) !== configuration.shards ||
    Number(value.index.number_of_replicas) !== configuration.replicas) return false;
  const analyzers = value.index.analysis.analyzer;
  const expectedAnalyzers = memoryOpenSearchIndexDefinition(configuration)
    .settings.analysis.analyzer;
  return exactKeys(analyzers, Object.keys(expectedAnalyzers)) &&
    Object.entries(expectedAnalyzers).every(([name, expected]) => {
      const actual = analyzers[name];
      return record(actual) && actual.type === expected.type &&
        actual.tokenizer === expected.tokenizer;
    });
}

function decodeAnalyzerTokens(value: unknown): readonly string[] {
  if (!record(value) || !Array.isArray(value.tokens) || value.tokens.length > 256) {
    throw new OpenSearchTransportError("opensearch_response_invalid");
  }
  const tokens = value.tokens.map((token) => {
    if (!record(token) || typeof token.token !== "string" ||
      Array.from(token.token).length < 1 || Array.from(token.token).length > 256 ||
      !Number.isSafeInteger(token.position) || Number(token.position) < 0) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    return token.token;
  });
  return Object.freeze(tokens);
}

function encodeLongProperty(value: bigint): string {
  if (value < 1n || value > maximumSignedInt64) {
    throw new OpenSearchTransportError("opensearch_response_invalid");
  }
  return value.toString(10);
}

function jsonWithExactLong(
  value: (marker: string) => Record<string, unknown>,
  exact: bigint
): string {
  const marker = `__aiqsa_int64_${randomUUID()}__`;
  const encoded = JSON.stringify(value(marker));
  return encoded.replace(JSON.stringify(marker), encodeLongProperty(exact));
}

function documentBody(document: MemoryOpenSearchDocument): string {
  return jsonWithExactLong((projectionSequence) => ({
    analysis_profile: document.analysisProfile,
    generation_id: document.generationId,
    item_type: document.itemType,
    lexical_text: document.lexicalText,
    mapping_version: document.mappingVersion,
    normalization_version: document.normalizationVersion,
    projection_sequence: projectionSequence,
    retrieval_pipeline_version: document.retrievalPipelineVersion,
    safe_content_hash: document.safeContentHash,
    search_entry_id: document.searchEntryId,
    ...(document.sourceChatId ? { source_chat_id: document.sourceChatId } : {}),
    user_scope: document.userScope
  }), document.projectionSequence);
}

function mutationLines(
  mutation: MemoryOpenSearchMutation,
  indexName: string
): readonly string[] {
  if (!hashPattern.test(mutation.routing) || mutation.sequence < 1n ||
    mutation.sequence > maximumSignedInt64) {
    throw new OpenSearchTransportError("opensearch_response_invalid");
  }
  if (mutation.operation === "UPSERT") {
    assertMemoryOpenSearchDocument(mutation.document);
    if (mutation.document.userScope !== mutation.routing ||
      mutation.document.projectionSequence !== mutation.sequence) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    return Object.freeze([
      jsonWithExactLong((version) => ({
        index: {
          _id: memoryOpenSearchDocumentId(mutation.document.searchEntryId),
          _index: indexName,
          routing: mutation.routing,
          version,
          version_type: "external_gte"
        }
      }), mutation.sequence),
      documentBody(mutation.document)
    ]);
  }
  return Object.freeze([jsonWithExactLong((version) => ({
    delete: {
      _id: memoryOpenSearchDocumentId(mutation.searchEntryId),
      _index: indexName,
      routing: mutation.routing,
      version,
      version_type: "external_gte"
    }
  }), mutation.sequence)]);
}

function decodeSingleStoredString(fields: unknown, name: string): string {
  if (!record(fields) || !Array.isArray(fields[name]) || fields[name].length !== 1 ||
    typeof fields[name][0] !== "string" || fields[name][0].length < 1) {
    throw new OpenSearchTransportError("opensearch_response_invalid");
  }
  return fields[name][0];
}

function queryPath(path: string, parameters: Readonly<Record<string, string>>): string {
  const query = new URLSearchParams(parameters).toString();
  return `${path}?${query}`;
}

type MemoryOpenSearchSubsearch = Readonly<{
  mode: MemoryOpenSearchMode;
  variant: MemoryLexicalSearchRequest["variants"][number];
}>;

type DecodedMemoryOpenSearchHit = Readonly<{
  backendScore: number;
  itemType: MemorySearchItemType;
  matchMode: MemoryLexicalMatchMode;
  matchedTerms: ReadonlyMap<number, number>;
  safeContentHash: string;
  searchEntryId: string;
  sourceChatId: string | null;
  variantOrdinal: number;
}>;

function lexicalModesForPhase(
  phase: MemoryOpenSearchLexicalPhase
): readonly MemoryOpenSearchMode[] {
  return phase === "PRIMARY"
    ? [memoryOpenSearchModes.U, memoryOpenSearchModes.F]
    : [memoryOpenSearchModes.T, memoryOpenSearchModes.N];
}

function itemTypesForFamily(
  family: MemoryLexicalSearchRequest["itemFamily"]
): readonly MemorySearchItemType[] {
  return family === "FACT"
    ? ["FACT_VERSION"]
    : ["RECALL_CHUNK", "RECALL_ROUND", "RECALL_ROUND_SEGMENT", "TOOL_EVENT"];
}

function namedClause(input: Readonly<{
  length: number;
  mode: MemoryOpenSearchMatchCode;
  termOrdinal: number;
  variantOrdinal: number;
}>): string {
  const name = `v${input.variantOrdinal}:t${input.termOrdinal}:m${input.mode}:l${
    input.length
  }`;
  if (!memoryNamedClausePattern.test(name)) {
    throw new OpenSearchTransportError("opensearch_scope_too_large");
  }
  return name;
}

function msearchBody(input: Readonly<{
  configuration: MemoryOpenSearchConfiguration;
  phase: MemoryOpenSearchLexicalPhase;
  request: MemoryLexicalSearchRequest;
  routing: string;
  timeoutMs: number;
}>): Readonly<{ body: string; searches: readonly MemoryOpenSearchSubsearch[] }> {
  const modes = lexicalModesForPhase(input.phase);
  const searches = input.request.variants.flatMap((variant) =>
    variant.logicalTerms.length === 0
      ? []
      : modes.map((mode) => Object.freeze({ mode, variant }))
  );
  if (searches.length < 1 || searches.length > MEMORY_MSEARCH_MAX_SUBSEARCHES) {
    throw new OpenSearchTransportError("opensearch_scope_too_large");
  }
  const docValueFields = [
    "analysis_profile",
    "generation_id",
    "item_type",
    "mapping_version",
    "normalization_version",
    "retrieval_pipeline_version",
    "safe_content_hash",
    "search_entry_id",
    ...(input.request.itemFamily === "HISTORY" ? ["source_chat_id"] : []),
    "user_scope"
  ];
  const filter: Record<string, unknown>[] = [
    { term: { user_scope: input.routing } },
    { term: { generation_id: input.request.activeGenerationId } },
    { terms: { item_type: itemTypesForFamily(input.request.itemFamily) } },
    { term: { mapping_version: MEMORY_OPENSEARCH_MAPPING_VERSION } },
    { term: { normalization_version: MEMORY_OPENSEARCH_NORMALIZATION_VERSION } },
    { term: { analysis_profile: MEMORY_OPENSEARCH_ANALYSIS_PROFILE } },
    { term: {
      retrieval_pipeline_version: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION
    } }
  ];
  if (input.request.sourceChatIds) {
    filter.push({ terms: { source_chat_id: input.request.sourceChatIds } });
  }
  const queryTimeoutMs = Math.max(1, input.timeoutMs - 25);
  const lines = searches.flatMap(({ mode, variant }) => [
    JSON.stringify({
      index: input.configuration.readAlias,
      request_cache: false,
      routing: input.routing,
      search_type: "query_then_fetch"
    }),
    JSON.stringify({
      _source: false,
      docvalue_fields: docValueFields,
      query: { bool: {
        filter,
        minimum_should_match: 1,
        should: variant.logicalTerms.map((term) => ({
          match: { [mode.field]: {
            _name: namedClause({
              length: term.characterLength,
              mode: mode.code,
              termOrdinal: term.ordinal,
              variantOrdinal: variant.ordinal
            }),
            boost: mode.boost,
            ...(mode.code === "N"
              ? {
                  minimum_should_match: MEMORY_NGRAM_MINIMUM_SHOULD_MATCH,
                  operator: "or"
                }
              : { operator: "and" }),
            query: term.value
          } }
        }))
      } },
      size: input.request.candidateLimitPerVariant,
      timeout: `${queryTimeoutMs}ms`,
      track_total_hits: false
    })
  ]);
  const body = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(body, "utf8") > MEMORY_MSEARCH_MAX_REQUEST_BYTES) {
    throw new OpenSearchTransportError("opensearch_scope_too_large");
  }
  return Object.freeze({ body, searches: Object.freeze(searches) });
}

function exactNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function decodeMemorySearchHit(input: Readonly<{
  configuration: MemoryOpenSearchConfiguration;
  hit: unknown;
  request: MemoryLexicalSearchRequest;
  routing: string;
  search: MemoryOpenSearchSubsearch;
}>): DecodedMemoryOpenSearchHit {
  const { hit, request, routing, search } = input;
  if (!record(hit) || !exactKeys(hit, [
    "_id", "_index", "_routing", "_score", "fields", "matched_queries"
  ]) || hit._index !== input.configuration.physicalIndexName ||
    hit._routing !== routing ||
    typeof hit._score !== "number" || !Number.isFinite(hit._score) ||
    hit._score < 0 || !record(hit.fields) ||
    !Array.isArray(hit.matched_queries) || hit.matched_queries.length < 1 ||
    hit.matched_queries.length > search.variant.logicalTerms.length ||
    new Set(hit.matched_queries).size !== hit.matched_queries.length) {
    throw new OpenSearchTransportError("opensearch_response_invalid");
  }
  const expectedFieldNames = [
    "analysis_profile",
    "generation_id",
    "item_type",
    "mapping_version",
    "normalization_version",
    "retrieval_pipeline_version",
    "safe_content_hash",
    "search_entry_id",
    ...(request.itemFamily === "HISTORY" ? ["source_chat_id"] : []),
    "user_scope"
  ];
  if (!exactKeys(hit.fields, expectedFieldNames)) {
    throw new OpenSearchTransportError("opensearch_response_invalid");
  }
  const searchEntryId = decodeSingleStoredString(hit.fields, "search_entry_id");
  const safeContentHash = decodeSingleStoredString(hit.fields, "safe_content_hash");
  const itemType = decodeSingleStoredString(hit.fields, "item_type") as
    MemorySearchItemType;
  const sourceChatId = request.itemFamily === "HISTORY"
    ? decodeSingleStoredString(hit.fields, "source_chat_id")
    : null;
  if (hit._id !== memoryOpenSearchDocumentId(searchEntryId) ||
    !hashPattern.test(safeContentHash) ||
    decodeSingleStoredString(hit.fields, "user_scope") !== routing ||
    decodeSingleStoredString(hit.fields, "generation_id") !==
      request.activeGenerationId ||
    decodeSingleStoredString(hit.fields, "mapping_version") !==
      MEMORY_OPENSEARCH_MAPPING_VERSION ||
    decodeSingleStoredString(hit.fields, "normalization_version") !==
      MEMORY_OPENSEARCH_NORMALIZATION_VERSION ||
    decodeSingleStoredString(hit.fields, "analysis_profile") !==
      MEMORY_OPENSEARCH_ANALYSIS_PROFILE ||
    decodeSingleStoredString(hit.fields, "retrieval_pipeline_version") !==
      MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION ||
    !itemTypesForFamily(request.itemFamily).includes(itemType) ||
    request.sourceChatIds && !request.sourceChatIds.includes(sourceChatId!)) {
    throw new OpenSearchTransportError("opensearch_response_invalid");
  }
  const requestedTerms = new Map(search.variant.logicalTerms.map((term) => [
    term.ordinal,
    term
  ]));
  const matchedTerms = new Map<number, number>();
  for (const rawName of hit.matched_queries) {
    if (typeof rawName !== "string") {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    const decoded = memoryNamedClausePattern.exec(rawName);
    if (!decoded) throw new OpenSearchTransportError("opensearch_response_invalid");
    const variantOrdinal = Number(decoded[1]);
    const termOrdinal = Number(decoded[2]);
    const modeCode = decoded[3] as MemoryOpenSearchMatchCode;
    const length = Number(decoded[4]);
    const requested = requestedTerms.get(termOrdinal);
    if (variantOrdinal !== search.variant.ordinal || modeCode !== search.mode.code ||
      !requested || requested.characterLength !== length ||
      rawName !== namedClause({
        length,
        mode: modeCode,
        termOrdinal,
        variantOrdinal
      })) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    matchedTerms.set(termOrdinal, length);
  }
  return Object.freeze({
    backendScore: hit._score,
    itemType,
    matchMode: search.mode.matchMode,
    matchedTerms,
    safeContentHash,
    searchEntryId,
    sourceChatId,
    variantOrdinal: search.variant.ordinal
  });
}

function decodeMemoryMsearchResponse(input: Readonly<{
  body: unknown;
  configuration: MemoryOpenSearchConfiguration;
  request: MemoryLexicalSearchRequest;
  routing: string;
  searches: readonly MemoryOpenSearchSubsearch[];
}>): readonly MemoryLexicalRawCandidate[] {
  if (!record(input.body) || !exactKeys(input.body, ["responses", "took"]) ||
    !exactNonNegativeInteger(input.body.took) ||
    !Array.isArray(input.body.responses) ||
    input.body.responses.length !== input.searches.length) {
    throw new OpenSearchTransportError("opensearch_response_invalid");
  }
  const decodedHits: DecodedMemoryOpenSearchHit[] = [];
  for (const [index, rawResponse] of input.body.responses.entries()) {
    if (!record(rawResponse) || !exactKeys(rawResponse, [
      "_shards", "hits", "status", "timed_out", "took"
    ]) || rawResponse.status !== 200 || rawResponse.timed_out !== false ||
      !exactNonNegativeInteger(rawResponse.took) || !record(rawResponse._shards) ||
      !exactKeys(rawResponse._shards, ["failed", "skipped", "successful", "total"]) ||
      !exactNonNegativeInteger(rawResponse._shards.total) ||
      !exactNonNegativeInteger(rawResponse._shards.successful) ||
      !exactNonNegativeInteger(rawResponse._shards.skipped) ||
      rawResponse._shards.failed !== 0 || !record(rawResponse.hits) ||
      !exactKeys(rawResponse.hits, ["hits", "max_score"]) ||
      !Array.isArray(rawResponse.hits.hits) ||
      rawResponse.hits.hits.length > input.request.candidateLimitPerVariant ||
      rawResponse.hits.max_score !== null &&
        (typeof rawResponse.hits.max_score !== "number" ||
          !Number.isFinite(rawResponse.hits.max_score))) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    const ids = new Set<string>();
    for (const hit of rawResponse.hits.hits) {
      const decoded = decodeMemorySearchHit({
        configuration: input.configuration,
        hit,
        request: input.request,
        routing: input.routing,
        search: input.searches[index]!
      });
      if (ids.has(decoded.searchEntryId)) {
        throw new OpenSearchTransportError("opensearch_response_invalid");
      }
      ids.add(decoded.searchEntryId);
      decodedHits.push(decoded);
    }
  }

  type Merged = {
    backendScore: number;
    matchMode: MemoryLexicalMatchMode;
    matchedTerms: Map<number, number>;
    safeContentHash: string;
    searchEntryId: string;
    variantOrdinal: number;
  };
  const merged = new Map<string, Merged>();
  for (const hit of decodedHits) {
    const key = `${hit.searchEntryId}\0${hit.variantOrdinal}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, {
        backendScore: hit.backendScore,
        matchMode: hit.matchMode,
        matchedTerms: new Map(hit.matchedTerms),
        safeContentHash: hit.safeContentHash,
        searchEntryId: hit.searchEntryId,
        variantOrdinal: hit.variantOrdinal
      });
      continue;
    }
    if (current.safeContentHash !== hit.safeContentHash) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    current.backendScore = Math.max(current.backendScore, hit.backendScore);
    if ((memoryModeConfidence.get(hit.matchMode) ?? Number.MAX_SAFE_INTEGER) <
      (memoryModeConfidence.get(current.matchMode) ?? Number.MAX_SAFE_INTEGER)) {
      current.matchMode = hit.matchMode;
    }
    for (const [ordinal, length] of hit.matchedTerms) {
      const previous = current.matchedTerms.get(ordinal);
      if (previous !== undefined && previous !== length) {
        throw new OpenSearchTransportError("opensearch_response_invalid");
      }
      current.matchedTerms.set(ordinal, length);
    }
  }

  const candidates: MemoryLexicalRawCandidate[] = [];
  for (const variant of input.request.variants) {
    const ranked = [...merged.values()].filter((candidate) =>
      candidate.variantOrdinal === variant.ordinal).sort((left, right) => {
      const leftMaximum = Math.max(...left.matchedTerms.values());
      const rightMaximum = Math.max(...right.matchedTerms.values());
      return rightMaximum - leftMaximum ||
        right.matchedTerms.size - left.matchedTerms.size ||
        right.backendScore - left.backendScore ||
        left.searchEntryId.localeCompare(right.searchEntryId);
    }).slice(0, input.request.candidateLimitPerVariant);
    for (const [rankIndex, candidate] of ranked.entries()) {
      candidates.push(Object.freeze({
        backendScore: candidate.backendScore,
        matchedTermCount: candidate.matchedTerms.size,
        matchMode: candidate.matchMode,
        maximumMatchedTermLength: Math.max(...candidate.matchedTerms.values()),
        rankWithinVariant: rankIndex + 1,
        safeContentHash: candidate.safeContentHash,
        searchEntryId: candidate.searchEntryId,
        variantOrdinal: candidate.variantOrdinal
      }));
    }
  }
  return Object.freeze(candidates);
}

export class StrictMemoryOpenSearchClient implements MemoryOpenSearchClient {
  readonly #configuration: MemoryOpenSearchConfiguration;
  readonly #core: BoundedOpenSearchCoreTransport;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#configuration = memoryOpenSearchConfigurationFromEnv(env);
    this.#core = new BoundedOpenSearchCoreTransport({ env, namespace: "memory" });
  }

  async #assertPlugin(): Promise<void> {
    const response = await this.#core.request({
      maximumResponseBytes: HEALTH_RESPONSE_MAX_BYTES,
      method: "GET",
      path: "_cat/plugins?format=json&h=component,version",
      timeoutMs: this.#configuration.searchTimeoutMs
    });
    if (!Array.isArray(response.body) || response.body.length < 1 ||
      !response.body.some((entry) => record(entry) &&
        entry.component === "analysis-icu" &&
        typeof entry.version === "string" && entry.version.startsWith("3.8.0"))) {
      throw new OpenSearchTransportError("opensearch_index_incompatible");
    }
  }

  async #assertAnalyzerGolden(): Promise<void> {
    for (const fixture of MEMORY_OPENSEARCH_ANALYZER_GOLDEN) {
      const response = await this.#core.request({
        body: JSON.stringify({ analyzer: fixture.analyzer, text: fixture.text }),
        indexName: this.#configuration.physicalIndexName,
        maximumResponseBytes: HEALTH_RESPONSE_MAX_BYTES,
        method: "POST",
        path: `${this.#configuration.physicalIndexName}/_analyze`,
        timeoutMs: this.#configuration.searchTimeoutMs
      });
      const tokens = decodeAnalyzerTokens(response.body);
      if (tokens.length !== fixture.expectedTokens.length ||
        tokens.some((token, index) => token !== fixture.expectedTokens[index])) {
        throw new OpenSearchTransportError("opensearch_index_incompatible");
      }
    }
  }

  async #aliasBindings(alias: string): Promise<readonly Readonly<{
    indexName: string;
    write: boolean;
  }>[]> {
    const response = await this.#core.request({
      acceptedStatuses: [200, 404],
      indexName: alias,
      maximumResponseBytes: HEALTH_RESPONSE_MAX_BYTES,
      method: "GET",
      path: `_alias/${alias}`,
      timeoutMs: this.#configuration.searchTimeoutMs
    });
    if (response.status === 404) return Object.freeze([]);
    if (!record(response.body)) {
      throw new OpenSearchTransportError("opensearch_index_incompatible");
    }
    const targets = Object.entries(response.body);
    if (targets.length < 1 || targets.length > maximumAliasBindings) {
      throw new OpenSearchTransportError("opensearch_index_incompatible");
    }
    return Object.freeze(targets.map(([indexName, index]) => {
      if (!memoryPhysicalIndexPattern.test(indexName) || !record(index) ||
        !record(index.aliases) || !record(index.aliases[alias])) {
        throw new OpenSearchTransportError("opensearch_index_incompatible");
      }
      const metadata = index.aliases[alias];
      if (!exactKeys(metadata, alias === this.#configuration.writeAlias
        ? ["is_write_index"]
        : []) || (alias === this.#configuration.writeAlias &&
        metadata.is_write_index !== true)) {
        throw new OpenSearchTransportError("opensearch_index_incompatible");
      }
      return Object.freeze({
        indexName,
        write: metadata.is_write_index === true
      });
    }));
  }

  #aliasesAreActive(
    read: readonly Readonly<{ indexName: string; write: boolean }>[],
    write: readonly Readonly<{ indexName: string; write: boolean }>[]
  ): boolean {
    return read.length === 1 && write.length === 1 &&
      read[0]!.indexName === this.#configuration.physicalIndexName &&
      write[0]!.indexName === this.#configuration.physicalIndexName &&
      !read[0]!.write && write[0]!.write;
  }

  async #switchAliases(
    read: readonly Readonly<{ indexName: string }>[],
    write: readonly Readonly<{ indexName: string }>[]
  ): Promise<void> {
    const actions: Record<string, unknown>[] = [
      ...read.map(({ indexName }) => ({
        remove: { alias: this.#configuration.readAlias, index: indexName }
      })),
      ...write.map(({ indexName }) => ({
        remove: { alias: this.#configuration.writeAlias, index: indexName }
      })),
      { add: {
        alias: this.#configuration.readAlias,
        index: this.#configuration.physicalIndexName
      } },
      { add: {
        alias: this.#configuration.writeAlias,
        index: this.#configuration.physicalIndexName,
        is_write_index: true
      } }
    ];
    const switched = await this.#core.request({
      body: JSON.stringify({ actions }),
      maximumResponseBytes: HEALTH_RESPONSE_MAX_BYTES,
      method: "POST",
      path: "_aliases",
      timeoutMs: this.#configuration.bulkTimeoutMs
    });
    if (!record(switched.body) || switched.body.acknowledged !== true) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
  }

  async #ensureAliases(): Promise<void> {
    const [read, write] = await Promise.all([
      this.#aliasBindings(this.#configuration.readAlias),
      this.#aliasBindings(this.#configuration.writeAlias)
    ]);
    if (read.length === 0 && write.length === 0) {
      await this.#switchAliases(read, write);
      return;
    }
    if (!this.#aliasesAreActive(read, write)) {
      throw new OpenSearchTransportError("opensearch_index_incompatible");
    }
  }

  async #ensurePhysicalIndex(createWhenMissing: boolean): Promise<void> {
    const head = await this.#core.request({
      acceptedStatuses: [200, 404],
      indexName: this.#configuration.physicalIndexName,
      maximumResponseBytes: 0,
      method: "HEAD",
      path: this.#configuration.physicalIndexName,
      timeoutMs: this.#configuration.searchTimeoutMs
    });
    if (head.status === 404) {
      if (!createWhenMissing) {
        throw new OpenSearchTransportError("opensearch_index_missing");
      }
      const created = await this.#core.request({
        body: JSON.stringify(memoryOpenSearchIndexDefinition(this.#configuration)),
        indexName: this.#configuration.physicalIndexName,
        maximumResponseBytes: HEALTH_RESPONSE_MAX_BYTES,
        method: "PUT",
        path: this.#configuration.physicalIndexName,
        timeoutMs: this.#configuration.bulkTimeoutMs
      });
      if (!record(created.body) || created.body.acknowledged !== true) {
        throw new OpenSearchTransportError("opensearch_response_invalid");
      }
    }
    const definition = await this.#core.request({
      indexName: this.#configuration.physicalIndexName,
      maximumResponseBytes: this.#configuration.responseMaxBytes,
      method: "GET",
      path: this.#configuration.physicalIndexName,
      timeoutMs: this.#configuration.searchTimeoutMs
    });
    const current = record(definition.body)
      ? definition.body[this.#configuration.physicalIndexName]
      : null;
    if (!record(current) || !exactMemoryMapping(current.mappings) ||
      !exactMemorySettings(current.settings, this.#configuration)) {
      throw new OpenSearchTransportError("opensearch_index_incompatible");
    }
    await this.#assertAnalyzerGolden();
  }

  async ensureIndex(): Promise<void> {
    await this.#core.ensureServerVersion(AIQSA_OPENSEARCH_VERSION);
    await this.#assertPlugin();
    await this.#ensurePhysicalIndex(true);
    await this.#ensureAliases();
  }

  async prepareReplacementIndex(): Promise<void> {
    await this.#core.ensureServerVersion(AIQSA_OPENSEARCH_VERSION);
    await this.#assertPlugin();
    const [read, write] = await Promise.all([
      this.#aliasBindings(this.#configuration.readAlias),
      this.#aliasBindings(this.#configuration.writeAlias)
    ]);
    if ([...read, ...write].some(({ indexName }) =>
      indexName === this.#configuration.physicalIndexName)) {
      throw new OpenSearchTransportError(
        "opensearch_rebuild_requires_fresh_index"
      );
    }
    const removed = await this.#core.request({
      acceptedStatuses: [200, 404],
      indexName: this.#configuration.physicalIndexName,
      maximumResponseBytes: HEALTH_RESPONSE_MAX_BYTES,
      method: "DELETE",
      path: this.#configuration.physicalIndexName,
      timeoutMs: this.#configuration.bulkTimeoutMs
    });
    if (removed.status !== 404 && (!record(removed.body) ||
      removed.body.acknowledged !== true)) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    await this.#ensurePhysicalIndex(true);
  }

  async activateReplacementIndex(): Promise<void> {
    await this.#core.ensureServerVersion(AIQSA_OPENSEARCH_VERSION);
    await this.#assertPlugin();
    await this.#ensurePhysicalIndex(false);
    const bindings = await Promise.all([
      this.#aliasBindings(this.#configuration.readAlias),
      this.#aliasBindings(this.#configuration.writeAlias)
    ]);
    if (!this.#aliasesAreActive(bindings[0], bindings[1])) {
      await this.#switchAliases(bindings[0], bindings[1]);
    }
    const verified = await Promise.all([
      this.#aliasBindings(this.#configuration.readAlias),
      this.#aliasBindings(this.#configuration.writeAlias)
    ]);
    if (!this.#aliasesAreActive(verified[0], verified[1])) {
      throw new OpenSearchTransportError("opensearch_index_incompatible");
    }
  }

  async applyMutations(
    mutations: readonly MemoryOpenSearchMutation[],
    refresh: "NONE" | "WAIT_FOR"
  ): Promise<MemoryOpenSearchBulkResult> {
    if (mutations.length < 1 ||
      mutations.length > this.#configuration.bulkMaxDocuments) {
      throw new OpenSearchTransportError("opensearch_scope_too_large");
    }
    const documentIds = mutations.map((mutation) => memoryOpenSearchDocumentId(
      mutation.operation === "UPSERT"
        ? mutation.document.searchEntryId
        : mutation.searchEntryId
    ));
    if (new Set(documentIds).size !== documentIds.length) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    const lines = mutations.flatMap((mutation) =>
      mutationLines(mutation, this.#configuration.physicalIndexName));
    const body = `${lines.join("\n")}\n`;
    if (Buffer.byteLength(body, "utf8") > this.#configuration.bulkMaxBytes) {
      throw new OpenSearchTransportError("opensearch_response_too_large");
    }
    const opaqueId = `aiqsa-memory-project-${randomUUID()}`;
    const response = await this.#core.request({
      body,
      indexName: this.#configuration.physicalIndexName,
      maximumResponseBytes: this.#configuration.responseMaxBytes,
      method: "POST",
      opaqueId,
      path: queryPath(`${this.#configuration.physicalIndexName}/_bulk`, {
        refresh: refresh === "WAIT_FOR" ? "wait_for" : "false"
      }),
      timeoutMs: this.#configuration.bulkTimeoutMs
    });
    if (!record(response.body) || typeof response.body.errors !== "boolean" ||
      !Array.isArray(response.body.items) ||
      response.body.items.length !== mutations.length) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    let applied = 0;
    let superseded = 0;
    for (const [index, item] of response.body.items.entries()) {
      const operation = mutations[index]!.operation === "UPSERT" ? "index" : "delete";
      if (!record(item) || !exactKeys(item, [operation]) || !record(item[operation]) ||
        item[operation]._id !== documentIds[index] ||
        typeof item[operation].status !== "number") {
        throw new OpenSearchTransportError("opensearch_response_invalid");
      }
      const status = Number(item[operation].status);
      const notFoundDelete = operation === "delete" && status === 404 &&
        item[operation].result === "not_found";
      const versionSuperseded = status === 409 && record(item[operation].error) &&
        item[operation].error.type === "version_conflict_engine_exception";
      if (versionSuperseded) {
        superseded += 1;
      } else if (status >= 200 && status < 300 || notFoundDelete) {
        applied += 1;
      } else {
        throw new OpenSearchTransportError("opensearch_bulk_item_failed");
      }
    }
    return Object.freeze({
      applied,
      opaqueId: response.opaqueId ?? opaqueId,
      superseded
    });
  }

  async refreshIndex(): Promise<void> {
    await this.#core.request({
      indexName: this.#configuration.physicalIndexName,
      maximumResponseBytes: HEALTH_RESPONSE_MAX_BYTES,
      method: "POST",
      path: `${this.#configuration.physicalIndexName}/_refresh`,
      timeoutMs: this.#configuration.bulkTimeoutMs
    });
  }

  async searchLexical(input: Readonly<{
    phase: MemoryOpenSearchLexicalPhase;
    request: MemoryLexicalSearchRequest;
    signal?: AbortSignal;
  }>): Promise<MemoryOpenSearchLexicalSearchResult> {
    assertMemoryLexicalSearchRequest(input.request);
    const remainingMs = Math.min(
      this.#configuration.searchTimeoutMs,
      input.request.deadlineAtMs - Date.now()
    );
    if (!Number.isSafeInteger(remainingMs) || remainingMs < 1) {
      throw new OpenSearchTransportError("opensearch_timeout", true);
    }
    const startedAt = Date.now();
    const routing = memoryOpenSearchUserScope(
      input.request.userId,
      this.#configuration
    );
    const encoded = msearchBody({
      configuration: this.#configuration,
      phase: input.phase,
      request: input.request,
      routing,
      timeoutMs: remainingMs
    });
    const opaqueId = `aiqsa-memory-search-${randomUUID()}`;
    const response = await this.#core.request({
      body: encoded.body,
      contentType: "application/x-ndjson",
      indexName: this.#configuration.readAlias,
      maximumResponseBytes: this.#configuration.responseMaxBytes,
      method: "POST",
      opaqueId,
      path: "_msearch",
      signal: input.signal,
      timeoutMs: remainingMs
    });
    if (response.opaqueId !== opaqueId) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    const candidates = decodeMemoryMsearchResponse({
      body: response.body,
      configuration: this.#configuration,
      request: input.request,
      routing,
      searches: encoded.searches
    });
    return Object.freeze({
      candidates,
      durationMs: Math.min(60_000, Math.max(0, Date.now() - startedAt)),
      opaqueId
    });
  }

  async inspectGeneration(input: Readonly<{
    generationId: string;
    routing: string;
    userScope: string;
  }>): Promise<MemoryOpenSearchGenerationInventory> {
    if (!hashPattern.test(input.routing) || input.userScope !== input.routing ||
      input.generationId.length < 1 || input.generationId.length > 512) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    const digest = createHash("sha256");
    let after: string | null = null;
    let documentCount = 0;
    let expectedTotal: number | null = null;
    while (true) {
      const response = await this.#core.request({
        body: JSON.stringify({
          _source: false,
          ...(after ? { search_after: [after] } : {}),
          query: { bool: { filter: [
            { term: { user_scope: input.userScope } },
            { term: { generation_id: input.generationId } },
            { term: { mapping_version: MEMORY_OPENSEARCH_MAPPING_VERSION } },
            { term: { normalization_version: MEMORY_OPENSEARCH_NORMALIZATION_VERSION } },
            { term: { analysis_profile: MEMORY_OPENSEARCH_ANALYSIS_PROFILE } },
            { term: {
              retrieval_pipeline_version:
                MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION
            } }
          ] } },
          size: MEMORY_OPENSEARCH_INTEGRITY_PAGE_SIZE,
          sort: [{ search_entry_id: "asc" }],
          stored_fields: ["safe_content_hash", "search_entry_id"],
          track_total_hits: true
        }),
        indexName: this.#configuration.physicalIndexName,
        maximumResponseBytes: this.#configuration.responseMaxBytes,
        method: "POST",
        path: queryPath(`${this.#configuration.physicalIndexName}/_search`, {
          routing: input.routing
        }),
        timeoutMs: this.#configuration.searchTimeoutMs
      });
      if (!record(response.body) || !record(response.body._shards) ||
        response.body._shards.failed !== 0 || !record(response.body.hits) ||
        !record(response.body.hits.total) || response.body.hits.total.relation !== "eq" ||
        !Number.isSafeInteger(response.body.hits.total.value) ||
        !Array.isArray(response.body.hits.hits) ||
        response.body.hits.hits.length > MEMORY_OPENSEARCH_INTEGRITY_PAGE_SIZE) {
        throw new OpenSearchTransportError("opensearch_response_invalid");
      }
      const total = Number(response.body.hits.total.value);
      if (expectedTotal === null) expectedTotal = total;
      if (expectedTotal !== total || total > MEMORY_OPENSEARCH_MAX_INTEGRITY_DOCUMENTS) {
        throw new OpenSearchTransportError("opensearch_scope_too_large");
      }
      let last: string | null = null;
      for (const hit of response.body.hits.hits) {
        if (!record(hit) || hit._source !== undefined || !Array.isArray(hit.sort) ||
          hit.sort.length !== 1 || typeof hit.sort[0] !== "string") {
          throw new OpenSearchTransportError("opensearch_response_invalid");
        }
        const searchEntryId = decodeSingleStoredString(hit.fields, "search_entry_id");
        const safeContentHash = decodeSingleStoredString(hit.fields, "safe_content_hash");
        if (hit.sort[0] !== searchEntryId || !hashPattern.test(safeContentHash) ||
          (last !== null && searchEntryId <= last)) {
          throw new OpenSearchTransportError("opensearch_response_invalid");
        }
        digest.update(memoryOpenSearchIntegrityFingerprintMaterial({
          safeContentHash,
          searchEntryId
        }), "utf8");
        last = searchEntryId;
        documentCount += 1;
      }
      if (response.body.hits.hits.length < MEMORY_OPENSEARCH_INTEGRITY_PAGE_SIZE) break;
      if (!last || last === after) {
        throw new OpenSearchTransportError("opensearch_response_invalid");
      }
      after = last;
    }
    if (documentCount !== (expectedTotal ?? 0)) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    return Object.freeze({
      documentCount,
      fingerprint: digest.digest("hex")
    });
  }

  async #purge(filters: readonly Record<string, unknown>[], routing: string): Promise<void> {
    if (!hashPattern.test(routing)) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    const response = await this.#core.request({
      body: JSON.stringify({ query: { bool: { filter: filters } } }),
      indexName: this.#configuration.physicalIndexName,
      maximumResponseBytes: this.#configuration.responseMaxBytes,
      method: "POST",
      path: queryPath(`${this.#configuration.physicalIndexName}/_delete_by_query`, {
        refresh: "true",
        routing
      }),
      timeoutMs: this.#configuration.bulkTimeoutMs
    });
    if (!record(response.body) || response.body.timed_out !== false ||
      response.body.version_conflicts !== 0 || !Array.isArray(response.body.failures) ||
      response.body.failures.length !== 0) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
  }

  async purgeGeneration(input: Readonly<{
    generationId: string;
    routing: string;
    userScope: string;
  }>): Promise<void> {
    if (input.routing !== input.userScope || input.generationId.length < 1 ||
      input.generationId.length > 512) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    await this.#purge([
      { term: { user_scope: input.userScope } },
      { term: { generation_id: input.generationId } }
    ], input.routing);
    const inventory = await this.inspectGeneration(input);
    if (inventory.documentCount !== 0) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
  }

  async purgeUser(input: Readonly<{
    routing: string;
    userScope: string;
  }>): Promise<void> {
    if (input.routing !== input.userScope) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    await this.#purge([{ term: { user_scope: input.userScope } }], input.routing);
    const response = await this.#core.request({
      body: JSON.stringify({ query: { term: { user_scope: input.userScope } } }),
      indexName: this.#configuration.physicalIndexName,
      maximumResponseBytes: HEALTH_RESPONSE_MAX_BYTES,
      method: "POST",
      path: queryPath(`${this.#configuration.physicalIndexName}/_count`, {
        routing: input.routing
      }),
      timeoutMs: this.#configuration.searchTimeoutMs
    });
    if (!record(response.body) || !record(response.body._shards) ||
      response.body._shards.failed !== 0 || response.body.count !== 0) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
  }
}

export function createMemoryOpenSearchClient(
  env: NodeJS.ProcessEnv = process.env
): MemoryOpenSearchClient {
  return new StrictMemoryOpenSearchClient(env);
}

export { MEMORY_OPENSEARCH_BACKEND_KIND };
