import { createHash } from "node:crypto";
import type { KnowledgeOperationKind } from "./knowledgeBudget";
import {
  decodeKnowledgeFocusedRequest,
  type KnowledgeFocusedRequestV1
} from "./focusedRequest";
import {
  normalizeReadSourceRequest,
  type NormalizedReadSourceRequest
} from "./readSourceLocator";
import {
  KNOWLEDGE_QUERY_MAX_CHARACTERS,
  type KnowledgeExactSearchRequest,
  type KnowledgeSourceDiscoveryField,
  type KnowledgeSourceDiscoveryRequest
} from "./retrievalTypes";

export const KNOWLEDGE_OPERATION_REQUEST_LEGACY_VERSION = 2 as const;
export const KNOWLEDGE_OPERATION_REQUEST_VERSION = 3 as const;
export const KNOWLEDGE_OPERATION_REQUEST_MAX_SOURCES = 1_024;
export const KNOWLEDGE_OPERATION_REQUEST_MAX_BINDINGS = 128;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BASE_SNAPSHOT_ID = /^kbs_[0-9a-f]{40}$/u;
const SOURCE_ALIAS = /^[BS][1-9]\d{0,2}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/u;
const CURSOR = /^[A-Za-z0-9][A-Za-z0-9._~:/+-]{0,511}$/u;
const DISALLOWED_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const exactFields = new Set(["any", "body", "filename", "heading", "tag", "title"]);
const discoveryFields = ["filename", "heading", "source_name", "tag", "title"] as const;
const discoveryFieldSet = new Set<string>(discoveryFields);

export type KnowledgeOperationRequestEnvelopeV2 = Readonly<{
  idempotencyKey: string;
  operation: KnowledgeOperationKind;
  originalQuery: Readonly<{ reference: string; sha256: string }>;
  phaseOrdinal: number;
  profileRevisionId: string;
  profileRevisionNumber: number;
  reservationId: string;
  resolvedSourceIds: readonly string[];
  sourceAliases: readonly string[];
  subqueryOrdinal: number;
  version: typeof KNOWLEDGE_OPERATION_REQUEST_LEGACY_VERSION;
}>;

export type KnowledgeFocusedOperationRequestV2 = KnowledgeOperationRequestEnvelopeV2 &
  Readonly<{ focused: KnowledgeFocusedRequestV1; operation: "automatic_search" }>;

export type KnowledgeSearchOperationRequestV2 = KnowledgeOperationRequestEnvelopeV2 &
  Readonly<{ operation: "automatic_search"; query: string }>;

export type KnowledgeFindExactOperationRequestV2 = KnowledgeOperationRequestEnvelopeV2 &
  Readonly<{ exact: KnowledgeExactSearchRequest; operation: "find_exact" }>;

export type KnowledgeReadSourceOperationRequestV2 = KnowledgeOperationRequestEnvelopeV2 &
  Readonly<{ operation: "read_source"; read: NormalizedReadSourceRequest }>;

export type KnowledgeDiscoverSourcesOperationRequestV2 = KnowledgeOperationRequestEnvelopeV2 &
  Readonly<{ discovery: KnowledgeSourceDiscoveryRequest; operation: "discover_sources" }>;

export type KnowledgeOperationRequestV2 =
  | KnowledgeDiscoverSourcesOperationRequestV2
  | KnowledgeFindExactOperationRequestV2
  | KnowledgeFocusedOperationRequestV2
  | KnowledgeSearchOperationRequestV2
  | KnowledgeReadSourceOperationRequestV2;

export type KnowledgeOperationBaseSnapshotScopeV3 = Readonly<{
  bindings: readonly Readonly<{
    bindingOrdinal: number;
    knowledgeBaseId: string;
    knowledgeBaseSnapshotId: string;
  }>[];
  kind: "base_snapshots";
}>;

export type KnowledgeOperationSourceScopeV3 = Readonly<{
  kind: "sources";
  sourceIds: readonly string[];
}>;

export type KnowledgeOperationScopeV3 =
  | KnowledgeOperationBaseSnapshotScopeV3
  | KnowledgeOperationSourceScopeV3;

export type KnowledgeOperationRequestEnvelopeV3 = Readonly<{
  idempotencyKey: string;
  operation: KnowledgeOperationKind;
  originalQuery: Readonly<{ reference: string; sha256: string }>;
  phaseOrdinal: number;
  profileRevisionId: string;
  profileRevisionNumber: number;
  reservationId: string;
  scope: KnowledgeOperationScopeV3;
  sourceAliases: readonly string[];
  subqueryOrdinal: number;
  version: typeof KNOWLEDGE_OPERATION_REQUEST_VERSION;
}>;

export type KnowledgeFocusedOperationRequestV3 = KnowledgeOperationRequestEnvelopeV3 &
  Readonly<{ focused: KnowledgeFocusedRequestV1; operation: "automatic_search" }>;

export type KnowledgeSearchOperationRequestV3 = KnowledgeOperationRequestEnvelopeV3 &
  Readonly<{ operation: "automatic_search"; query: string }>;

export type KnowledgeFindExactOperationRequestV3 = KnowledgeOperationRequestEnvelopeV3 &
  Readonly<{ exact: KnowledgeExactSearchRequest; operation: "find_exact" }>;

export type KnowledgeReadSourceOperationRequestV3 = KnowledgeOperationRequestEnvelopeV3 &
  Readonly<{ operation: "read_source"; read: NormalizedReadSourceRequest }>;

export type KnowledgeDiscoverSourcesOperationRequestV3 = KnowledgeOperationRequestEnvelopeV3 &
  Readonly<{ discovery: KnowledgeSourceDiscoveryRequest; operation: "discover_sources" }>;

export type KnowledgeOperationRequestV3 =
  | KnowledgeDiscoverSourcesOperationRequestV3
  | KnowledgeFindExactOperationRequestV3
  | KnowledgeFocusedOperationRequestV3
  | KnowledgeSearchOperationRequestV3
  | KnowledgeReadSourceOperationRequestV3;

export type KnowledgeOperationRequest = KnowledgeOperationRequestV2 | KnowledgeOperationRequestV3;

export type KnowledgeOperationTargeting =
  | Pick<KnowledgeOperationRequestV2, "operation" | "resolvedSourceIds" | "version">
  | Pick<KnowledgeOperationRequestV3, "operation" | "scope" | "version">;

const envelopeKeys = [
  "idempotencyKey",
  "operation",
  "originalQuery",
  "phaseOrdinal",
  "profileRevisionId",
  "profileRevisionNumber",
  "reservationId",
  "resolvedSourceIds",
  "sourceAliases",
  "subqueryOrdinal",
  "version"
] as const;

const envelopeKeysV3 = [
  "idempotencyKey",
  "operation",
  "originalQuery",
  "phaseOrdinal",
  "profileRevisionId",
  "profileRevisionNumber",
  "reservationId",
  "scope",
  "sourceAliases",
  "subqueryOrdinal",
  "version"
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function canonicalText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || DISALLOWED_TEXT.test(value)) return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized.length > 0 && [...normalized].length <= maximum && normalized === value
    ? normalized
    : null;
}

function orderedUniqueStrings(
  value: unknown,
  maximum: number,
  decoder: (entry: unknown) => string | null
): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const decoded = value.map(decoder);
  if (decoded.some((entry) => entry === null)) return null;
  const strings = decoded as string[];
  if (new Set(strings).size !== strings.length ||
    strings.some((entry, index) => index > 0 && strings[index - 1]! >= entry)) return null;
  return Object.freeze(strings);
}

function decodeEnvelope(value: Record<string, unknown>): KnowledgeOperationRequestEnvelopeV2 | null {
  if (value.version !== KNOWLEDGE_OPERATION_REQUEST_LEGACY_VERSION ||
    typeof value.operation !== "string" ||
    !integer(value.phaseOrdinal, 0, 63) ||
    !integer(value.subqueryOrdinal, 0, 127) ||
    !integer(value.profileRevisionNumber, 1, 2_147_483_647) ||
    typeof value.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    typeof value.profileRevisionId !== "string" || !UUID.test(value.profileRevisionId) ||
    typeof value.reservationId !== "string" || !UUID.test(value.reservationId) ||
    !record(value.originalQuery) || !exactKeys(value.originalQuery, ["reference", "sha256"]) ||
    !canonicalText(value.originalQuery.reference, 512) ||
    typeof value.originalQuery.sha256 !== "string" || !SHA256.test(value.originalQuery.sha256)) {
    return null;
  }
  const resolvedSourceIds = orderedUniqueStrings(
    value.resolvedSourceIds,
    KNOWLEDGE_OPERATION_REQUEST_MAX_SOURCES,
    (entry) => typeof entry === "string" && UUID.test(entry) ? entry : null
  );
  const sourceAliases = orderedUniqueStrings(
    value.sourceAliases,
    KNOWLEDGE_OPERATION_REQUEST_MAX_SOURCES,
    (entry) => typeof entry === "string" && SOURCE_ALIAS.test(entry) ? entry : null
  );
  if (!resolvedSourceIds || !sourceAliases) return null;
  return Object.freeze({
    idempotencyKey: value.idempotencyKey,
    operation: value.operation as KnowledgeOperationKind,
    originalQuery: Object.freeze({
      reference: value.originalQuery.reference as string,
      sha256: value.originalQuery.sha256
    }),
    phaseOrdinal: Number(value.phaseOrdinal),
    profileRevisionId: value.profileRevisionId,
    profileRevisionNumber: Number(value.profileRevisionNumber),
    reservationId: value.reservationId,
    resolvedSourceIds,
    sourceAliases,
    subqueryOrdinal: Number(value.subqueryOrdinal),
    version: KNOWLEDGE_OPERATION_REQUEST_LEGACY_VERSION
  });
}

function decodeScopeV3(value: unknown): KnowledgeOperationScopeV3 | null {
  if (!record(value) || typeof value.kind !== "string") return null;
  if (value.kind === "sources") {
    if (!exactKeys(value, ["kind", "sourceIds"])) return null;
    const sourceIds = orderedUniqueStrings(
      value.sourceIds,
      KNOWLEDGE_OPERATION_REQUEST_MAX_SOURCES,
      (entry) => typeof entry === "string" && UUID.test(entry) ? entry : null
    );
    return sourceIds ? Object.freeze({ kind: "sources", sourceIds }) : null;
  }
  if (value.kind !== "base_snapshots" || !exactKeys(value, ["bindings", "kind"]) ||
    !Array.isArray(value.bindings) || value.bindings.length < 1 ||
    value.bindings.length > KNOWLEDGE_OPERATION_REQUEST_MAX_BINDINGS) return null;
  const bindings: Array<KnowledgeOperationBaseSnapshotScopeV3["bindings"][number]> = [];
  for (const entry of value.bindings) {
    if (!record(entry) || !exactKeys(entry, [
      "bindingOrdinal", "knowledgeBaseId", "knowledgeBaseSnapshotId"
    ]) || !integer(entry.bindingOrdinal, 0, KNOWLEDGE_OPERATION_REQUEST_MAX_BINDINGS - 1) ||
      typeof entry.knowledgeBaseId !== "string" || !UUID.test(entry.knowledgeBaseId) ||
      typeof entry.knowledgeBaseSnapshotId !== "string" ||
      !BASE_SNAPSHOT_ID.test(entry.knowledgeBaseSnapshotId)) return null;
    bindings.push(Object.freeze({
      bindingOrdinal: Number(entry.bindingOrdinal),
      knowledgeBaseId: entry.knowledgeBaseId,
      knowledgeBaseSnapshotId: entry.knowledgeBaseSnapshotId
    }));
  }
  if (bindings.some((binding, index) => index > 0 &&
    binding.bindingOrdinal <= bindings[index - 1]!.bindingOrdinal) ||
    new Set(bindings.map((binding) => binding.knowledgeBaseId)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.knowledgeBaseSnapshotId)).size !== bindings.length) {
    return null;
  }
  return Object.freeze({ bindings: Object.freeze(bindings), kind: "base_snapshots" });
}

function decodeEnvelopeV3(
  value: Record<string, unknown>
): KnowledgeOperationRequestEnvelopeV3 | null {
  if (value.version !== KNOWLEDGE_OPERATION_REQUEST_VERSION ||
    typeof value.operation !== "string" ||
    !integer(value.phaseOrdinal, 0, 63) ||
    !integer(value.subqueryOrdinal, 0, 127) ||
    !integer(value.profileRevisionNumber, 1, 2_147_483_647) ||
    typeof value.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    typeof value.profileRevisionId !== "string" || !UUID.test(value.profileRevisionId) ||
    typeof value.reservationId !== "string" || !UUID.test(value.reservationId) ||
    !record(value.originalQuery) || !exactKeys(value.originalQuery, ["reference", "sha256"]) ||
    !canonicalText(value.originalQuery.reference, 512) ||
    typeof value.originalQuery.sha256 !== "string" || !SHA256.test(value.originalQuery.sha256)) {
    return null;
  }
  const scope = decodeScopeV3(value.scope);
  const sourceAliases = orderedUniqueStrings(
    value.sourceAliases,
    KNOWLEDGE_OPERATION_REQUEST_MAX_SOURCES,
    (entry) => typeof entry === "string" && SOURCE_ALIAS.test(entry) ? entry : null
  );
  if (!scope || !sourceAliases ||
    scope.kind === "base_snapshots" && sourceAliases.some((alias) => {
      if (!alias.startsWith("B")) return true;
      const ordinal = Number(alias.slice(1)) - 1;
      return !scope.bindings.some((binding) => binding.bindingOrdinal === ordinal);
    })) {
    return null;
  }
  return Object.freeze({
    idempotencyKey: value.idempotencyKey,
    operation: value.operation as KnowledgeOperationKind,
    originalQuery: Object.freeze({
      reference: value.originalQuery.reference as string,
      sha256: value.originalQuery.sha256
    }),
    phaseOrdinal: Number(value.phaseOrdinal),
    profileRevisionId: value.profileRevisionId,
    profileRevisionNumber: Number(value.profileRevisionNumber),
    reservationId: value.reservationId,
    scope,
    sourceAliases,
    subqueryOrdinal: Number(value.subqueryOrdinal),
    version: KNOWLEDGE_OPERATION_REQUEST_VERSION
  });
}

function decodeExact(value: unknown): KnowledgeExactSearchRequest | null {
  if (!record(value) || !exactKeys(value, [
    "caseMode", "cursor", "field", "limit", "match", "value"
  ]) || value.caseMode !== "insensitive" && value.caseMode !== "sensitive" ||
    typeof value.field !== "string" || !exactFields.has(value.field) ||
    !integer(value.limit, 1, 100) ||
    value.match !== "pattern" && value.match !== "phrase" && value.match !== "token" ||
    value.cursor !== null && (typeof value.cursor !== "string" || !CURSOR.test(value.cursor))) {
    return null;
  }
  const text = canonicalText(value.value, KNOWLEDGE_QUERY_MAX_CHARACTERS);
  return text ? Object.freeze({
    caseMode: value.caseMode,
    cursor: value.cursor as string | null,
    field: value.field as KnowledgeExactSearchRequest["field"],
    limit: Number(value.limit),
    match: value.match,
    value: text
  }) : null;
}

function decodeDiscovery(value: unknown): KnowledgeSourceDiscoveryRequest | null {
  if (!record(value) || !exactKeys(value, ["cursor", "fields", "limit", "query"]) ||
    !integer(value.limit, 1, 100) ||
    value.cursor !== null && (typeof value.cursor !== "string" || !CURSOR.test(value.cursor)) ||
    !Array.isArray(value.fields) || value.fields.length < 1 ||
    value.fields.length > discoveryFields.length || value.fields.some((field) =>
      typeof field !== "string" || !discoveryFieldSet.has(field))) return null;
  const rawFields = value.fields as KnowledgeSourceDiscoveryField[];
  const selected = new Set(rawFields);
  const fields = discoveryFields.filter((field) => selected.has(field));
  if (fields.length !== rawFields.length || fields.some((field, index) =>
    field !== rawFields[index])) return null;
  const query = canonicalText(value.query, KNOWLEDGE_QUERY_MAX_CHARACTERS);
  return query && query.length >= 2 ? Object.freeze({
    cursor: value.cursor as string | null,
    fields: Object.freeze(fields),
    limit: Number(value.limit),
    query
  }) : null;
}

function decodeRead(value: unknown): NormalizedReadSourceRequest | null {
  if (!record(value) || !exactKeys(value, [
    "contractVersion", "direction", "embedding", "locator", "resolution", "target", "window"
  ]) || value.embedding !== "forbidden" || value.resolution !== "exact") return null;
  const decoded = normalizeReadSourceRequest({
    direction: value.direction,
    locator: value.locator,
    window: value.window
  });
  return decoded && JSON.stringify(decoded.target) === JSON.stringify(value.target) &&
    decoded.contractVersion === value.contractVersion ? decoded : null;
}

/** Decodes only the focused operation and internal exact/read/discover primitives. */
export function decodeKnowledgeOperationRequestV2(value: unknown): KnowledgeOperationRequestV2 | null {
  if (!record(value) || typeof value.operation !== "string") return null;
  let variantKey: "discovery" | "exact" | "focused" | "query" | "read" | undefined;
  if (value.operation === "automatic_search") {
    variantKey = Object.hasOwn(value, "query") ? "query" : "focused";
  } else {
    variantKey = ({
      discover_sources: "discovery",
      find_exact: "exact",
      read_source: "read"
    } as const)[value.operation as Exclude<KnowledgeOperationKind, "automatic_search">];
  }
  if (!variantKey || !exactKeys(value, [...envelopeKeys, variantKey])) return null;
  const envelope = decodeEnvelope(value);
  if (!envelope) return null;
  switch (value.operation) {
    case "automatic_search": {
      if (variantKey === "query") {
        const query = canonicalText(value.query, KNOWLEDGE_QUERY_MAX_CHARACTERS);
        return query && envelope.resolvedSourceIds.length >= 1
          ? Object.freeze({ ...envelope, operation: "automatic_search", query })
          : null;
      }
      const focused = decodeKnowledgeFocusedRequest(value.focused);
      return focused && envelope.phaseOrdinal === 0 && envelope.subqueryOrdinal === 0 &&
        envelope.resolvedSourceIds.length >= 1 &&
        envelope.sourceAliases.length === 0
        ? Object.freeze({ ...envelope, focused, operation: "automatic_search" })
        : null;
    }
    case "find_exact": {
      const exact = decodeExact(value.exact);
      return exact && envelope.resolvedSourceIds.length >= 1
        ? Object.freeze({ ...envelope, exact, operation: "find_exact" })
        : null;
    }
    case "read_source": {
      const read = decodeRead(value.read);
      return read && envelope.sourceAliases.length === 1 &&
        envelope.sourceAliases[0]!.startsWith("S") && envelope.resolvedSourceIds.length === 1
        ? Object.freeze({ ...envelope, operation: "read_source", read })
        : null;
    }
    case "discover_sources": {
      const discovery = decodeDiscovery(value.discovery);
      return discovery && envelope.sourceAliases.length === 0
        ? Object.freeze({ ...envelope, discovery, operation: "discover_sources" })
        : null;
    }
    default:
      return null;
  }
}

export function decodeKnowledgeOperationRequestV3(value: unknown): KnowledgeOperationRequestV3 | null {
  if (!record(value) || typeof value.operation !== "string") return null;
  let variantKey: "discovery" | "exact" | "focused" | "query" | "read" | undefined;
  if (value.operation === "automatic_search") {
    variantKey = Object.hasOwn(value, "query") ? "query" : "focused";
  } else {
    variantKey = ({
      discover_sources: "discovery",
      find_exact: "exact",
      read_source: "read"
    } as const)[value.operation as Exclude<KnowledgeOperationKind, "automatic_search">];
  }
  if (!variantKey || !exactKeys(value, [...envelopeKeysV3, variantKey])) return null;
  const envelope = decodeEnvelopeV3(value);
  if (!envelope) return null;
  switch (value.operation) {
    case "automatic_search": {
      if (variantKey === "query") {
        const query = canonicalText(value.query, KNOWLEDGE_QUERY_MAX_CHARACTERS);
        return query && (envelope.scope.kind === "base_snapshots" ||
          envelope.scope.sourceIds.length > 0)
          ? Object.freeze({ ...envelope, operation: "automatic_search", query })
          : null;
      }
      const focused = decodeKnowledgeFocusedRequest(value.focused);
      return focused && envelope.phaseOrdinal === 0 && envelope.subqueryOrdinal === 0 &&
        envelope.sourceAliases.length === 0 &&
        (envelope.scope.kind === "base_snapshots" || envelope.scope.sourceIds.length > 0)
        ? Object.freeze({ ...envelope, focused, operation: "automatic_search" })
        : null;
    }
    case "find_exact": {
      const exact = decodeExact(value.exact);
      return exact && envelope.scope.kind === "sources" && envelope.scope.sourceIds.length > 0
        ? Object.freeze({ ...envelope, exact, operation: "find_exact" })
        : null;
    }
    case "read_source": {
      const read = decodeRead(value.read);
      return read && envelope.scope.kind === "sources" &&
        envelope.sourceAliases.length === 1 &&
        envelope.sourceAliases[0]!.startsWith("S") && envelope.scope.sourceIds.length === 1
        ? Object.freeze({ ...envelope, operation: "read_source", read })
        : null;
    }
    case "discover_sources": {
      const discovery = decodeDiscovery(value.discovery);
      return discovery && envelope.scope.kind === "sources" &&
        envelope.sourceAliases.length === 0
        ? Object.freeze({ ...envelope, discovery, operation: "discover_sources" })
        : null;
    }
    default:
      return null;
  }
}

export function decodeKnowledgeOperationRequest(value: unknown): KnowledgeOperationRequest | null {
  return decodeKnowledgeOperationRequestV3(value) ?? decodeKnowledgeOperationRequestV2(value);
}

export function createKnowledgeOperationRequestV2(value: unknown): KnowledgeOperationRequestV2 {
  const decoded = decodeKnowledgeOperationRequestV2(value);
  if (!decoded) throw new Error("knowledge_operation_request_v2_invalid");
  return decoded;
}

export function createKnowledgeOperationRequestV3(value: unknown): KnowledgeOperationRequestV3 {
  const decoded = decodeKnowledgeOperationRequestV3(value);
  if (!decoded) throw new Error("knowledge_operation_request_v3_invalid");
  return decoded;
}

export function knowledgeOperationTargetSourceIds(
  request: KnowledgeOperationTargeting
): readonly string[] {
  if (request.operation === "discover_sources") return [];
  if (request.version === KNOWLEDGE_OPERATION_REQUEST_LEGACY_VERSION) {
    return request.resolvedSourceIds ?? [];
  }
  return request.scope?.kind === "sources" ? request.scope.sourceIds : [];
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]));
}

export function canonicalKnowledgeOperationRequestV2(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(createKnowledgeOperationRequestV2(value)));
}

export function hashKnowledgeOperationRequestV2(value: unknown): string {
  return createHash("sha256")
    .update(canonicalKnowledgeOperationRequestV2(value), "utf8")
    .digest("hex");
}

export function canonicalKnowledgeOperationRequestV3(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(createKnowledgeOperationRequestV3(value)));
}

export function hashKnowledgeOperationRequestV3(value: unknown): string {
  return createHash("sha256")
    .update(canonicalKnowledgeOperationRequestV3(value), "utf8")
    .digest("hex");
}

export function canonicalKnowledgeOperationRequest(value: unknown): string {
  const decoded = decodeKnowledgeOperationRequest(value);
  if (!decoded) throw new Error("knowledge_operation_request_invalid");
  return JSON.stringify(canonicalJsonValue(decoded));
}

export function hashKnowledgeOperationRequest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalKnowledgeOperationRequest(value), "utf8")
    .digest("hex");
}
