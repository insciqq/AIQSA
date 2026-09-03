export const KNOWLEDGE_BASE_NAME_MAX_LENGTH = 80;
export const KNOWLEDGE_BASE_DESCRIPTION_MAX_LENGTH = 2000;
export const KNOWLEDGE_SELECTION_VERSION = 1 as const;
/**
 * Payload-safety bound for an explicit mixed Base/Source selection. This is
 * deliberately not a retrieval or UI tuning control: "All my knowledge" is a
 * separate constant-size mode and execution budgets decide how much work a run
 * may perform after admission.
 */
export const KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES = 128;
/** Persistence-safety ceiling for one answer receipt. Ordinary limits come
 * from the accepted evidence budget; this only bounds hostile/malformed data. */
export const KNOWLEDGE_CITATION_V2_MAX = 2_048;
export const KNOWLEDGE_CITATION_INVOCATION_MAX = 256;
export const KNOWLEDGE_CITATION_RESULT_MAX = 8;
export const KNOWLEDGE_PROCESSING_WARNING_CODES = Object.freeze([
  "partial_parse",
  "unreadable_pages",
  "low_page_coverage",
  "low_text_density",
  "low_ocr_confidence",
  "truncated_oversized_section",
  "table_extraction_degraded",
  "embedded_object_unsupported",
  "repeated_header_footer",
  "parser_fallback_failed"
] as const);

export type KnowledgeProcessingWarningCode =
  (typeof KNOWLEDGE_PROCESSING_WARNING_CODES)[number];

type KnowledgeSelectionCommon = Readonly<{
  baseIds: string[];
  sourceIds: string[];
  version: typeof KNOWLEDGE_SELECTION_VERSION;
}>;

export type KnowledgeSelection =
  | (KnowledgeSelectionCommon & Readonly<{ mode: "none" }>)
  | (KnowledgeSelectionCommon & Readonly<{ mode: "explicit" }>)
  | (KnowledgeSelectionCommon & Readonly<{ mode: "all_my_knowledge" }>)
  | (KnowledgeSelectionCommon & Readonly<{
      inheritedFrom: "assistant" | "project";
      mode: "inherited";
    }>);

/** @deprecated Use KnowledgeSelection. Kept as a source-compatible name while
 * persisted defaults and run contracts move together to the canonical union. */
export type KnowledgePlan = KnowledgeSelection;

export const EMPTY_KNOWLEDGE_SELECTION: KnowledgeSelection = Object.freeze({
  baseIds: [],
  mode: "none",
  sourceIds: [],
  version: KNOWLEDGE_SELECTION_VERSION
});

export type KnowledgePlanDecodeResult =
  | Readonly<{ code: "knowledge_plan_invalid"; ok: false }>
  | Readonly<{ ok: true; plan: KnowledgeSelection }>;

export type KnowledgeCitationHandle =
  | Readonly<{
      evidenceOrdinal: number;
      handle: string;
    }>
  | Readonly<{
      handle: string;
      invocationOrdinal: number;
      resultOrdinal: number;
    }>;

export function decodeKnowledgeCitationHandle(value: unknown): KnowledgeCitationHandle | null {
  if (typeof value !== "string") return null;
  const current = /^K([1-9]\d{0,3})$/u.exec(value);
  if (current) {
    const evidenceOrdinal = Number(current[1]);
    return Number.isSafeInteger(evidenceOrdinal) && evidenceOrdinal <= KNOWLEDGE_CITATION_V2_MAX
      ? { evidenceOrdinal, handle: value }
      : null;
  }
  const legacy = /^K([1-9]\d{0,2})\.([1-9]\d?)$/u.exec(value);
  if (!legacy) return null;
  const invocationOrdinal = Number(legacy[1]);
  const resultOrdinal = Number(legacy[2]);
  return Number.isSafeInteger(invocationOrdinal) &&
    invocationOrdinal <= KNOWLEDGE_CITATION_INVOCATION_MAX &&
    Number.isSafeInteger(resultOrdinal) && resultOrdinal <= KNOWLEDGE_CITATION_RESULT_MAX
    ? { handle: value, invocationOrdinal, resultOrdinal }
    : null;
}

export function knowledgeCitationHandlesFromText(value: string): string[] {
  return [...value.matchAll(/\[(K[1-9]\d{0,3}(?:\.[1-9]\d?)?)\]/gu)]
    .flatMap((match) => {
      const decoded = decodeKnowledgeCitationHandle(match[1]);
      return decoded ? [decoded.handle] : [];
    });
}

export type KnowledgeBaseCreateInput = Readonly<{
  description: string;
  name: string;
}>;

export type KnowledgeBaseUpdateInput = Readonly<{
  archived?: boolean;
  description?: string;
  expectedVersion: number;
  name?: string;
}>;

export type KnowledgeBasePublicationInput =
  | Readonly<{ groupId: string; scope: "group" }>
  | Readonly<{ groupId: null; scope: "installation" }>;

export type KnowledgeBaseScope =
  | Readonly<{ kind: "owner" }>
  | Readonly<{ groupNames: string[]; kind: "group" }>
  | Readonly<{ kind: "installation" }>;

export type KnowledgeReadiness = Readonly<{
  attentionSources: number;
  processingSources: number;
  readySources: number;
  state: "archived" | "empty" | "needs_attention" | "processing" | "ready" | "trashed";
  supportReference: string | null;
  totalSources: number;
}>;

export type KnowledgeBaseSummary = Readonly<{
  archived: boolean;
  deletionPending: boolean;
  description: string;
  sourceCount: number;
  id: string;
  name: string;
  owned: boolean;
  ownerDisplayName: string;
  purgeScheduledAt: string | null;
  readiness: KnowledgeReadiness;
  scope: KnowledgeBaseScope;
  trashed: boolean;
  trashedAt: string | null;
  updatedAt: string;
  version: number;
}>;

export type KnowledgeBasePublication = Readonly<{
  groupId: string | null;
  groupName: string | null;
  id: string;
  scope: "group" | "installation" | "project";
  updatedAt: string;
}>;

export type KnowledgeBaseDetail = KnowledgeBaseSummary & Readonly<{
  publications: KnowledgeBasePublication[] | null;
}>;

export type KnowledgeBaseListResponse = Readonly<{
  knowledgeBases: KnowledgeBaseSummary[];
  publishableGroups: Array<Readonly<{ id: string; name: string }>>;
  viewer: Readonly<{
    canCreate: boolean;
    canPublishInstallation: boolean;
    maxUploadBytes: number;
  }>;
}>;

export type KnowledgeBaseDetailResponse = Readonly<{
  knowledgeBase: KnowledgeBaseDetail;
}>;

export type KnowledgeBasePublicationResponse = Readonly<{
  publication: KnowledgeBasePublication;
}>;

export const KNOWLEDGE_SOURCE_NAME_MAX_LENGTH = 512;
export const KNOWLEDGE_SOURCE_DESCRIPTION_MAX_LENGTH = 2000;
export const KNOWLEDGE_SOURCE_TAG_MAX_COUNT = 20;
export const KNOWLEDGE_SOURCE_TAG_MAX_LENGTH = 64;
export const KNOWLEDGE_SOURCE_PAGE_SIZE = 25;
export const KNOWLEDGE_SOURCE_PAGE_SIZE_MAX = 100;
export const KNOWLEDGE_SOURCE_SEARCH_MAX_LENGTH = 200;
export const KNOWLEDGE_SOURCE_MEMBERSHIP_MAX_BASES = 50;

export type KnowledgeSourceFilter = "all" | "shared" | "trash" | "yours";

export type KnowledgeLifecycleInput = Readonly<{
  expectedVersion: number;
}>;

export type KnowledgeDeletionResponse = Readonly<{
  status: "pending";
}>;

export type KnowledgeSourceReadiness = Readonly<{
  state: "needs_attention" | "processing" | "ready";
  supportReference: string | null;
  warningCodes: KnowledgeProcessingWarningCode[];
}>;

export type KnowledgeSourceVersionSummary = Readonly<{
  byteSize: number;
  createdAt: string;
  fileName: string;
  isCurrent: boolean;
  isPending: boolean;
  pageCount: number | null;
  readiness: KnowledgeSourceReadiness;
  versionNumber: number;
}>;

export type KnowledgeSourceBaseMembership = Readonly<{
  archived: boolean;
  id: string;
  name: string;
}>;

export type KnowledgeSourceSummary = Readonly<{
  canReprocess: boolean;
  currentVersion: KnowledgeSourceVersionSummary | null;
  deletionPending: boolean;
  description: string;
  id: string;
  membershipCount: number;
  name: string;
  owned: boolean;
  ownerDisplayName: string;
  purgeScheduledAt: string | null;
  readiness: KnowledgeSourceReadiness;
  replacement: Readonly<{
    state: "needs_attention" | "none" | "processing";
    supportReference: string | null;
  }>;
  tags: string[];
  trashed: boolean;
  trashedAt: string | null;
  updatedAt: string;
  version: number;
}>;

export type KnowledgeSourceDetail = KnowledgeSourceSummary & Readonly<{
  eligibleBases: KnowledgeSourceBaseMembership[];
  memberships: KnowledgeSourceBaseMembership[];
  versions: KnowledgeSourceVersionSummary[];
}>;

export type KnowledgeSourceListResponse = Readonly<{
  pagination: Readonly<{
    page: number;
    pageSize: number;
    query: string;
    totalItems: number;
    totalPages: number;
  }>;
  sources: KnowledgeSourceSummary[];
}>;

export type KnowledgeSourceDetailResponse = Readonly<{
  source: KnowledgeSourceDetail;
}>;

export type KnowledgeSourceUpdateInput = Readonly<{
  description?: string;
  expectedVersion: number;
  name?: string;
  tags?: string[];
}>;

export type KnowledgeSourceMembershipInput = Readonly<{
  baseIds: string[];
}>;

export type KnowledgeSourceMoveInput = Readonly<{
  fromBaseId: string;
  toBaseId: string;
}>;

export type KnowledgeSourceDuplicateInput = Readonly<{
  byteSize: number;
  checksum: string;
}>;

export type KnowledgeSourceDuplicateResponse = Readonly<{
  source: KnowledgeSourceSummary | null;
}>;

type DecodeResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ code: "knowledge_base_input_invalid"; ok: false }>;

type SourceDecodeResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ code: "knowledge_source_input_invalid"; ok: false }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function processingWarningCodes(value: unknown): value is KnowledgeProcessingWarningCode[] {
  return Array.isArray(value) && value.length <= KNOWLEDGE_PROCESSING_WARNING_CODES.length &&
    value.every((item): item is KnowledgeProcessingWarningCode =>
      typeof item === "string" &&
      KNOWLEDGE_PROCESSING_WARNING_CODES.includes(item as KnowledgeProcessingWarningCode)
    ) && new Set(value).size === value.length;
}

function allowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizedName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized &&
    normalized.length <= KNOWLEDGE_BASE_NAME_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function normalizedDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= KNOWLEDGE_BASE_DESCRIPTION_MAX_LENGTH && !/\u0000/u.test(normalized)
    ? normalized
    : null;
}

function normalizedSourceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= KNOWLEDGE_SOURCE_NAME_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function normalizedSourceDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= KNOWLEDGE_SOURCE_DESCRIPTION_MAX_LENGTH && !/\u0000/u.test(normalized)
    ? normalized
    : null;
}

function normalizedSourceTags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > KNOWLEDGE_SOURCE_TAG_MAX_COUNT) return null;
  const tags = value.map((tag) => typeof tag === "string" ? tag.trim() : null);
  if (tags.some((tag) => !tag || tag.length > KNOWLEDGE_SOURCE_TAG_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(tag))) return null;
  const normalized = tags as string[];
  return new Set(normalized.map((tag) => tag.toLocaleLowerCase())).size === normalized.length
    ? normalized
    : null;
}

function boundedId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function boundedDistinctIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map(boundedId);
  if (ids.some((id) => id === null)) return null;
  const normalized = ids as string[];
  return new Set(normalized).size === normalized.length ? normalized : null;
}

function canonicalKnowledgeSelection(
  mode: KnowledgeSelection["mode"],
  baseIds: string[],
  sourceIds: string[],
  inheritedFrom?: "assistant" | "project"
): KnowledgeSelection | null {
  if (baseIds.length + sourceIds.length > KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES) {
    return null;
  }
  if (mode === "explicit") {
    if (baseIds.length + sourceIds.length === 0) return null;
    return {
      baseIds,
      mode,
      sourceIds,
      version: KNOWLEDGE_SELECTION_VERSION
    };
  }
  if (baseIds.length > 0 || sourceIds.length > 0) return null;
  if (mode === "inherited") {
    return inheritedFrom === "assistant" || inheritedFrom === "project"
      ? {
          baseIds,
          inheritedFrom,
          mode,
          sourceIds,
          version: KNOWLEDGE_SELECTION_VERSION
        }
      : null;
  }
  if (inheritedFrom !== undefined) return null;
  return {
    baseIds,
    mode,
    sourceIds,
    version: KNOWLEDGE_SELECTION_VERSION
  };
}

/** Strict bounded decoder for new client/write contracts. */
export function decodeKnowledgeSelection(value: unknown): KnowledgePlanDecodeResult {
  if (!isRecord(value)) return { code: "knowledge_plan_invalid", ok: false };
  if (value.version !== KNOWLEDGE_SELECTION_VERSION ||
    typeof value.mode !== "string" || !Array.isArray(value.baseIds) ||
    !Array.isArray(value.sourceIds)) {
    return { code: "knowledge_plan_invalid", ok: false };
  }
  const inherited = value.mode === "inherited";
  if (!allowedKeys(value, inherited
    ? ["baseIds", "inheritedFrom", "mode", "sourceIds", "version"]
    : ["baseIds", "mode", "sourceIds", "version"])) {
    return { code: "knowledge_plan_invalid", ok: false };
  }
  if (value.mode !== "none" && value.mode !== "explicit" &&
    value.mode !== "all_my_knowledge" && value.mode !== "inherited") {
    return { code: "knowledge_plan_invalid", ok: false };
  }
  const baseIds = boundedDistinctIds(value.baseIds);
  const sourceIds = boundedDistinctIds(value.sourceIds);
  const plan = baseIds && sourceIds
    ? canonicalKnowledgeSelection(
        value.mode,
        baseIds,
        sourceIds,
        inherited && (value.inheritedFrom === "assistant" || value.inheritedFrom === "project")
          ? value.inheritedFrom
          : undefined
      )
    : null;
  return plan
    ? { ok: true, plan }
    : { code: "knowledge_plan_invalid", ok: false };
}

/**
 * Persisted/read decoder. The legacy `{ baseIds }` shape is normalized only
 * while reading pre-migration state; new client/write contracts use
 * `decodeKnowledgeSelection` and cannot create more legacy values.
 */
export function decodeKnowledgePlan(value: unknown): KnowledgePlanDecodeResult {
  if (isRecord(value) && allowedKeys(value, ["baseIds"]) && Array.isArray(value.baseIds)) {
    const baseIds = boundedDistinctIds(value.baseIds);
    const plan = baseIds === null
      ? null
      : canonicalKnowledgeSelection(baseIds.length > 0 ? "explicit" : "none", baseIds, []);
    return plan
      ? { ok: true, plan }
      : { code: "knowledge_plan_invalid", ok: false };
  }
  return decodeKnowledgeSelection(value);
}

export function explicitKnowledgeSelection(input: Readonly<{
  baseIds?: readonly string[];
  sourceIds?: readonly string[];
}>): KnowledgeSelection {
  const decoded = decodeKnowledgeSelection({
    baseIds: [...(input.baseIds ?? [])],
    mode: (input.baseIds?.length ?? 0) + (input.sourceIds?.length ?? 0) > 0
      ? "explicit"
      : "none",
    sourceIds: [...(input.sourceIds ?? [])],
    version: KNOWLEDGE_SELECTION_VERSION
  });
  if (!decoded.ok) throw new Error("knowledge_selection_invalid");
  return decoded.plan;
}

export function allMyKnowledgeSelection(): KnowledgeSelection {
  return {
    baseIds: [],
    mode: "all_my_knowledge",
    sourceIds: [],
    version: KNOWLEDGE_SELECTION_VERSION
  };
}

export function inheritedKnowledgeSelection(
  inheritedFrom: "assistant" | "project"
): KnowledgeSelection {
  return {
    baseIds: [],
    inheritedFrom,
    mode: "inherited",
    sourceIds: [],
    version: KNOWLEDGE_SELECTION_VERSION
  };
}

export function knowledgeSelectionHasResources(selection: KnowledgeSelection): boolean {
  return selection.mode !== "none";
}

export function decodeKnowledgeBaseCreate(value: unknown): DecodeResult<KnowledgeBaseCreateInput> {
  if (!isRecord(value) || !allowedKeys(value, ["description", "name"])) {
    return { code: "knowledge_base_input_invalid", ok: false };
  }
  const name = normalizedName(value.name);
  const description = normalizedDescription(value.description ?? "");
  if (!name || description === null) {
    return { code: "knowledge_base_input_invalid", ok: false };
  }
  return {
    ok: true,
    value: { description, name }
};
}

export function decodeKnowledgeBaseUpdate(value: unknown): DecodeResult<KnowledgeBaseUpdateInput> {
  if (
    !isRecord(value) ||
    !allowedKeys(value, ["archived", "description", "expectedVersion", "name"]) ||
    !Number.isSafeInteger(value.expectedVersion) ||
    Number(value.expectedVersion) < 1
  ) {
    return { code: "knowledge_base_input_invalid", ok: false };
  }
  const hasName = Object.hasOwn(value, "name");
  const hasDescription = Object.hasOwn(value, "description");
  const hasArchived = Object.hasOwn(value, "archived");
  if (!hasName && !hasDescription && !hasArchived) {
    return { code: "knowledge_base_input_invalid", ok: false };
  }
  const name = hasName ? normalizedName(value.name) : undefined;
  const description = hasDescription ? normalizedDescription(value.description) : undefined;
  if (
    (hasName && !name) ||
    (hasDescription && description === null) ||
    (hasArchived && typeof value.archived !== "boolean")
  ) {
    return { code: "knowledge_base_input_invalid", ok: false };
  }
  return {
    ok: true,
    value: {
      ...(hasArchived ? { archived: value.archived as boolean } : {}),
      ...(hasDescription ? { description: description! } : {}),
      expectedVersion: Number(value.expectedVersion),
      ...(hasName ? { name: name! } : {})
    }
  };
}

export function decodeKnowledgeBasePublication(
  value: unknown
): DecodeResult<KnowledgeBasePublicationInput> {
  if (!isRecord(value) || !allowedKeys(value, ["groupId", "scope"])) {
    return { code: "knowledge_base_input_invalid", ok: false };
  }
  if (value.scope === "installation" && (value.groupId === null || value.groupId === undefined)) {
    return { ok: true, value: { groupId: null, scope: "installation" } };
  }
  const groupId = boundedId(value.groupId);
  return value.scope === "group" && groupId
    ? { ok: true, value: { groupId, scope: "group" } }
    : { code: "knowledge_base_input_invalid", ok: false };
}

export function decodeKnowledgeBaseLifecycle(
  value: unknown
): DecodeResult<KnowledgeLifecycleInput> {
  return isRecord(value) && allowedKeys(value, ["expectedVersion"]) &&
    Number.isSafeInteger(value.expectedVersion) && Number(value.expectedVersion) >= 1
    ? { ok: true, value: { expectedVersion: Number(value.expectedVersion) } }
    : { code: "knowledge_base_input_invalid", ok: false };
}

export function decodeKnowledgeSourceLifecycle(
  value: unknown
): SourceDecodeResult<KnowledgeLifecycleInput> {
  return isRecord(value) && allowedKeys(value, ["expectedVersion"]) &&
    Number.isSafeInteger(value.expectedVersion) && Number(value.expectedVersion) >= 1
    ? { ok: true, value: { expectedVersion: Number(value.expectedVersion) } }
    : { code: "knowledge_source_input_invalid", ok: false };
}

export function decodeKnowledgeSourceUpdate(
  value: unknown
): SourceDecodeResult<KnowledgeSourceUpdateInput> {
  if (
    !isRecord(value) ||
    !allowedKeys(value, ["description", "expectedVersion", "name", "tags"]) ||
    !Number.isSafeInteger(value.expectedVersion) ||
    Number(value.expectedVersion) < 1
  ) {
    return { code: "knowledge_source_input_invalid", ok: false };
  }
  const hasDescription = Object.hasOwn(value, "description");
  const hasName = Object.hasOwn(value, "name");
  const hasTags = Object.hasOwn(value, "tags");
  if (!hasDescription && !hasName && !hasTags) {
    return { code: "knowledge_source_input_invalid", ok: false };
  }
  const description = hasDescription ? normalizedSourceDescription(value.description) : undefined;
  const name = hasName ? normalizedSourceName(value.name) : undefined;
  const tags = hasTags ? normalizedSourceTags(value.tags) : undefined;
  if (
    (hasDescription && description === null) ||
    (hasName && name === null) ||
    (hasTags && tags === null)
  ) {
    return { code: "knowledge_source_input_invalid", ok: false };
  }
  return {
    ok: true,
    value: {
      ...(hasDescription ? { description: description! } : {}),
      expectedVersion: Number(value.expectedVersion),
      ...(hasName ? { name: name! } : {}),
      ...(hasTags ? { tags: tags! } : {})
    }
  };
}

export function decodeKnowledgeSourceMembership(
  value: unknown
): SourceDecodeResult<KnowledgeSourceMembershipInput> {
  if (!isRecord(value) || !allowedKeys(value, ["baseIds"]) || !Array.isArray(value.baseIds) ||
    value.baseIds.length < 1 || value.baseIds.length > KNOWLEDGE_SOURCE_MEMBERSHIP_MAX_BASES) {
    return { code: "knowledge_source_input_invalid", ok: false };
  }
  const baseIds = value.baseIds.map(boundedId);
  if (baseIds.some((id) => id === null) || new Set(baseIds).size !== baseIds.length) {
    return { code: "knowledge_source_input_invalid", ok: false };
  }
  return { ok: true, value: { baseIds: baseIds as string[] } };
}

export function decodeKnowledgeSourceMove(
  value: unknown
): SourceDecodeResult<KnowledgeSourceMoveInput> {
  if (!isRecord(value) || !allowedKeys(value, ["fromBaseId", "toBaseId"])) {
    return { code: "knowledge_source_input_invalid", ok: false };
  }
  const fromBaseId = boundedId(value.fromBaseId);
  const toBaseId = boundedId(value.toBaseId);
  return fromBaseId && toBaseId && fromBaseId !== toBaseId
    ? { ok: true, value: { fromBaseId, toBaseId } }
    : { code: "knowledge_source_input_invalid", ok: false };
}

export function decodeKnowledgeSourceDuplicate(
  value: unknown
): SourceDecodeResult<KnowledgeSourceDuplicateInput> {
  if (!isRecord(value) || !allowedKeys(value, ["byteSize", "checksum"]) ||
    !Number.isSafeInteger(value.byteSize) || Number(value.byteSize) < 0 ||
    typeof value.checksum !== "string" || !/^[0-9a-f]{64}$/u.test(value.checksum)) {
    return { code: "knowledge_source_input_invalid", ok: false };
  }
  return {
    ok: true,
    value: { byteSize: Number(value.byteSize), checksum: value.checksum }
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function isoDate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function supportReference(value: unknown): value is string | null {
  return value === null || typeof value === "string" && /^K-[A-F0-9]{12}$/u.test(value);
}

function decodeKnowledgeBaseScope(value: unknown): KnowledgeBaseScope | null {
  if (!isRecord(value)) return null;
  if (value.kind === "owner" || value.kind === "installation") {
    if (!allowedKeys(value, ["kind"])) return null;
    return { kind: value.kind };
  }
  if (
    !allowedKeys(value, ["groupNames", "kind"]) ||
    value.kind !== "group" ||
    !Array.isArray(value.groupNames) ||
    value.groupNames.length === 0 ||
    !value.groupNames.every(nonEmptyString)
  ) {
    return null;
  }
  return { groupNames: value.groupNames, kind: "group" };
}

function decodeKnowledgeReadiness(value: unknown): KnowledgeReadiness | null {
  if (!isRecord(value) || !allowedKeys(value, [
    "attentionSources",
    "processingSources",
    "readySources",
    "state",
    "supportReference",
    "totalSources"
  ])) return null;
  const state = value.state;
  if (
    state !== "archived" && state !== "empty" && state !== "needs_attention" &&
    state !== "processing" && state !== "ready" && state !== "trashed"
  ) return null;
  if (!safeInteger(value.attentionSources) || !safeInteger(value.processingSources) ||
    !safeInteger(value.readySources) || !safeInteger(value.totalSources) ||
    !supportReference(value.supportReference)) return null;
  const attentionSources = Number(value.attentionSources);
  const processingSources = Number(value.processingSources);
  const readySources = Number(value.readySources);
  const totalSources = Number(value.totalSources);
  if (
    attentionSources + processingSources + readySources !== totalSources ||
    (state === "empty" && totalSources !== 0) ||
    (state === "ready" && (totalSources === 0 || readySources !== totalSources)) ||
    (state === "processing" && (processingSources === 0 || attentionSources !== 0)) ||
    (state === "needs_attention" && attentionSources === 0) ||
    (state === "needs_attention") !== (value.supportReference !== null)
  ) return null;
  return {
    attentionSources,
    processingSources,
    readySources,
    state,
    supportReference: value.supportReference,
    totalSources
  };
}

function decodeKnowledgeBaseSummaryValue(
  value: unknown,
  detail: boolean
): KnowledgeBaseSummary | null {
  if (!isRecord(value) || !allowedKeys(value, [
    "archived",
    "deletionPending",
    "description",
    "sourceCount",
    "id",
    "name",
    "owned",
    "ownerDisplayName",
    "purgeScheduledAt",
    ...(detail ? ["publications"] : []),
    "readiness",
    "scope",
    "trashed",
    "trashedAt",
    "updatedAt",
    "version"
  ])) return null;
  const scope = decodeKnowledgeBaseScope(value.scope);
  const readiness = decodeKnowledgeReadiness(value.readiness);
  if (
    !scope ||
    !readiness ||
    typeof value.archived !== "boolean" ||
    typeof value.deletionPending !== "boolean" ||
    typeof value.description !== "string" ||
    !safeInteger(value.sourceCount) ||
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.name) ||
    typeof value.owned !== "boolean" ||
    typeof value.ownerDisplayName !== "string" ||
    value.purgeScheduledAt !== null && !isoDate(value.purgeScheduledAt) ||
    typeof value.trashed !== "boolean" ||
    value.trashedAt !== null && !isoDate(value.trashedAt) ||
    !isoDate(value.updatedAt) ||
    !safeInteger(value.version, 1) ||
    value.sourceCount !== readiness.totalSources ||
    value.trashed !== (readiness.state === "trashed") ||
    value.trashed !== (value.trashedAt !== null) ||
    value.trashed !== (value.purgeScheduledAt !== null) ||
    value.trashedAt !== null && value.purgeScheduledAt !== null &&
      Date.parse(value.purgeScheduledAt) <= Date.parse(value.trashedAt) ||
    (!value.trashed && value.archived !== (readiness.state === "archived")) ||
    value.deletionPending && !value.trashed ||
    value.owned !== (scope.kind === "owner")
  ) {
    return null;
  }
  return {
    archived: value.archived,
    deletionPending: value.deletionPending,
    description: value.description,
    sourceCount: value.sourceCount,
    id: value.id,
    name: value.name,
    owned: value.owned,
    ownerDisplayName: value.ownerDisplayName,
    purgeScheduledAt: value.purgeScheduledAt,
    readiness,
    scope,
    trashed: value.trashed,
    trashedAt: value.trashedAt,
    updatedAt: value.updatedAt,
    version: value.version
  };
}

export function decodeKnowledgeBaseSummary(value: unknown): KnowledgeBaseSummary | null {
  return decodeKnowledgeBaseSummaryValue(value, false);
}

function decodeKnowledgeBasePublicationValue(
  value: unknown
): KnowledgeBasePublication | null {
  if (
    !isRecord(value) ||
    !allowedKeys(value, ["groupId", "groupName", "id", "scope", "updatedAt"]) ||
    !stringOrNull(value.groupId) ||
    !stringOrNull(value.groupName) ||
    !nonEmptyString(value.id) ||
    (value.scope !== "group" && value.scope !== "installation" && value.scope !== "project") ||
    !isoDate(value.updatedAt) ||
    (value.scope === "group" && (!nonEmptyString(value.groupId) || !nonEmptyString(value.groupName))) ||
    ((value.scope === "installation" || value.scope === "project") &&
      (value.groupId !== null || value.groupName !== null))
  ) {
    return null;
  }
  return {
    groupId: value.groupId,
    groupName: value.groupName,
    id: value.id,
    scope: value.scope,
    updatedAt: value.updatedAt
  };
}

export function decodeKnowledgeBaseDetail(value: unknown): KnowledgeBaseDetail | null {
  const summary = decodeKnowledgeBaseSummaryValue(value, true);
  if (!summary || !isRecord(value)) return null;
  let publications: KnowledgeBasePublication[] | null = null;
  if (value.publications !== null) {
    if (!Array.isArray(value.publications)) return null;
    const decoded = value.publications.map(decodeKnowledgeBasePublicationValue);
    if (
      decoded.some((entry) => entry === null) ||
      new Set(decoded.map((entry) => entry?.id)).size !== decoded.length
    ) return null;
    publications = decoded as KnowledgeBasePublication[];
  }
  if (summary.owned) {
    if (publications === null) return null;
  } else if (publications !== null) {
    return null;
  }
  return { ...summary, publications };
}

export function decodeKnowledgeBaseListResponse(
  value: unknown
): KnowledgeBaseListResponse | null {
  if (
    !isRecord(value) ||
    !allowedKeys(value, ["knowledgeBases", "publishableGroups", "viewer"]) ||
    !Array.isArray(value.knowledgeBases) ||
    !Array.isArray(value.publishableGroups) ||
    !isRecord(value.viewer) ||
    !allowedKeys(value.viewer, ["canCreate", "canPublishInstallation", "maxUploadBytes"]) ||
    typeof value.viewer.canCreate !== "boolean" ||
    typeof value.viewer.canPublishInstallation !== "boolean" ||
    !safeInteger(value.viewer.maxUploadBytes) ||
    value.viewer.maxUploadBytes <= 0
  ) {
    return null;
  }
  const knowledgeBases = value.knowledgeBases.map(decodeKnowledgeBaseSummary);
  if (
    knowledgeBases.some((knowledgeBase) => knowledgeBase === null) ||
    new Set(knowledgeBases.map((knowledgeBase) => knowledgeBase?.id)).size !== knowledgeBases.length
  ) {
    return null;
  }
  const publishableGroups: Array<{ id: string; name: string }> = [];
  for (const group of value.publishableGroups) {
    if (!isRecord(group) || !allowedKeys(group, ["id", "name"]) ||
      !nonEmptyString(group.id) || !nonEmptyString(group.name)) {
      return null;
    }
    publishableGroups.push({ id: group.id, name: group.name });
  }
  if (new Set(publishableGroups.map((group) => group.id)).size !== publishableGroups.length) {
    return null;
  }
  return {
    knowledgeBases: knowledgeBases as KnowledgeBaseSummary[],
    publishableGroups,
    viewer: {
      canCreate: value.viewer.canCreate,
      canPublishInstallation: value.viewer.canPublishInstallation,
      maxUploadBytes: value.viewer.maxUploadBytes
    }
  };
}

export function decodeKnowledgeBaseDetailResponse(
  value: unknown
): KnowledgeBaseDetailResponse | null {
  if (!isRecord(value) || !allowedKeys(value, ["knowledgeBase"])) return null;
  const knowledgeBase = decodeKnowledgeBaseDetail(value.knowledgeBase);
  return knowledgeBase ? { knowledgeBase } : null;
}

export function decodeKnowledgeBasePublicationResponse(
  value: unknown
): KnowledgeBasePublicationResponse | null {
  if (!isRecord(value) || !allowedKeys(value, ["publication"])) return null;
  const publication = decodeKnowledgeBasePublicationValue(value.publication);
  return publication ? { publication } : null;
}

function decodeKnowledgeSourceReadiness(value: unknown): KnowledgeSourceReadiness | null {
  if (!isRecord(value) || !allowedKeys(value, ["state", "supportReference", "warningCodes"]) ||
    (value.state !== "needs_attention" && value.state !== "processing" && value.state !== "ready") ||
    !supportReference(value.supportReference) ||
    !processingWarningCodes(value.warningCodes) ||
    (value.state !== "ready" && value.warningCodes.length > 0) ||
    (value.state === "needs_attention") !== (value.supportReference !== null)) {
    return null;
  }
  return {
    state: value.state,
    supportReference: value.supportReference,
    warningCodes: value.warningCodes
  };
}

function decodeKnowledgeSourceVersion(value: unknown): KnowledgeSourceVersionSummary | null {
  if (!isRecord(value) || !allowedKeys(value, [
    "byteSize",
    "createdAt",
    "fileName",
    "isCurrent",
    "isPending",
    "pageCount",
    "readiness",
    "versionNumber"
  ])) return null;
  const readiness = decodeKnowledgeSourceReadiness(value.readiness);
  if (!readiness || !safeInteger(value.byteSize) || !isoDate(value.createdAt) ||
    !nonEmptyString(value.fileName) || typeof value.isCurrent !== "boolean" ||
    typeof value.isPending !== "boolean" || value.isCurrent && value.isPending ||
    !(value.pageCount === null || safeInteger(value.pageCount)) ||
    !safeInteger(value.versionNumber, 1)) return null;
  return {
    byteSize: value.byteSize,
    createdAt: value.createdAt,
    fileName: value.fileName,
    isCurrent: value.isCurrent,
    isPending: value.isPending,
    pageCount: value.pageCount,
    readiness,
    versionNumber: value.versionNumber
  };
}

function decodeKnowledgeSourceBaseMembership(value: unknown): KnowledgeSourceBaseMembership | null {
  if (!isRecord(value) || !allowedKeys(value, ["archived", "id", "name"]) ||
    typeof value.archived !== "boolean" || !nonEmptyString(value.id) ||
    !nonEmptyString(value.name)) return null;
  return { archived: value.archived, id: value.id, name: value.name };
}

function decodeKnowledgeSourceSummaryValue(
  value: unknown,
  detail: boolean
): KnowledgeSourceSummary | null {
  if (!isRecord(value) || !allowedKeys(value, [
    "canReprocess",
    "currentVersion",
    "deletionPending",
    "description",
    ...(detail ? ["eligibleBases", "memberships"] : []),
    "id",
    "membershipCount",
    "name",
    "owned",
    "ownerDisplayName",
    "purgeScheduledAt",
    "readiness",
    "replacement",
    "tags",
    "trashed",
    "trashedAt",
    "updatedAt",
    "version",
    ...(detail ? ["versions"] : [])
  ])) return null;
  const currentVersion = value.currentVersion === null
    ? null
    : decodeKnowledgeSourceVersion(value.currentVersion);
  const readiness = decodeKnowledgeSourceReadiness(value.readiness);
  if (!isRecord(value.replacement) ||
    !allowedKeys(value.replacement, ["state", "supportReference"])) return null;
  const replacementState = value.replacement.state;
  const replacementSupport = value.replacement.supportReference;
  if (!currentVersion && value.currentVersion !== null || !readiness ||
    typeof value.canReprocess !== "boolean" ||
    typeof value.deletionPending !== "boolean" ||
    typeof value.description !== "string" || !nonEmptyString(value.id) ||
    !safeInteger(value.membershipCount) || !nonEmptyString(value.name) ||
    typeof value.owned !== "boolean" || typeof value.ownerDisplayName !== "string" ||
    value.purgeScheduledAt !== null && !isoDate(value.purgeScheduledAt) ||
    (replacementState !== "needs_attention" && replacementState !== "none" &&
      replacementState !== "processing") || !supportReference(replacementSupport) ||
    (replacementState === "needs_attention") !== (replacementSupport !== null) ||
    !Array.isArray(value.tags) || value.tags.length > KNOWLEDGE_SOURCE_TAG_MAX_COUNT ||
    !value.tags.every((tag) => nonEmptyString(tag) && tag.length <= KNOWLEDGE_SOURCE_TAG_MAX_LENGTH) ||
    new Set(value.tags.map((tag) => String(tag).toLocaleLowerCase())).size !== value.tags.length ||
    typeof value.trashed !== "boolean" || value.deletionPending && !value.trashed ||
    value.trashedAt !== null && !isoDate(value.trashedAt) ||
    value.trashed !== (value.trashedAt !== null) ||
    value.trashed !== (value.purgeScheduledAt !== null) ||
    value.trashedAt !== null && value.purgeScheduledAt !== null &&
      Date.parse(value.purgeScheduledAt) <= Date.parse(value.trashedAt) ||
    !isoDate(value.updatedAt) || !safeInteger(value.version, 1) ||
    (readiness.state === "ready") !== (currentVersion?.readiness.state === "ready") ||
    currentVersion?.isCurrent === false || currentVersion?.isPending === true) {
    return null;
  }
  return {
    canReprocess: value.canReprocess,
    currentVersion,
    deletionPending: value.deletionPending,
    description: value.description,
    id: value.id,
    membershipCount: value.membershipCount,
    name: value.name,
    owned: value.owned,
    ownerDisplayName: value.ownerDisplayName,
    purgeScheduledAt: value.purgeScheduledAt,
    readiness,
    replacement: { state: replacementState, supportReference: replacementSupport },
    tags: value.tags as string[],
    trashed: value.trashed,
    trashedAt: value.trashedAt,
    updatedAt: value.updatedAt,
    version: value.version
  };
}

export function decodeKnowledgeSourceSummary(value: unknown): KnowledgeSourceSummary | null {
  return decodeKnowledgeSourceSummaryValue(value, false);
}

export function decodeKnowledgeSourceDetail(value: unknown): KnowledgeSourceDetail | null {
  const summary = decodeKnowledgeSourceSummaryValue(value, true);
  if (!summary || !isRecord(value) || !Array.isArray(value.eligibleBases) ||
    !Array.isArray(value.memberships) || !Array.isArray(value.versions)) return null;
  const eligibleBases = value.eligibleBases.map(decodeKnowledgeSourceBaseMembership);
  const memberships = value.memberships.map(decodeKnowledgeSourceBaseMembership);
  const versions = value.versions.map(decodeKnowledgeSourceVersion);
  if (eligibleBases.some((base) => base === null) || memberships.some((base) => base === null) ||
    versions.some((version) => version === null)) return null;
  const eligibleIds = eligibleBases.map((base) => base!.id);
  const membershipIds = memberships.map((base) => base!.id);
  const versionNumbers = versions.map((version) => version!.versionNumber);
  if (new Set(eligibleIds).size !== eligibleIds.length ||
    new Set(membershipIds).size !== membershipIds.length ||
    eligibleIds.some((id) => membershipIds.includes(id)) ||
    new Set(versionNumbers).size !== versionNumbers.length ||
    summary.membershipCount !== memberships.length ||
    (!summary.owned && (eligibleBases.length > 0 || versions.length > 1)) ||
    versions.filter((version) => version?.isCurrent).length !== (summary.currentVersion ? 1 : 0) ||
    (summary.currentVersion && !versions.some((version) =>
      version?.isCurrent && version.versionNumber === summary.currentVersion?.versionNumber))) {
    return null;
  }
  return {
    ...summary,
    eligibleBases: eligibleBases as KnowledgeSourceBaseMembership[],
    memberships: memberships as KnowledgeSourceBaseMembership[],
    versions: versions as KnowledgeSourceVersionSummary[]
  };
}

export function decodeKnowledgeSourceListResponse(
  value: unknown
): KnowledgeSourceListResponse | null {
  if (!isRecord(value) || !allowedKeys(value, ["pagination", "sources"]) ||
    !isRecord(value.pagination) || !Array.isArray(value.sources)) return null;
  const sources = value.sources.map(decodeKnowledgeSourceSummary);
  const pagination = value.pagination;
  if (sources.some((source) => source === null) ||
    new Set(sources.map((source) => source?.id)).size !== sources.length ||
    !allowedKeys(pagination, ["page", "pageSize", "query", "totalItems", "totalPages"]) ||
    !safeInteger(pagination.page, 1) || !safeInteger(pagination.pageSize, 1) ||
    pagination.pageSize > KNOWLEDGE_SOURCE_PAGE_SIZE_MAX || typeof pagination.query !== "string" ||
    pagination.query !== pagination.query.trim() ||
    pagination.query.length > KNOWLEDGE_SOURCE_SEARCH_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(pagination.query) || !safeInteger(pagination.totalItems) ||
    !safeInteger(pagination.totalPages) ||
    pagination.totalPages !== (pagination.totalItems === 0
      ? 0
      : Math.ceil(pagination.totalItems / pagination.pageSize)) ||
    pagination.page > Math.max(1, pagination.totalPages) || sources.length > pagination.pageSize ||
    sources.length !== (pagination.totalItems === 0
      ? 0
      : Math.min(
          pagination.pageSize,
          pagination.totalItems - (pagination.page - 1) * pagination.pageSize
        ))) return null;
  return {
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      query: pagination.query,
      totalItems: pagination.totalItems,
      totalPages: pagination.totalPages
    },
    sources: sources as KnowledgeSourceSummary[]
  };
}

export function decodeKnowledgeSourceDetailResponse(
  value: unknown
): KnowledgeSourceDetailResponse | null {
  if (!isRecord(value) || !allowedKeys(value, ["source"])) return null;
  const source = decodeKnowledgeSourceDetail(value.source);
  return source ? { source } : null;
}

export function decodeKnowledgeSourceDuplicateResponse(
  value: unknown
): KnowledgeSourceDuplicateResponse | null {
  if (!isRecord(value) || !allowedKeys(value, ["source"])) return null;
  if (value.source === null) return { source: null };
  const source = decodeKnowledgeSourceSummary(value.source);
  return source ? { source } : null;
}

export function decodeKnowledgeDeletionResponse(
  value: unknown
): KnowledgeDeletionResponse | null {
  return isRecord(value) && allowedKeys(value, ["status"]) && value.status === "pending"
    ? { status: "pending" }
    : null;
}
