import { createHash } from "node:crypto";
import type { KnowledgeOperationKind } from "./knowledgeBudget";
import type {
  KnowledgePlannerLane,
  KnowledgePlannerStrategy
} from "./planner";
import {
  normalizeReadSourceRequest,
  type NormalizedReadSourceRequest
} from "./readSourceLocator";
import { KNOWLEDGE_QUERY_MAX_CHARACTERS } from "./retrievalTypes";
import type { StructuredPlan } from "./structuredData";
import type { KnowledgeVisualRegionKind } from "./visualEvidence";

export const KNOWLEDGE_OPERATION_REQUEST_VERSION = 2 as const;
export const KNOWLEDGE_OPERATION_REQUEST_MAX_SOURCES = 1_024;
export const KNOWLEDGE_OPERATION_REQUEST_MAX_EXACT_TERMS = 24;

const MAX_EXACT_VALUE_CHARACTERS = 500;
const MAX_EXACT_TERM_CHARACTERS = 200;
const MAX_TARGET_NAME_CHARACTERS = 160;
const MAX_TARGET_NAMES = 8;
const MAX_HEADING_PART_CHARACTERS = 256;
const MAX_HEADING_PARTS = 16;
const MAX_CURSOR_CHARACTERS = 512;
const MAX_PAGE = 999_999;
const MAX_RESULT_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_ALIAS = /^[BS][1-9]\d{0,2}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/u;
const CURSOR = /^[A-Za-z0-9][A-Za-z0-9._~:/+-]{0,511}$/u;
const DISALLOWED_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

const laneOrder: readonly KnowledgePlannerLane[] = [
  "exact",
  "lexical",
  "metadata",
  "semantic"
];
const laneSet = new Set<KnowledgePlannerLane>(laneOrder);
const strategySet = new Set<KnowledgePlannerStrategy>([
  "focused",
  "full_context",
  "comparison",
  "exhaustive",
  "multi_pass",
  "corpus_summary",
  "structured_data"
]);
const discoveryFieldOrder = [
  "filename",
  "heading",
  "source_name",
  "tag",
  "title"
] as const;
const discoveryFieldSet = new Set<string>(discoveryFieldOrder);
const exactFieldSet = new Set<KnowledgeExactField>([
  "any",
  "body",
  "filename",
  "heading",
  "tag",
  "title"
]);
const visualKindSet = new Set<KnowledgeVisualRegionKind>([
  "chart",
  "diagram",
  "image",
  "table"
]);

export type KnowledgeOperationExactMatchKind = "pattern" | "phrase" | "token";
export type KnowledgeOperationPurpose =
  | "answer"
  | "compare_target"
  | "coverage"
  | "follow_up"
  | "source_discovery"
  | "summary";
export type KnowledgeOperationCoverageMode = "partial" | "verified_only";
export type KnowledgeExactCaseMode = "insensitive" | "sensitive";
export type KnowledgeExactField =
  | "any"
  | "body"
  | "filename"
  | "heading"
  | "tag"
  | "title";
export type KnowledgeDiscoveryField = typeof discoveryFieldOrder[number];

export type KnowledgeOperationRequestEnvelopeV2 = Readonly<{
  idempotencyKey: string;
  operation: KnowledgeOperationKind;
  originalQuery: Readonly<{
    reference: string;
    sha256: string;
  }>;
  phaseOrdinal: number;
  plannerVersion: number;
  profileRevisionId: string;
  profileRevisionNumber: number;
  purpose: KnowledgeOperationPurpose;
  reservationId: string;
  resolvedSourceIds: readonly string[];
  sourceAliases: readonly string[];
  subqueryOrdinal: number;
  version: typeof KNOWLEDGE_OPERATION_REQUEST_VERSION;
}>;

export type KnowledgeOperationPlanProjectionV2 = Readonly<{
  allowedLanes: readonly KnowledgePlannerLane[];
  coverage: Readonly<{
    expectedPassageCount: number | null;
    mode: KnowledgeOperationCoverageMode;
  }>;
  exactTerms: readonly string[];
  rewrittenQuery: string;
  strategy: Exclude<KnowledgePlannerStrategy, "none">;
  targetNames: readonly string[];
  targetSourceIds: readonly string[];
}>;

export type KnowledgeSearchOperationRequestV2 = KnowledgeOperationRequestEnvelopeV2 & Readonly<{
  operation: "automatic_search" | "search_knowledge";
  search: KnowledgeOperationPlanProjectionV2;
}>;

export type KnowledgeFindExactOperationRequestV2 = KnowledgeOperationRequestEnvelopeV2 & Readonly<{
  exact: Readonly<{
    caseMode: KnowledgeExactCaseMode;
    cursor: string | null;
    field: KnowledgeExactField;
    limit: number;
    match: KnowledgeOperationExactMatchKind;
    value: string;
  }>;
  operation: "find_exact";
  plan: KnowledgeOperationPlanProjectionV2;
}>;

export type KnowledgeReadSourceOperationRequestV2 = KnowledgeOperationRequestEnvelopeV2 & Readonly<{
  operation: "read_source";
  read: NormalizedReadSourceRequest;
}>;

export type KnowledgeDiscoverSourcesOperationRequestV2 =
  KnowledgeOperationRequestEnvelopeV2 & Readonly<{
    discovery: Readonly<{
      cursor: string | null;
      fields: readonly KnowledgeDiscoveryField[];
      limit: number;
      query: string;
    }>;
    operation: "discover_sources";
    plan: KnowledgeOperationPlanProjectionV2;
  }>;

export type KnowledgeStructuredAnalysisOperationRequestV2 =
  KnowledgeOperationRequestEnvelopeV2 & Readonly<{
    operation: "structured_analysis";
    plan: KnowledgeOperationPlanProjectionV2;
    structured: Readonly<{
      query: string;
      selector: Readonly<{
        columns: readonly string[];
        includeHidden: boolean;
        operation: StructuredPlan["operation"] | null;
        range: string | null;
        sheet: string | null;
      }>;
      targetSourceIds: readonly string[];
    }>;
  }>;

export type KnowledgeVisualAnalysisOperationRequestV2 =
  KnowledgeOperationRequestEnvelopeV2 & Readonly<{
    operation: "visual_analysis";
    plan: KnowledgeOperationPlanProjectionV2;
    visual: Readonly<{
      query: string;
      selector: Readonly<{
        assetId: string | null;
        blockId: string | null;
        headingPath: readonly string[];
        kind: KnowledgeVisualRegionKind | null;
        page: number | null;
      }> | null;
      targetSourceIds: readonly string[];
    }>;
  }>;

export type KnowledgeOperationRequestV2 =
  | KnowledgeDiscoverSourcesOperationRequestV2
  | KnowledgeFindExactOperationRequestV2
  | KnowledgeReadSourceOperationRequestV2
  | KnowledgeSearchOperationRequestV2
  | KnowledgeStructuredAnalysisOperationRequestV2
  | KnowledgeVisualAnalysisOperationRequestV2;

export type KnowledgeOperationTargetingV2 =
  | Readonly<{
      operation: "automatic_search" | "search_knowledge";
      search: Pick<KnowledgeSearchOperationRequestV2["search"], "targetSourceIds">;
    }>
  | Readonly<{ operation: "discover_sources" }>
  | Readonly<{
      operation: "find_exact";
      plan: Pick<KnowledgeOperationPlanProjectionV2, "targetSourceIds">;
    }>
  | Readonly<{
      operation: "read_source";
      resolvedSourceIds: readonly string[];
    }>
  | Readonly<{
      operation: "structured_analysis";
      structured: Pick<
        KnowledgeStructuredAnalysisOperationRequestV2["structured"],
        "targetSourceIds"
      >;
    }>
  | Readonly<{
      operation: "visual_analysis";
      visual: Pick<KnowledgeVisualAnalysisOperationRequestV2["visual"], "targetSourceIds">;
    }>;

const envelopeKeys = [
  "idempotencyKey",
  "operation",
  "originalQuery",
  "phaseOrdinal",
  "plannerVersion",
  "profileRevisionId",
  "profileRevisionNumber",
  "purpose",
  "reservationId",
  "resolvedSourceIds",
  "sourceAliases",
  "subqueryOrdinal",
  "version"
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function canonicalText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || DISALLOWED_TEXT.test(value)) return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized.length > 0 && normalized.length <= maximum && value === normalized
    ? normalized
    : null;
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function cursor(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.length <= MAX_CURSOR_CHARACTERS && CURSOR.test(value)
    ? value
    : undefined;
}

function uniqueCanonicalStrings(
  value: unknown,
  maximumItems: number,
  decode: (entry: unknown) => string | null,
  compare?: (left: string, right: string) => number
): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) return null;
  const decoded = value.map(decode);
  if (decoded.some((entry) => entry === null)) return null;
  const strings = decoded as string[];
  if (new Set(strings).size !== strings.length) return null;
  return Object.freeze([...strings].sort(compare));
}

function orderedCanonicalStrings(
  value: unknown,
  maximumItems: number,
  decode: (entry: unknown) => string | null
): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) return null;
  const decoded = value.map(decode);
  return decoded.some((entry) => entry === null)
    ? null
    : Object.freeze(decoded as string[]);
}

function sourceAliasOrder(left: string, right: string): number {
  const kind = left.charCodeAt(0) - right.charCodeAt(0);
  return kind || Number(left.slice(1)) - Number(right.slice(1));
}

function decodeOriginalQuery(value: unknown): KnowledgeOperationRequestV2["originalQuery"] | null {
  if (!record(value) || !exactKeys(value, ["reference", "sha256"])) return null;
  const reference = uuid(value.reference);
  if (!reference || typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) return null;
  return Object.freeze({ reference, sha256: value.sha256 });
}

function decodeCoverage(value: unknown): KnowledgeOperationPlanProjectionV2["coverage"] | null {
  if (!record(value) || !exactKeys(value, ["expectedPassageCount", "mode"]) ||
    value.mode !== "partial" && value.mode !== "verified_only" ||
    value.expectedPassageCount !== null &&
      !integer(value.expectedPassageCount, 1, 10_000_000)) return null;
  return Object.freeze({
    expectedPassageCount: value.expectedPassageCount === null
      ? null
      : Number(value.expectedPassageCount),
    mode: value.mode
  });
}

function decodeLanes(
  value: unknown,
  allowEmpty: boolean
): readonly KnowledgePlannerLane[] | null {
  if (!Array.isArray(value) || value.length < (allowEmpty ? 0 : 1) ||
    value.length > laneOrder.length ||
    value.some((entry) => typeof entry !== "string" ||
      !laneSet.has(entry as KnowledgePlannerLane)) ||
    new Set(value).size !== value.length) return null;
  const selected = new Set(value as KnowledgePlannerLane[]);
  return Object.freeze(laneOrder.filter((lane) => selected.has(lane)));
}

function decodeSourceIds(value: unknown): readonly string[] | null {
  return uniqueCanonicalStrings(
    value,
    KNOWLEDGE_OPERATION_REQUEST_MAX_SOURCES,
    uuid
  );
}

function targetIdsWithinScope(
  targetSourceIds: readonly string[],
  resolvedSourceIds: readonly string[]
): boolean {
  const resolved = new Set(resolvedSourceIds);
  return targetSourceIds.every((sourceId) => resolved.has(sourceId));
}

function decodePlan(
  value: unknown,
  operation: Exclude<KnowledgeOperationKind, "read_source">,
  purpose: KnowledgeOperationPurpose,
  resolvedSourceIds: readonly string[]
): KnowledgeOperationPlanProjectionV2 | null {
  if (!record(value) || !exactKeys(value, [
    "allowedLanes",
    "coverage",
    "exactTerms",
    "rewrittenQuery",
    "strategy",
    "targetNames",
    "targetSourceIds"
  ]) || typeof value.strategy !== "string" ||
    !strategySet.has(value.strategy as KnowledgePlannerStrategy)) return null;
  const allowEmptyLanes = operation === "structured_analysis" || operation === "visual_analysis";
  const allowedLanes = decodeLanes(value.allowedLanes, allowEmptyLanes);
  const coverage = decodeCoverage(value.coverage);
  const exactTerms = uniqueCanonicalStrings(
    value.exactTerms,
    KNOWLEDGE_OPERATION_REQUEST_MAX_EXACT_TERMS,
    (entry) => canonicalText(entry, MAX_EXACT_TERM_CHARACTERS)
  );
  const rewrittenQuery = canonicalText(value.rewrittenQuery, KNOWLEDGE_QUERY_MAX_CHARACTERS);
  const targetNames = uniqueCanonicalStrings(
    value.targetNames,
    MAX_TARGET_NAMES,
    (entry) => canonicalText(entry, MAX_TARGET_NAME_CHARACTERS)
  );
  const targetSourceIds = decodeSourceIds(value.targetSourceIds);
  if (!allowedLanes || !coverage || !exactTerms || !rewrittenQuery || !targetNames ||
    !targetSourceIds || !targetIdsWithinScope(targetSourceIds, resolvedSourceIds) ||
    exactTerms.length > 0 && !allowedLanes.includes("exact") ||
    purpose === "compare_target" &&
      (targetNames.length === 0 || targetSourceIds.length === 0)) return null;
  const validOperationPlan = operation === "automatic_search" || operation === "search_knowledge"
    ? purpose !== "source_discovery" && allowedLanes.length > 0
    : operation === "find_exact"
      ? purpose !== "source_discovery" && allowedLanes.length === 1 &&
        allowedLanes[0] === "exact" && exactTerms.length > 0
      : operation === "discover_sources"
        ? purpose === "source_discovery" && allowedLanes.length === 1 &&
          allowedLanes[0] === "metadata" && exactTerms.length === 0 &&
          targetSourceIds.length === 0
        : purpose !== "source_discovery" && allowedLanes.length === 0 &&
          targetNames.length > 0 && targetSourceIds.length > 0;
  if (!validOperationPlan) return null;
  return Object.freeze({
    allowedLanes,
    coverage,
    exactTerms,
    rewrittenQuery,
    strategy: value.strategy as Exclude<KnowledgePlannerStrategy, "none">,
    targetNames,
    targetSourceIds
  });
}

function decodeExact(value: unknown): KnowledgeFindExactOperationRequestV2["exact"] | null {
  if (!record(value) || !exactKeys(value, [
    "caseMode",
    "cursor",
    "field",
    "limit",
    "match",
    "value"
  ]) || value.caseMode !== "insensitive" && value.caseMode !== "sensitive" ||
    typeof value.field !== "string" || !exactFieldSet.has(value.field as KnowledgeExactField) ||
    value.match !== "pattern" && value.match !== "phrase" && value.match !== "token" ||
    !integer(value.limit, 1, MAX_RESULT_LIMIT)) return null;
  const exactCursor = cursor(value.cursor);
  const exactValue = canonicalText(value.value, MAX_EXACT_VALUE_CHARACTERS);
  if (exactCursor === undefined || !exactValue) return null;
  return Object.freeze({
    caseMode: value.caseMode,
    cursor: exactCursor,
    field: value.field as KnowledgeExactField,
    limit: Number(value.limit),
    match: value.match,
    value: exactValue
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function exactPlanMatches(
  exact: KnowledgeFindExactOperationRequestV2["exact"],
  plan: KnowledgeOperationPlanProjectionV2
): boolean {
  if (!plan.rewrittenQuery.includes(exact.value)) return false;
  if (plan.exactTerms.includes(exact.value)) return true;
  if (exact.match === "token") return false;
  if (exact.match === "phrase") {
    return plan.exactTerms.some((term) =>
      /^(?:"[^"]+"|'[^']+'|`[^`]+`|“[^”]+”|«[^»]+»)$/u.test(term) &&
      term.slice(1, -1) === exact.value);
  }
  return plan.exactTerms.some((term) =>
    term.match(/^\/([^/\r\n]{1,200})\/[gimsuy]*$/u)?.[1] === exact.value);
}

function decodeRead(value: unknown): NormalizedReadSourceRequest | null {
  if (!record(value) || !exactKeys(value, [
    "contractVersion",
    "direction",
    "embedding",
    "locator",
    "resolution",
    "target",
    "window"
  ])) return null;
  const normalized = normalizeReadSourceRequest({
    direction: value.direction,
    locator: value.locator,
    window: value.window
  });
  if (!normalized || value.contractVersion !== normalized.contractVersion ||
    value.embedding !== "forbidden" || value.resolution !== "exact" ||
    JSON.stringify(canonicalJsonValue(value.target)) !==
      JSON.stringify(canonicalJsonValue(normalized.target))) return null;
  return normalized;
}

function decodeDiscovery(
  value: unknown
): KnowledgeDiscoverSourcesOperationRequestV2["discovery"] | null {
  if (!record(value) || !exactKeys(value, ["cursor", "fields", "limit", "query"]) ||
    !integer(value.limit, 1, MAX_RESULT_LIMIT)) return null;
  const discoveryCursor = cursor(value.cursor);
  const fields = uniqueCanonicalStrings(
    value.fields,
    discoveryFieldOrder.length,
    (entry) => typeof entry === "string" && discoveryFieldSet.has(entry) ? entry : null,
    (left, right) => discoveryFieldOrder.indexOf(left as KnowledgeDiscoveryField) -
      discoveryFieldOrder.indexOf(right as KnowledgeDiscoveryField)
  ) as readonly KnowledgeDiscoveryField[] | null;
  const query = canonicalText(value.query, MAX_EXACT_VALUE_CHARACTERS);
  if (discoveryCursor === undefined || !fields || fields.length === 0 || !query) return null;
  return Object.freeze({
    cursor: discoveryCursor,
    fields,
    limit: Number(value.limit),
    query
  });
}

function decodeStructured(
  value: unknown,
  resolvedSourceIds: readonly string[]
): KnowledgeStructuredAnalysisOperationRequestV2["structured"] | null {
  if (!record(value) || !exactKeys(value, ["query", "selector", "targetSourceIds"]) ||
    !record(value.selector) || !exactKeys(value.selector, [
      "columns",
      "includeHidden",
      "operation",
      "range",
      "sheet"
    ]) || typeof value.selector.includeHidden !== "boolean" ||
    value.selector.operation !== null && ![
      "aggregate",
      "arithmetic",
      "formula_audit",
      "join",
      "list_rows",
      "outliers",
      "trend"
    ].includes(String(value.selector.operation)) ||
    value.selector.range !== null && !canonicalText(value.selector.range, 256) ||
    value.selector.sheet !== null && !canonicalText(value.selector.sheet, 256)) return null;
  const columns = orderedCanonicalStrings(
    value.selector.columns,
    32,
    (entry) => canonicalText(entry, 256)
  );
  const query = canonicalText(value.query, KNOWLEDGE_QUERY_MAX_CHARACTERS);
  const targetSourceIds = decodeSourceIds(value.targetSourceIds);
  if (!columns || !query || !targetSourceIds || targetSourceIds.length === 0 ||
    !targetIdsWithinScope(targetSourceIds, resolvedSourceIds)) return null;
  return Object.freeze({
    query,
    selector: Object.freeze({
      columns,
      includeHidden: value.selector.includeHidden,
      operation: value.selector.operation as StructuredPlan["operation"] | null,
      range: value.selector.range as string | null,
      sheet: value.selector.sheet as string | null
    }),
    targetSourceIds
  });
}

function decodeVisualSelector(
  value: unknown
): Exclude<KnowledgeVisualAnalysisOperationRequestV2["visual"]["selector"], null> | null {
  if (!record(value) || !exactKeys(value, [
    "assetId",
    "blockId",
    "headingPath",
    "kind",
    "page"
  ]) || value.assetId !== null && !canonicalText(value.assetId, 512) ||
    value.blockId !== null && !canonicalText(value.blockId, 512) ||
    value.kind !== null && (typeof value.kind !== "string" ||
      !visualKindSet.has(value.kind as KnowledgeVisualRegionKind)) ||
    value.page !== null && !integer(value.page, 1, MAX_PAGE)) return null;
  const headingPath = orderedCanonicalStrings(
    value.headingPath,
    MAX_HEADING_PARTS,
    (entry) => canonicalText(entry, MAX_HEADING_PART_CHARACTERS)
  );
  if (!headingPath || value.assetId === null && value.blockId === null &&
    value.kind === null && value.page === null && headingPath.length === 0) return null;
  return Object.freeze({
    assetId: value.assetId as string | null,
    blockId: value.blockId as string | null,
    headingPath,
    kind: value.kind as KnowledgeVisualRegionKind | null,
    page: value.page === null ? null : Number(value.page)
  });
}

function decodeVisual(
  value: unknown,
  resolvedSourceIds: readonly string[]
): KnowledgeVisualAnalysisOperationRequestV2["visual"] | null {
  if (!record(value) || !exactKeys(value, ["query", "selector", "targetSourceIds"])) return null;
  const query = canonicalText(value.query, KNOWLEDGE_QUERY_MAX_CHARACTERS);
  const selector = value.selector === null ? null : decodeVisualSelector(value.selector);
  const targetSourceIds = decodeSourceIds(value.targetSourceIds);
  if (!query || value.selector !== null && !selector || !targetSourceIds ||
    targetSourceIds.length === 0 ||
    !targetIdsWithinScope(targetSourceIds, resolvedSourceIds)) return null;
  return Object.freeze({ query, selector, targetSourceIds });
}

function decodeEnvelope(value: Record<string, unknown>): KnowledgeOperationRequestEnvelopeV2 | null {
  if (value.version !== KNOWLEDGE_OPERATION_REQUEST_VERSION ||
    typeof value.operation !== "string" ||
    typeof value.purpose !== "string" ||
    !new Set<KnowledgeOperationPurpose>([
      "answer",
      "compare_target",
      "coverage",
      "follow_up",
      "source_discovery",
      "summary"
    ]).has(value.purpose as KnowledgeOperationPurpose) ||
    !integer(value.phaseOrdinal, 0, 63) ||
    !integer(value.subqueryOrdinal, 0, 127) ||
    !integer(value.profileRevisionNumber, 1, 2_147_483_647) ||
    !integer(value.plannerVersion, 1, 256) ||
    typeof value.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(value.idempotencyKey)) {
    return null;
  }
  const originalQuery = decodeOriginalQuery(value.originalQuery);
  const sourceAliases = uniqueCanonicalStrings(
    value.sourceAliases,
    KNOWLEDGE_OPERATION_REQUEST_MAX_SOURCES,
    (entry) => typeof entry === "string" && SOURCE_ALIAS.test(entry) ? entry : null,
    sourceAliasOrder
  );
  const resolvedSourceIds = decodeSourceIds(value.resolvedSourceIds);
  const reservationId = uuid(value.reservationId);
  const profileRevisionId = uuid(value.profileRevisionId);
  if (!originalQuery || !sourceAliases || !resolvedSourceIds ||
    !reservationId || !profileRevisionId) return null;
  return Object.freeze({
    idempotencyKey: value.idempotencyKey,
    operation: value.operation as KnowledgeOperationKind,
    originalQuery,
    phaseOrdinal: Number(value.phaseOrdinal),
    plannerVersion: Number(value.plannerVersion),
    profileRevisionId,
    profileRevisionNumber: Number(value.profileRevisionNumber),
    purpose: value.purpose as KnowledgeOperationPurpose,
    reservationId,
    resolvedSourceIds,
    sourceAliases,
    subqueryOrdinal: Number(value.subqueryOrdinal),
    version: KNOWLEDGE_OPERATION_REQUEST_VERSION
  });
}

/**
 * Decodes the persisted v2 operation contract. Each operation has one exact
 * key set, so a field from another variant cannot silently survive hashing or
 * recovery.
 */
export function decodeKnowledgeOperationRequestV2(
  value: unknown
): KnowledgeOperationRequestV2 | null {
  if (!record(value) || typeof value.operation !== "string") return null;
  const variantKey = ({
    automatic_search: "search",
    discover_sources: "discovery",
    find_exact: "exact",
    read_source: "read",
    search_knowledge: "search",
    structured_analysis: "structured",
    visual_analysis: "visual"
  } as const)[value.operation as KnowledgeOperationKind];
  const planKey = value.operation === "find_exact" || value.operation === "discover_sources" ||
    value.operation === "structured_analysis" || value.operation === "visual_analysis"
    ? ["plan"]
    : [];
  if (!variantKey || !exactKeys(value, [...envelopeKeys, ...planKey, variantKey])) return null;
  const envelope = decodeEnvelope(value);
  if (!envelope) return null;

  switch (value.operation) {
    case "automatic_search":
    case "search_knowledge": {
      const search = decodePlan(
        value.search,
        value.operation,
        envelope.purpose,
        envelope.resolvedSourceIds
      );
      return search && envelope.resolvedSourceIds.length > 0
        ? Object.freeze({ ...envelope, operation: value.operation, search })
        : null;
    }
    case "find_exact": {
      const exact = decodeExact(value.exact);
      const plan = decodePlan(
        value.plan,
        value.operation,
        envelope.purpose,
        envelope.resolvedSourceIds
      );
      return exact && plan && exactPlanMatches(exact, plan) &&
        envelope.purpose !== "source_discovery" &&
        envelope.resolvedSourceIds.length > 0
        ? Object.freeze({ ...envelope, exact, operation: value.operation, plan })
        : null;
    }
    case "read_source": {
      const read = decodeRead(value.read);
      return read && envelope.purpose !== "source_discovery" &&
        envelope.sourceAliases.length === 1 && /^S/u.test(envelope.sourceAliases[0]!) &&
        envelope.resolvedSourceIds.length === 1
        ? Object.freeze({ ...envelope, operation: value.operation, read })
        : null;
    }
    case "discover_sources": {
      const discovery = decodeDiscovery(value.discovery);
      const plan = decodePlan(
        value.plan,
        value.operation,
        envelope.purpose,
        envelope.resolvedSourceIds
      );
      return discovery && plan && discovery.query === plan.rewrittenQuery &&
        envelope.purpose === "source_discovery"
        ? Object.freeze({ ...envelope, discovery, operation: value.operation, plan })
        : null;
    }
    case "structured_analysis": {
      const structured = decodeStructured(value.structured, envelope.resolvedSourceIds);
      const plan = decodePlan(
        value.plan,
        value.operation,
        envelope.purpose,
        envelope.resolvedSourceIds
      );
      return structured && plan && structured.query === plan.rewrittenQuery &&
        sameStrings(structured.targetSourceIds, plan.targetSourceIds) &&
        envelope.purpose !== "source_discovery"
        ? Object.freeze({ ...envelope, operation: value.operation, plan, structured })
        : null;
    }
    case "visual_analysis": {
      const visual = decodeVisual(value.visual, envelope.resolvedSourceIds);
      const plan = decodePlan(
        value.plan,
        value.operation,
        envelope.purpose,
        envelope.resolvedSourceIds
      );
      return visual && plan && visual.query === plan.rewrittenQuery &&
        sameStrings(visual.targetSourceIds, plan.targetSourceIds) &&
        envelope.purpose !== "source_discovery"
        ? Object.freeze({ ...envelope, operation: value.operation, plan, visual })
        : null;
    }
    default:
      return null;
  }
}

export function createKnowledgeOperationRequestV2(value: unknown): KnowledgeOperationRequestV2 {
  const decoded = decodeKnowledgeOperationRequestV2(value);
  if (!decoded) throw new Error("knowledge_operation_request_v2_invalid");
  return decoded;
}

/** Returns the Source targets that narrow an already admitted operation. */
export function knowledgeOperationTargetSourceIds(
  request: KnowledgeOperationTargetingV2
): readonly string[] {
  switch (request.operation) {
    case "automatic_search":
    case "search_knowledge":
      return request.search.targetSourceIds;
    case "find_exact":
      return request.plan.targetSourceIds;
    case "read_source":
      return request.resolvedSourceIds;
    case "structured_analysis":
      return request.structured.targetSourceIds;
    case "visual_analysis":
      return request.visual.targetSourceIds;
    case "discover_sources":
      return [];
  }
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])])
  );
}

/** Returns the one canonical JSON representation used by recovery and hashing. */
export function canonicalKnowledgeOperationRequestV2(value: unknown): string {
  const decoded = createKnowledgeOperationRequestV2(value);
  return JSON.stringify(canonicalJsonValue(decoded));
}

/** SHA-256 of the complete canonical request, including reservation/idempotency identity. */
export function hashKnowledgeOperationRequestV2(value: unknown): string {
  return createHash("sha256")
    .update(canonicalKnowledgeOperationRequestV2(value), "utf8")
    .digest("hex");
}
