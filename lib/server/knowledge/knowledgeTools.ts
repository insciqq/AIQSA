import type { ModelToolCall, RunTool } from "../tools/types";
import {
  KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME,
  KNOWLEDGE_EXACT_TOOL_NAME,
  KNOWLEDGE_QUERY_MAX_CHARACTERS,
  KNOWLEDGE_READ_SOURCE_TOOL_NAME,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  KNOWLEDGE_TOOL_NAME,
  type KnowledgeExactSearchRequest,
  type KnowledgeSourceDiscoveryField,
  type KnowledgeSourceDiscoveryRequest
} from "./retrievalTypes";
import type {
  KnowledgeOperationPurpose,
  KnowledgeStructuredAnalysisOperationRequestV2,
  KnowledgeVisualAnalysisOperationRequestV2
} from "./knowledgeOperationRequest";
import type { KnowledgePlannerLane, KnowledgePlannerStrategy } from "./planner";
import { decodeKnowledgePlannerTargetResolution } from "./plannerTargetResolution";
import {
  normalizeReadSourceRequest,
  type NormalizedReadSourceRequest
} from "./readSourceLocator";

const SOURCE_ALIAS_PATTERN = "^[BS][1-9][0-9]{0,2}$";
const SOURCE_ALIAS_LIMIT = 32;
const EXACT_TERM_LIMIT = 16;
const TARGET_SOURCE_LIMIT = 999;
const CURSOR_PATTERN = "^[A-Za-z0-9_-]+$";
const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const UUID = new RegExp(UUID_PATTERN, "u");
const DISALLOWED_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const laneOrder: readonly KnowledgePlannerLane[] = ["exact", "lexical", "metadata", "semantic"];
const laneSet = new Set<KnowledgePlannerLane>(laneOrder);
const strategySet = new Set<Exclude<KnowledgePlannerStrategy, "none">>([
  "comparison",
  "corpus_summary",
  "exhaustive",
  "focused",
  "full_context",
  "multi_pass",
  "structured_data"
]);
const purposeSet = new Set<KnowledgeOperationPurpose>([
  "answer",
  "compare_target",
  "coverage",
  "follow_up",
  "source_discovery",
  "summary"
]);
const discoveryFieldOrder: readonly KnowledgeSourceDiscoveryField[] = [
  "filename",
  "heading",
  "source_name",
  "tag",
  "title"
];
const discoveryFieldSet = new Set<KnowledgeSourceDiscoveryField>(discoveryFieldOrder);

export type KnowledgeSemanticSearchRequest = Readonly<{
  allowedLanes: readonly KnowledgePlannerLane[];
  coverage: Readonly<{
    expectedPassageCount: number | null;
    mode: "partial" | "verified_only";
  }>;
  exactTerms: readonly string[];
  phaseOrdinal: number;
  plannerVersion: number;
  purpose: KnowledgeOperationPurpose;
  rewrittenQuery: string;
  strategy: Exclude<KnowledgePlannerStrategy, "none">;
  subqueryOrdinal: number;
  targetNames: readonly string[];
  targetSourceIds: readonly string[];
}>;

export type KnowledgeSemanticToolRequest =
  | Readonly<{
      operation: "automatic_search" | "search_knowledge";
      query: string;
      search: KnowledgeSemanticSearchRequest;
      sourceAliases: readonly string[];
      targetSourceIds: readonly string[];
    }>
  | Readonly<{
      exact: KnowledgeExactSearchRequest;
      operation: "find_exact";
      query: string;
      semantic: KnowledgeSemanticSearchRequest;
      sourceAliases: readonly string[];
      targetSourceIds: readonly string[];
    }>
  | Readonly<{
      operation: "read_source";
      query: string;
      read: NormalizedReadSourceRequest & Readonly<{ sourceAlias: string }>;
      sourceAliases: readonly string[];
      targetSourceIds: readonly string[];
    }>
  | Readonly<{
      discovery: KnowledgeSourceDiscoveryRequest;
      operation: "discover_sources";
      query: string;
      semantic: KnowledgeSemanticSearchRequest;
      sourceAliases: readonly string[];
      targetSourceIds: readonly string[];
    }>
  | Readonly<{
      operation: "structured_analysis";
      query: string;
      semantic: KnowledgeSemanticSearchRequest;
      sourceAliases: readonly string[];
      structured: KnowledgeStructuredAnalysisOperationRequestV2["structured"];
      targetSourceIds: readonly string[];
    }>
  | Readonly<{
      operation: "visual_analysis";
      query: string;
      semantic: KnowledgeSemanticSearchRequest;
      sourceAliases: readonly string[];
      targetSourceIds: readonly string[];
      visual: KnowledgeVisualAnalysisOperationRequestV2["visual"];
    }>;

const sourceAliasesSchema = Object.freeze({
  description: "Optional admitted scope aliases (for example S1 or B2). Never pass storage IDs.",
  items: { maxLength: 4, minLength: 2, pattern: SOURCE_ALIAS_PATTERN, type: "string" },
  maxItems: SOURCE_ALIAS_LIMIT,
  type: ["array", "null"]
});

const automaticCommonProperties = Object.freeze({
  coverage: {
    additionalProperties: false,
    properties: {
      expectedPassageCount: { minimum: 1, type: ["integer", "null"] },
      mode: { enum: ["partial", "verified_only"], type: "string" }
    },
    required: ["expectedPassageCount", "mode"],
    type: "object"
  },
  exactTerms: {
    items: { maxLength: 200, minLength: 1, type: "string" },
    maxItems: EXACT_TERM_LIMIT,
    type: "array",
    uniqueItems: true
  },
  lanes: {
    items: { enum: laneOrder, type: "string" },
    maxItems: laneOrder.length,
    type: "array",
    uniqueItems: true
  },
  phaseOrdinal: { maximum: 63, minimum: 0, type: "integer" },
  plannerVersion: { maximum: 256, minimum: 1, type: "integer" },
  purpose: { enum: [...purposeSet], type: "string" },
  query: {
    maxLength: KNOWLEDGE_QUERY_MAX_CHARACTERS,
    minLength: 1,
    type: "string"
  },
  strategy: { enum: [...strategySet], type: "string" },
  subqueryOrdinal: { maximum: 127, minimum: 0, type: "integer" },
  targetNames: {
    items: { maxLength: 160, minLength: 1, type: "string" },
    maxItems: EXACT_TERM_LIMIT,
    type: "array",
    uniqueItems: true
  },
  targetResolution: { type: ["object", "null"] },
  targetSourceIds: {
    items: { pattern: UUID_PATTERN, type: "string" },
    maxItems: TARGET_SOURCE_LIMIT,
    type: "array",
    uniqueItems: true
  }
});
const automaticCommonRequired = Object.freeze(Object.keys(automaticCommonProperties));
const automaticExactSchema = Object.freeze({
  additionalProperties: false,
  properties: {
    caseMode: { enum: ["insensitive", "sensitive"], type: "string" },
    cursor: { maxLength: 64, pattern: CURSOR_PATTERN, type: ["string", "null"] },
    field: {
      enum: ["any", "body", "filename", "heading", "tag", "title"],
      type: "string"
    },
    limit: { maximum: 100, minimum: 1, type: "integer" },
    match: { enum: ["phrase", "token", "pattern"], type: "string" },
    value: { maxLength: KNOWLEDGE_QUERY_MAX_CHARACTERS, minLength: 1, type: "string" }
  },
  required: ["caseMode", "cursor", "field", "limit", "match", "value"],
  type: "object"
});
const automaticDiscoverySchema = Object.freeze({
  additionalProperties: false,
  properties: {
    cursor: { maxLength: 64, pattern: CURSOR_PATTERN, type: ["string", "null"] },
    fields: {
      items: { enum: discoveryFieldOrder, type: "string" },
      maxItems: discoveryFieldOrder.length,
      minItems: 1,
      type: "array",
      uniqueItems: true
    },
    limit: { maximum: 100, minimum: 1, type: "integer" },
    query: { maxLength: KNOWLEDGE_QUERY_MAX_CHARACTERS, minLength: 2, type: "string" }
  },
  required: ["cursor", "fields", "limit", "query"],
  type: "object"
});
const automaticStructuredSchema = Object.freeze({
  additionalProperties: false,
  properties: {
    query: { maxLength: KNOWLEDGE_QUERY_MAX_CHARACTERS, minLength: 1, type: "string" },
    selector: {
      additionalProperties: false,
      properties: {
        columns: {
          items: { maxLength: 256, minLength: 1, type: "string" },
          maxItems: 32,
          type: "array",
          uniqueItems: true
        },
        includeHidden: { enum: [false], type: "boolean" },
        operation: { type: "null" },
        range: { type: "null" },
        sheet: { type: "null" }
      },
      required: ["columns", "includeHidden", "operation", "range", "sheet"],
      type: "object"
    },
    targetSourceIds: {
      ...automaticCommonProperties.targetSourceIds,
      minItems: 1
    }
  },
  required: ["query", "selector", "targetSourceIds"],
  type: "object"
});
const automaticVisualSchema = Object.freeze({
  additionalProperties: false,
  properties: {
    query: { maxLength: KNOWLEDGE_QUERY_MAX_CHARACTERS, minLength: 1, type: "string" },
    selector: { type: "null" },
    targetSourceIds: {
      ...automaticCommonProperties.targetSourceIds,
      minItems: 1
    }
  },
  required: ["query", "selector", "targetSourceIds"],
  type: "object"
});

function automaticVariantSchema(
  operation:
    | "automatic_search"
    | "discover_sources"
    | "find_exact"
    | "structured_analysis"
    | "visual_analysis"
): Record<string, unknown> {
  const variant = operation === "find_exact"
    ? { exact: automaticExactSchema }
    : operation === "discover_sources"
      ? { discovery: automaticDiscoverySchema }
      : operation === "structured_analysis"
        ? { structured: automaticStructuredSchema }
        : operation === "visual_analysis"
          ? { visual: automaticVisualSchema }
      : {};
  const variantKeys = Object.keys(variant);
  return {
    additionalProperties: false,
    properties: {
      ...automaticCommonProperties,
      operation: { enum: [operation], type: "string" },
      ...variant
    },
    required: [...automaticCommonRequired, "operation", ...variantKeys],
    type: "object"
  };
}

export const knowledgeRetrievalTool: RunTool = Object.freeze({
  capability: "knowledge",
  description: "Internal automatic private Knowledge retrieval.",
  inputSchema: {
    oneOf: [
      automaticVariantSchema("automatic_search"),
      automaticVariantSchema("find_exact"),
      automaticVariantSchema("discover_sources"),
      automaticVariantSchema("structured_analysis"),
      automaticVariantSchema("visual_analysis")
    ]
  },
  name: KNOWLEDGE_TOOL_NAME,
  strict: true
});

export const knowledgeSearchTool: RunTool = Object.freeze({
  capability: "knowledge",
  description:
    "Search only the private Knowledge scope already admitted for this answer. " +
    "Use this after the automatic evidence pass when a focused follow-up is necessary.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      coverage: {
        enum: ["focused", "comparison", null],
        type: ["string", "null"]
      },
      exactTerms: {
        items: { maxLength: 200, minLength: 1, type: "string" },
        maxItems: EXACT_TERM_LIMIT,
        type: ["array", "null"]
      },
      purpose: { enum: ["follow_up", null], type: ["string", "null"] },
      query: {
        maxLength: KNOWLEDGE_QUERY_MAX_CHARACTERS,
        minLength: 1,
        type: "string"
      },
      sourceAliases: sourceAliasesSchema
    },
    required: ["coverage", "exactTerms", "purpose", "query", "sourceAliases"],
    type: "object"
  },
  name: KNOWLEDGE_SEARCH_TOOL_NAME,
  strict: true
});

export const knowledgeExactTool: RunTool = Object.freeze({
  capability: "knowledge",
  description:
    "Find an exact phrase, token, code, date, or identifier only inside the admitted private Knowledge scope.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      caseMode: { enum: ["insensitive", "sensitive"], type: "string" },
      cursor: {
        maxLength: 64,
        minLength: 1,
        pattern: CURSOR_PATTERN,
        type: ["string", "null"]
      },
      field: {
        enum: ["any", "body", "filename", "heading", "tag", "title"],
        type: "string"
      },
      limit: { maximum: 100, minimum: 1, type: "integer" },
      match: { enum: ["phrase", "token", "pattern"], type: "string" },
      sourceAliases: sourceAliasesSchema,
      value: {
        maxLength: KNOWLEDGE_QUERY_MAX_CHARACTERS,
        minLength: 1,
        type: "string"
      }
    },
    required: ["caseMode", "cursor", "field", "limit", "match", "sourceAliases", "value"],
    type: "object"
  },
  name: KNOWLEDGE_EXACT_TOOL_NAME,
  strict: true
});

export const knowledgeReadSourceTool: RunTool = Object.freeze({
  capability: "knowledge",
  description:
    "Read a bounded area of one source already returned under an admitted S-number alias. " +
    "Use an evidence handle, labeled page, exact displayed heading path, section/passage/block " +
    "identity, or range:'Sheet'!A1:B8. Tagged examples: handle:K1, heading:A > B, " +
    "section:kis_<opaque-id>, passage:kip_<opaque-id>, block:b_<opaque-id>. Never invent an ID.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      direction: {
        enum: ["around", "after", "before", null],
        type: ["string", "null"]
      },
      locator: {
        maxLength: KNOWLEDGE_QUERY_MAX_CHARACTERS,
        minLength: 1,
        type: "string"
      },
      sourceAlias: { maxLength: 4, minLength: 2, pattern: "^S[1-9][0-9]{0,2}$", type: "string" },
      window: { maximum: 8, minimum: 1, type: ["integer", "null"] }
    },
    required: ["direction", "locator", "sourceAlias", "window"],
    type: "object"
  },
  name: KNOWLEDGE_READ_SOURCE_TOOL_NAME,
  strict: true
});

export const knowledgeDiscoverSourcesTool: RunTool = Object.freeze({
  capability: "knowledge",
  description:
    "Discover source names and S-number aliases only within the scope admitted for this answer. " +
    "It cannot search the user's wider library.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      cursor: {
        maxLength: 64,
        minLength: 1,
        pattern: CURSOR_PATTERN,
        type: ["string", "null"]
      },
      fields: {
        items: { enum: discoveryFieldOrder, type: "string" },
        maxItems: discoveryFieldOrder.length,
        minItems: 1,
        type: "array",
        uniqueItems: true
      },
      limit: { maximum: 100, minimum: 1, type: "integer" },
      query: {
        maxLength: KNOWLEDGE_QUERY_MAX_CHARACTERS,
        minLength: 2,
        type: "string"
      }
    },
    required: ["cursor", "fields", "limit", "query"],
    type: "object"
  },
  name: KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME,
  strict: true
});

export const knowledgeFollowUpTools = Object.freeze([
  knowledgeSearchTool,
  knowledgeExactTool,
  knowledgeReadSourceTool,
  knowledgeDiscoverSourcesTool
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

function boundedString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || DISALLOWED_TEXT.test(value)) return null;
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  return normalized && normalized.length <= maximum
    ? normalized
    : null;
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function uniqueBoundedStrings(
  value: unknown,
  maximumItems: number,
  maximumCharacters: number
): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) return null;
  const decoded = value.map((entry) => boundedString(entry, maximumCharacters));
  if (decoded.some((entry) => entry === null) ||
    new Set(decoded as string[]).size !== decoded.length) return null;
  return Object.freeze(decoded as string[]);
}

function sourceIds(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.length <= TARGET_SOURCE_LIMIT &&
    value.every((entry) => typeof entry === "string" && UUID.test(entry)) &&
    new Set(value).size === value.length
    ? Object.freeze(value as string[])
    : null;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function exactSpecificationBackedByTerms(
  exact: Pick<KnowledgeExactSearchRequest, "match" | "value">,
  exactTerms: readonly string[]
): boolean {
  if (exactTerms.includes(exact.value)) return true;
  if (exact.match === "token") return false;
  if (exact.match === "phrase") {
    return exactTerms.some((term) =>
      /^(?:"[^"]+"|'[^']+'|`[^`]+`|“[^”]+”|«[^»]+»)$/u.test(term) &&
      term.slice(1, -1) === exact.value);
  }
  return exactTerms.some((term) =>
    term.match(/^\/([^/\r\n]{1,200})\/[gimsuy]*$/u)?.[1] === exact.value);
}

function cursor(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  const match = /^1:(0|[1-9]\d*)$/u.exec(decoded);
  const offset = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= 10_000 &&
    Buffer.from(`1:${offset}`, "utf8").toString("base64url") === value
    ? value
    : undefined;
}

function sourceAliases(value: unknown): readonly string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > SOURCE_ALIAS_LIMIT ||
    value.some((alias) => typeof alias !== "string" || !/^[BS][1-9]\d{0,2}$/u.test(alias)) ||
    new Set(value).size !== value.length) return null;
  return value as string[];
}

function queryWithExactTerms(query: string, terms: readonly string[]): string {
  const missing = terms.filter((term) => !query.includes(term));
  const suffix = missing.length > 0 ? ` ${missing.join(" ")}` : "";
  return `${query.slice(0, Math.max(1, KNOWLEDGE_QUERY_MAX_CHARACTERS - suffix.length)).trimEnd()}${suffix}`
    .slice(0, KNOWLEDGE_QUERY_MAX_CHARACTERS)
    .trim();
}

function automaticRequest(value: Record<string, unknown>): KnowledgeSemanticToolRequest | null {
  const operation = value.operation;
  if (operation !== "automatic_search" && operation !== "find_exact" &&
    operation !== "discover_sources" && operation !== "structured_analysis" &&
    operation !== "visual_analysis") return null;
  const variantKey = operation === "find_exact" ? "exact"
    : operation === "discover_sources" ? "discovery"
      : operation === "structured_analysis" ? "structured"
        : operation === "visual_analysis" ? "visual" : null;
  const commonKeys = [
    "coverage",
    "exactTerms",
    "lanes",
    "operation",
    "phaseOrdinal",
    "plannerVersion",
    "purpose",
    "query",
    "strategy",
    "subqueryOrdinal",
    "targetNames",
    "targetResolution",
    "targetSourceIds"
  ];
  if (!exactKeys(value, variantKey ? [...commonKeys, variantKey] : commonKeys) ||
    !record(value.coverage) ||
    !exactKeys(value.coverage, ["expectedPassageCount", "mode"]) ||
    value.coverage.mode !== "partial" && value.coverage.mode !== "verified_only" ||
    value.coverage.expectedPassageCount !== null &&
      !integer(value.coverage.expectedPassageCount, 1, 10_000_000) ||
    !integer(value.plannerVersion, 1, 256) ||
    !integer(value.phaseOrdinal, 0, 63) ||
    !integer(value.subqueryOrdinal, 0, 127) ||
    typeof value.purpose !== "string" ||
    !purposeSet.has(value.purpose as KnowledgeOperationPurpose) ||
    typeof value.strategy !== "string" ||
    !strategySet.has(value.strategy as Exclude<KnowledgePlannerStrategy, "none">)) return null;
  const query = boundedString(value.query, KNOWLEDGE_QUERY_MAX_CHARACTERS);
  const exactTerms = uniqueBoundedStrings(value.exactTerms, EXACT_TERM_LIMIT, 200);
  const targetNames = uniqueBoundedStrings(value.targetNames, EXACT_TERM_LIMIT, 160);
  const targetSourceIds = sourceIds(value.targetSourceIds);
  const targetResolution = decodeKnowledgePlannerTargetResolution(value.targetResolution);
  const rawLanes = value.lanes;
  const lanes = Array.isArray(rawLanes) &&
    rawLanes.length <= laneOrder.length &&
    rawLanes.every((entry) => typeof entry === "string" &&
      laneSet.has(entry as KnowledgePlannerLane)) &&
    new Set(rawLanes).size === rawLanes.length
    ? Object.freeze(laneOrder.filter((lane) => rawLanes.includes(lane)))
    : null;
  if (!query || !exactTerms || !targetNames || !targetSourceIds || !lanes ||
    targetResolution === undefined ||
    (targetResolution !== null && (
      targetResolution.targetSourceIds.length !== targetSourceIds.length ||
      targetResolution.targetSourceIds.some((sourceId, index) =>
        sourceId !== targetSourceIds[index])
    )) || targetResolution !== null && !sameStrings(
      targetNames,
      targetResolution.targets.map((target) => target.targetName)
    ) ||
    (operation === "automatic_search" || operation === "find_exact") &&
      exactTerms.length > 0 && !lanes.includes("exact") ||
    value.purpose === "compare_target" &&
      (targetNames.length === 0 || targetSourceIds.length === 0)) return null;
  const semantic = Object.freeze({
    allowedLanes: lanes,
    coverage: Object.freeze({
      expectedPassageCount: value.coverage.expectedPassageCount === null
        ? null
        : Number(value.coverage.expectedPassageCount),
      mode: value.coverage.mode
    }),
    exactTerms,
    phaseOrdinal: Number(value.phaseOrdinal),
    plannerVersion: Number(value.plannerVersion),
    purpose: value.purpose as KnowledgeOperationPurpose,
    rewrittenQuery: query,
    strategy: value.strategy as Exclude<KnowledgePlannerStrategy, "none">,
    subqueryOrdinal: Number(value.subqueryOrdinal),
    targetNames,
    targetSourceIds
  });
  if (operation === "automatic_search") {
    return lanes.length > 0 && value.purpose !== "source_discovery"
      ? Object.freeze({
          operation,
          query,
          search: semantic,
          sourceAliases: Object.freeze([]),
          targetSourceIds
        })
      : null;
  }
  if (operation === "find_exact") {
    if (!record(value.exact) || !exactKeys(value.exact, [
      "caseMode", "cursor", "field", "limit", "match", "value"
    ]) || lanes.length !== 1 || lanes[0] !== "exact" ||
      value.purpose === "source_discovery" ||
      value.exact.caseMode !== "insensitive" && value.exact.caseMode !== "sensitive" ||
      value.exact.field !== "any" && value.exact.field !== "body" &&
        value.exact.field !== "filename" && value.exact.field !== "heading" &&
        value.exact.field !== "tag" && value.exact.field !== "title" ||
      value.exact.match !== "pattern" && value.exact.match !== "phrase" &&
        value.exact.match !== "token" || !integer(value.exact.limit, 1, 100)) return null;
    const exactValue = boundedString(value.exact.value, KNOWLEDGE_QUERY_MAX_CHARACTERS);
    const exactCursor = cursor(value.exact.cursor);
    return exactValue && exactCursor !== undefined && query.includes(exactValue) &&
      exactSpecificationBackedByTerms({
        match: value.exact.match,
        value: exactValue
      }, exactTerms)
      ? Object.freeze({
          exact: Object.freeze({
            caseMode: value.exact.caseMode,
            cursor: exactCursor,
            field: value.exact.field,
            limit: Number(value.exact.limit),
            match: value.exact.match,
            value: exactValue
          }),
          operation,
          query: exactValue,
          semantic,
          sourceAliases: Object.freeze([]),
          targetSourceIds
        })
      : null;
  }
  if (operation === "discover_sources") {
    if (!record(value.discovery) || !exactKeys(value.discovery, [
      "cursor", "fields", "limit", "query"
    ]) || lanes.length !== 1 || lanes[0] !== "metadata" ||
      value.purpose !== "source_discovery" || exactTerms.length !== 0 ||
      targetSourceIds.length !== 0 || !integer(value.discovery.limit, 1, 100) ||
      !Array.isArray(value.discovery.fields) || value.discovery.fields.length < 1 ||
      value.discovery.fields.length > discoveryFieldOrder.length ||
      value.discovery.fields.some((field) => typeof field !== "string" ||
        !discoveryFieldSet.has(field as KnowledgeSourceDiscoveryField)) ||
      new Set(value.discovery.fields).size !== value.discovery.fields.length) return null;
    const discoveryQuery = boundedString(
      value.discovery.query,
      KNOWLEDGE_QUERY_MAX_CHARACTERS
    );
    const discoveryCursor = cursor(value.discovery.cursor);
    const selected = new Set(value.discovery.fields as KnowledgeSourceDiscoveryField[]);
    return discoveryQuery && discoveryQuery.length >= 2 && discoveryCursor !== undefined &&
      discoveryQuery === query
      ? Object.freeze({
          discovery: Object.freeze({
            cursor: discoveryCursor,
            fields: Object.freeze(discoveryFieldOrder.filter((field) => selected.has(field))),
            limit: Number(value.discovery.limit),
            query: discoveryQuery
          }),
          operation,
          query: discoveryQuery,
          semantic,
          sourceAliases: Object.freeze([]),
          targetSourceIds
        })
      : null;
  }
  if (operation === "structured_analysis") {
    if (lanes.length !== 0 || value.purpose === "source_discovery" ||
      targetNames.length === 0 || targetSourceIds.length === 0 ||
      targetResolution === null || targetResolution.outcome !== "resolved" &&
        targetResolution.outcome !== "resolved_many" ||
      !record(value.structured) || !exactKeys(value.structured, [
        "query", "selector", "targetSourceIds"
      ]) || !record(value.structured.selector) || !exactKeys(value.structured.selector, [
        "columns", "includeHidden", "operation", "range", "sheet"
      ]) || value.structured.selector.includeHidden !== false ||
      value.structured.selector.operation !== null || value.structured.selector.range !== null ||
      value.structured.selector.sheet !== null) return null;
    const structuredQuery = boundedString(
      value.structured.query,
      KNOWLEDGE_QUERY_MAX_CHARACTERS
    );
    const columns = uniqueBoundedStrings(value.structured.selector.columns, 32, 256);
    const structuredTargetSourceIds = sourceIds(value.structured.targetSourceIds);
    return structuredQuery === query && columns && structuredTargetSourceIds &&
      sameStrings(structuredTargetSourceIds, targetSourceIds)
      ? Object.freeze({
          operation,
          query,
          semantic,
          sourceAliases: Object.freeze([]),
          structured: Object.freeze({
            query: structuredQuery,
            selector: Object.freeze({
              columns,
              includeHidden: false,
              operation: null,
              range: null,
              sheet: null
            }),
            targetSourceIds: structuredTargetSourceIds
          }),
          targetSourceIds
        })
      : null;
  }
  if (lanes.length !== 0 || value.purpose === "source_discovery" ||
    targetNames.length === 0 || targetSourceIds.length === 0 ||
    targetResolution === null || targetResolution.outcome !== "resolved" &&
      targetResolution.outcome !== "resolved_many" ||
    !record(value.visual) || !exactKeys(value.visual, [
      "query", "selector", "targetSourceIds"
    ]) || value.visual.selector !== null) return null;
  const visualQuery = boundedString(value.visual.query, KNOWLEDGE_QUERY_MAX_CHARACTERS);
  const visualTargetSourceIds = sourceIds(value.visual.targetSourceIds);
  return visualQuery === query && visualTargetSourceIds &&
    sameStrings(visualTargetSourceIds, targetSourceIds)
    ? Object.freeze({
        operation,
        query,
        semantic,
        sourceAliases: Object.freeze([]),
        targetSourceIds,
        visual: Object.freeze({
          query: visualQuery,
          selector: null,
          targetSourceIds: visualTargetSourceIds
        })
      })
    : null;
}

export function parseKnowledgeSemanticToolRequest(
  call: Pick<ModelToolCall, "arguments" | "name">
): KnowledgeSemanticToolRequest | null {
  const value = call.arguments;
  if (call.name === KNOWLEDGE_TOOL_NAME) {
    return record(value) ? automaticRequest(value) : null;
  }
  if (!record(value)) return null;
  if (call.name === KNOWLEDGE_SEARCH_TOOL_NAME) {
    if (!exactKeys(value, ["coverage", "exactTerms", "purpose", "query", "sourceAliases"])) {
      return null;
    }
    const query = boundedString(value.query, KNOWLEDGE_QUERY_MAX_CHARACTERS);
    const aliases = sourceAliases(value.sourceAliases);
    const terms = value.exactTerms === undefined || value.exactTerms === null
      ? []
      : Array.isArray(value.exactTerms) && value.exactTerms.length <= EXACT_TERM_LIMIT
        ? value.exactTerms.map((term) => boundedString(term, 200))
        : null;
    if (!query || !aliases || !terms || terms.some((term) => term === null) ||
      value.purpose !== null && value.purpose !== "follow_up" ||
      value.coverage !== undefined && value.coverage !== null &&
        value.coverage !== "focused" && value.coverage !== "comparison") return null;
    const rewrittenQuery = queryWithExactTerms(query, terms as string[]);
    return {
      operation: "search_knowledge",
      query: rewrittenQuery,
      search: {
        allowedLanes: ["exact", "lexical", "metadata", "semantic"],
        coverage: { expectedPassageCount: null, mode: "partial" },
        exactTerms: terms as string[],
        phaseOrdinal: 0,
        plannerVersion: 2,
        purpose: "follow_up",
        rewrittenQuery,
        strategy: value.coverage === "comparison" ? "comparison" : "focused",
        subqueryOrdinal: 0,
        targetNames: [],
        targetSourceIds: []
      },
      sourceAliases: aliases,
      targetSourceIds: []
    };
  }
  if (call.name === KNOWLEDGE_EXACT_TOOL_NAME) {
    if (!exactKeys(value, [
      "caseMode",
      "cursor",
      "field",
      "limit",
      "match",
      "sourceAliases",
      "value"
    ]) || value.caseMode !== "insensitive" && value.caseMode !== "sensitive" ||
      value.field !== "any" && value.field !== "body" && value.field !== "filename" &&
        value.field !== "heading" && value.field !== "tag" && value.field !== "title" ||
      !integer(value.limit, 1, 100) ||
      value.match !== "phrase" && value.match !== "token" && value.match !== "pattern") return null;
    const query = boundedString(value.value, KNOWLEDGE_QUERY_MAX_CHARACTERS);
    const aliases = sourceAliases(value.sourceAliases);
    const exactCursor = cursor(value.cursor);
    return query && aliases && exactCursor !== undefined
      ? {
          exact: {
            caseMode: value.caseMode,
            cursor: exactCursor,
            field: value.field,
            limit: Number(value.limit),
            match: value.match,
            value: query
          },
          operation: "find_exact",
          query,
          semantic: {
            allowedLanes: ["exact"],
            coverage: { expectedPassageCount: null, mode: "partial" },
            exactTerms: [query],
            phaseOrdinal: 0,
            plannerVersion: 2,
            purpose: "follow_up",
            rewrittenQuery: query,
            strategy: "focused",
            subqueryOrdinal: 0,
            targetNames: [],
            targetSourceIds: []
          },
          sourceAliases: aliases,
          targetSourceIds: []
        }
      : null;
  }
  if (call.name === KNOWLEDGE_READ_SOURCE_TOOL_NAME) {
    if (!exactKeys(value, ["direction", "locator", "sourceAlias", "window"]) ||
      typeof value.sourceAlias !== "string" || !/^S[1-9]\d{0,2}$/u.test(value.sourceAlias)) {
      return null;
    }
    const read = normalizeReadSourceRequest({
      direction: value.direction,
      locator: value.locator,
      window: value.window
    });
    return read
      ? {
          operation: "read_source",
          query: read.locator,
          read: Object.freeze({ ...read, sourceAlias: value.sourceAlias }),
          sourceAliases: [value.sourceAlias],
          targetSourceIds: []
        }
      : null;
  }
  if (call.name === KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME) {
    if (!exactKeys(value, ["cursor", "fields", "limit", "query"]) ||
      !integer(value.limit, 1, 100) || !Array.isArray(value.fields) ||
      value.fields.length < 1 || value.fields.length > discoveryFieldOrder.length ||
      value.fields.some((field) => typeof field !== "string" ||
        !discoveryFieldSet.has(field as KnowledgeSourceDiscoveryField)) ||
      new Set(value.fields).size !== value.fields.length) return null;
    const query = boundedString(value.query, KNOWLEDGE_QUERY_MAX_CHARACTERS);
    const discoveryCursor = cursor(value.cursor);
    const selected = new Set(value.fields as KnowledgeSourceDiscoveryField[]);
    const fields = discoveryFieldOrder.filter((field) => selected.has(field));
    return query && query.length >= 2 && discoveryCursor !== undefined
      ? {
          discovery: {
            cursor: discoveryCursor,
            fields,
            limit: Number(value.limit),
            query
          },
          operation: "discover_sources",
          query,
          semantic: {
            allowedLanes: ["metadata"],
            coverage: { expectedPassageCount: null, mode: "partial" },
            exactTerms: [],
            phaseOrdinal: 0,
            plannerVersion: 2,
            purpose: "source_discovery",
            rewrittenQuery: query,
            strategy: "focused",
            subqueryOrdinal: 0,
            targetNames: [],
            targetSourceIds: []
          },
          sourceAliases: [],
          targetSourceIds: []
        }
      : null;
  }
  return null;
}
