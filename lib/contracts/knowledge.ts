export const KNOWLEDGE_BASE_NAME_MAX_LENGTH = 80;
export const KNOWLEDGE_BASE_DESCRIPTION_MAX_LENGTH = 2000;
export const KNOWLEDGE_PLAN_MAX_BASES = 3;

export type KnowledgePlan = Readonly<{
  baseIds: string[];
}>;

export type KnowledgePlanDecodeResult =
  | Readonly<{ code: "knowledge_plan_invalid"; ok: false }>
  | Readonly<{ ok: true; plan: KnowledgePlan }>;

export type KnowledgeBaseCreateInput = Readonly<{
  description: string;
  embeddingDeploymentId: string;
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

export type KnowledgeEmbeddingDeployment = Readonly<{
  connectionDisplayName: string;
  id: string;
  indexSupported: boolean;
  modelDisplayName: string;
  provider: string;
  targetDimension: number;
}>;

export type KnowledgeBaseScope =
  | Readonly<{ kind: "owner" }>
  | Readonly<{ groupNames: string[]; kind: "group" }>
  | Readonly<{ kind: "installation" }>;

export type KnowledgeBaseSummary = Readonly<{
  activeGeneration: Readonly<{
    chunkingProfileVersion: number;
    embeddingDeployment: KnowledgeEmbeddingDeployment | null;
    embeddingDeploymentId: string | null;
    id: string;
    indexedContentRevision: number;
    targetDimension: number;
    vectorSpaceFingerprint: string;
  }>;
  archived: boolean;
  contentRevision: number;
  description: string;
  id: string;
  name: string;
  owned: boolean;
  ownerDisplayName: string;
  published: boolean;
  scope: KnowledgeBaseScope;
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
  documentCount: number;
  publications: KnowledgeBasePublication[] | null;
}>;

export type KnowledgeBaseListResponse = Readonly<{
  embeddingDeployments: KnowledgeEmbeddingDeployment[];
  knowledgeBases: KnowledgeBaseSummary[];
  publishableGroups: Array<Readonly<{ id: string; name: string }>>;
  viewer: Readonly<{ canPublishInstallation: boolean }>;
}>;

export type KnowledgeBaseDetailResponse = Readonly<{
  knowledgeBase: KnowledgeBaseDetail;
}>;

export type KnowledgeBasePublicationResponse = Readonly<{
  publication: KnowledgeBasePublication;
}>;

export type KnowledgeDocumentVersionStatus = Readonly<{
  byteSize: number;
  completedAt: string | null;
  createdAt: string;
  current: boolean;
  embeddedChunks: number;
  errorCode: string | null;
  fileName: string;
  id: string;
  mimeType: string;
  pageCount: number | null;
  payloadAvailable: boolean;
  state: "chunking" | "embedding" | "failed" | "parsing" | "queued" | "ready";
  totalChunks: number | null;
  updatedAt: string;
  versionNumber: number;
  visibleFromRevision: number | null;
  visibleUntilRevision: number | null;
}>;

export type KnowledgeDocumentStatus = Readonly<{
  archived: boolean;
  currentVersionId: string | null;
  id: string;
  versions: KnowledgeDocumentVersionStatus[];
}>;

export const KNOWLEDGE_DOCUMENT_PAGE_SIZE = 25;
export const KNOWLEDGE_DOCUMENT_PAGE_SIZE_MAX = 100;
export const KNOWLEDGE_DOCUMENT_SEARCH_MAX_LENGTH = 200;

export type KnowledgeDocumentPagination = Readonly<{
  page: number;
  pageSize: number;
  query: string;
  totalItems: number;
  totalPages: number;
}>;

export type KnowledgeReindexProgress = Readonly<{
  completedDocuments: number;
  createdAt: string;
  errorCode: string | null;
  failedDocuments: number;
  generationId: string;
  status: "active" | "building" | "failed" | "ready" | "retired";
  targetContentRevision: number;
  totalDocuments: number;
}>;

export type KnowledgeIngestionStatusResponse = Readonly<{
  documents: KnowledgeDocumentStatus[];
  owned: boolean;
  pagination: KnowledgeDocumentPagination;
  reindex: KnowledgeReindexProgress | null;
}>;

export type KnowledgeDocumentMutationResponse = Readonly<{
  document: KnowledgeDocumentStatus;
}>;

export type KnowledgeReindexInput = Readonly<{
  embeddingDeploymentId: string;
}>;

export type KnowledgeReindexResponse = Readonly<{
  reindex: KnowledgeReindexProgress;
}>;

type DecodeResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ code: "knowledge_base_input_invalid"; ok: false }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function boundedId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(normalized)
    ? normalized
    : null;
}

/** Strict bounded decoder shared by run requests and persisted defaults. */
export function decodeKnowledgePlan(value: unknown): KnowledgePlanDecodeResult {
  if (!isRecord(value) || !allowedKeys(value, ["baseIds"]) || !Array.isArray(value.baseIds)) {
    return { code: "knowledge_plan_invalid", ok: false };
  }
  if (value.baseIds.length > KNOWLEDGE_PLAN_MAX_BASES) {
    return { code: "knowledge_plan_invalid", ok: false };
  }
  const baseIds = value.baseIds.map(boundedId);
  if (baseIds.some((id) => id === null)) {
    return { code: "knowledge_plan_invalid", ok: false };
  }
  const normalized = baseIds as string[];
  if (new Set(normalized).size !== normalized.length) {
    return { code: "knowledge_plan_invalid", ok: false };
  }
  return { ok: true, plan: { baseIds: normalized } };
}

export function decodeKnowledgeBaseCreate(value: unknown): DecodeResult<KnowledgeBaseCreateInput> {
  if (!isRecord(value) || !allowedKeys(value, ["description", "embeddingDeploymentId", "name"])) {
    return { code: "knowledge_base_input_invalid", ok: false };
  }
  const name = normalizedName(value.name);
  const description = normalizedDescription(value.description ?? "");
  const embeddingDeploymentId = boundedId(value.embeddingDeploymentId);
  if (!name || description === null || !embeddingDeploymentId) {
    return { code: "knowledge_base_input_invalid", ok: false };
  }
  return {
    ok: true,
    value: { description, embeddingDeploymentId, name }
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

export function decodeKnowledgeReindex(value: unknown): DecodeResult<KnowledgeReindexInput> {
  if (!isRecord(value) || !allowedKeys(value, ["embeddingDeploymentId"])) {
    return { code: "knowledge_base_input_invalid", ok: false };
  }
  const embeddingDeploymentId = boundedId(value.embeddingDeploymentId);
  return embeddingDeploymentId
    ? { ok: true, value: { embeddingDeploymentId } }
    : { code: "knowledge_base_input_invalid", ok: false };
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

function decodeKnowledgeEmbeddingDeployment(
  value: unknown
): KnowledgeEmbeddingDeployment | null {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.connectionDisplayName) ||
    !nonEmptyString(value.id) ||
    typeof value.indexSupported !== "boolean" ||
    !nonEmptyString(value.modelDisplayName) ||
    !nonEmptyString(value.provider) ||
    !safeInteger(value.targetDimension, 1)
  ) {
    return null;
  }
  return {
    connectionDisplayName: value.connectionDisplayName,
    id: value.id,
    indexSupported: value.indexSupported,
    modelDisplayName: value.modelDisplayName,
    provider: value.provider,
    targetDimension: value.targetDimension
  };
}

function decodeKnowledgeBaseScope(value: unknown): KnowledgeBaseScope | null {
  if (!isRecord(value)) return null;
  if (value.kind === "owner" || value.kind === "installation") {
    return { kind: value.kind };
  }
  if (
    value.kind !== "group" ||
    !Array.isArray(value.groupNames) ||
    value.groupNames.length === 0 ||
    !value.groupNames.every(nonEmptyString)
  ) {
    return null;
  }
  return { groupNames: value.groupNames, kind: "group" };
}

export function decodeKnowledgeBaseSummary(value: unknown): KnowledgeBaseSummary | null {
  if (!isRecord(value) || !isRecord(value.activeGeneration)) return null;
  const scope = decodeKnowledgeBaseScope(value.scope);
  const deployment = value.activeGeneration.embeddingDeployment === null
    ? null
    : decodeKnowledgeEmbeddingDeployment(value.activeGeneration.embeddingDeployment);
  if (
    !scope ||
    typeof value.archived !== "boolean" ||
    !safeInteger(value.contentRevision) ||
    typeof value.description !== "string" ||
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.name) ||
    typeof value.owned !== "boolean" ||
    typeof value.ownerDisplayName !== "string" ||
    typeof value.published !== "boolean" ||
    !nonEmptyString(value.updatedAt) ||
    !safeInteger(value.version, 1) ||
    !safeInteger(value.activeGeneration.chunkingProfileVersion, 1) ||
    !stringOrNull(value.activeGeneration.embeddingDeploymentId) ||
    !nonEmptyString(value.activeGeneration.id) ||
    !safeInteger(value.activeGeneration.indexedContentRevision) ||
    !safeInteger(value.activeGeneration.targetDimension, 1) ||
    !nonEmptyString(value.activeGeneration.vectorSpaceFingerprint) ||
    (value.activeGeneration.embeddingDeployment !== null && deployment === null) ||
    (deployment === null) !== (value.activeGeneration.embeddingDeploymentId === null) ||
    (deployment !== null && value.activeGeneration.embeddingDeploymentId !== deployment.id) ||
    (deployment !== null && value.activeGeneration.targetDimension !== deployment.targetDimension) ||
    value.activeGeneration.indexedContentRevision > value.contentRevision ||
    value.owned !== (scope.kind === "owner")
  ) {
    return null;
  }
  return {
    activeGeneration: {
      chunkingProfileVersion: value.activeGeneration.chunkingProfileVersion,
      embeddingDeployment: deployment,
      embeddingDeploymentId: value.activeGeneration.embeddingDeploymentId,
      id: value.activeGeneration.id,
      indexedContentRevision: value.activeGeneration.indexedContentRevision,
      targetDimension: value.activeGeneration.targetDimension,
      vectorSpaceFingerprint: value.activeGeneration.vectorSpaceFingerprint
    },
    archived: value.archived,
    contentRevision: value.contentRevision,
    description: value.description,
    id: value.id,
    name: value.name,
    owned: value.owned,
    ownerDisplayName: value.ownerDisplayName,
    published: value.published,
    scope,
    updatedAt: value.updatedAt,
    version: value.version
  };
}

function decodeKnowledgeBasePublicationValue(
  value: unknown
): KnowledgeBasePublication | null {
  if (
    !isRecord(value) ||
    !stringOrNull(value.groupId) ||
    !stringOrNull(value.groupName) ||
    !nonEmptyString(value.id) ||
    (value.scope !== "group" && value.scope !== "installation" && value.scope !== "project") ||
    !nonEmptyString(value.updatedAt) ||
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
  const summary = decodeKnowledgeBaseSummary(value);
  if (!summary || !isRecord(value) || !safeInteger(value.documentCount)) return null;
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
    if (publications === null || summary.published !== (publications.length > 0)) return null;
  } else if (publications !== null) {
    return null;
  }
  return { ...summary, documentCount: value.documentCount, publications };
}

function decodeKnowledgeDocumentVersionStatus(
  value: unknown
): KnowledgeDocumentVersionStatus | null {
  if (!isRecord(value)) return null;
  const state = value.state;
  if (
    (state !== "chunking" &&
      state !== "embedding" &&
      state !== "failed" &&
      state !== "parsing" &&
      state !== "queued" &&
      state !== "ready") ||
    !safeInteger(value.byteSize) ||
    !stringOrNull(value.completedAt) ||
    !nonEmptyString(value.createdAt) ||
    typeof value.current !== "boolean" ||
    !safeInteger(value.embeddedChunks) ||
    !stringOrNull(value.errorCode) ||
    typeof value.fileName !== "string" ||
    !nonEmptyString(value.id) ||
    typeof value.mimeType !== "string" ||
    !(value.pageCount === null || safeInteger(value.pageCount)) ||
    typeof value.payloadAvailable !== "boolean" ||
    !(value.totalChunks === null || safeInteger(value.totalChunks)) ||
    !nonEmptyString(value.updatedAt) ||
    !safeInteger(value.versionNumber, 1) ||
    !(value.visibleFromRevision === null || safeInteger(value.visibleFromRevision)) ||
    !(value.visibleUntilRevision === null || safeInteger(value.visibleUntilRevision)) ||
    (typeof value.totalChunks === "number" && value.embeddedChunks > value.totalChunks)
  ) {
    return null;
  }
  return {
    byteSize: value.byteSize,
    completedAt: value.completedAt,
    createdAt: value.createdAt,
    current: value.current,
    embeddedChunks: value.embeddedChunks,
    errorCode: value.errorCode,
    fileName: value.fileName,
    id: value.id,
    mimeType: value.mimeType,
    pageCount: value.pageCount,
    payloadAvailable: value.payloadAvailable,
    state,
    totalChunks: value.totalChunks,
    updatedAt: value.updatedAt,
    versionNumber: value.versionNumber,
    visibleFromRevision: value.visibleFromRevision,
    visibleUntilRevision: value.visibleUntilRevision
  };
}

export function decodeKnowledgeDocumentStatus(value: unknown): KnowledgeDocumentStatus | null {
  if (
    !isRecord(value) ||
    typeof value.archived !== "boolean" ||
    !stringOrNull(value.currentVersionId) ||
    !nonEmptyString(value.id) ||
    !Array.isArray(value.versions)
  ) {
    return null;
  }
  const versions = value.versions.map(decodeKnowledgeDocumentVersionStatus);
  if (versions.some((version) => version === null)) return null;
  const decodedVersions = versions as KnowledgeDocumentVersionStatus[];
  const currentVersions = decodedVersions.filter((version) => version.current);
  if (
    new Set(decodedVersions.map((version) => version.id)).size !== decodedVersions.length ||
    new Set(decodedVersions.map((version) => version.versionNumber)).size !== decodedVersions.length ||
    (value.currentVersionId === null
      ? currentVersions.length !== 0
      : currentVersions.length !== 1 || currentVersions[0]?.id !== value.currentVersionId)
  ) {
    return null;
  }
  return {
    archived: value.archived,
    currentVersionId: value.currentVersionId,
    id: value.id,
    versions: decodedVersions
  };
}

function decodeKnowledgeReindexProgress(value: unknown): KnowledgeReindexProgress | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (
    (status !== "active" &&
      status !== "building" &&
      status !== "failed" &&
      status !== "ready" &&
      status !== "retired") ||
    !safeInteger(value.completedDocuments) ||
    !nonEmptyString(value.createdAt) ||
    !stringOrNull(value.errorCode) ||
    !safeInteger(value.failedDocuments) ||
    !nonEmptyString(value.generationId) ||
    !safeInteger(value.targetContentRevision) ||
    !safeInteger(value.totalDocuments) ||
    value.completedDocuments + value.failedDocuments > value.totalDocuments
  ) {
    return null;
  }
  return {
    completedDocuments: value.completedDocuments,
    createdAt: value.createdAt,
    errorCode: value.errorCode,
    failedDocuments: value.failedDocuments,
    generationId: value.generationId,
    status,
    targetContentRevision: value.targetContentRevision,
    totalDocuments: value.totalDocuments
  };
}

export function decodeKnowledgeBaseListResponse(
  value: unknown
): KnowledgeBaseListResponse | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.embeddingDeployments) ||
    !Array.isArray(value.knowledgeBases) ||
    !Array.isArray(value.publishableGroups) ||
    !isRecord(value.viewer) ||
    typeof value.viewer.canPublishInstallation !== "boolean"
  ) {
    return null;
  }
  const embeddingDeployments = value.embeddingDeployments.map(decodeKnowledgeEmbeddingDeployment);
  const knowledgeBases = value.knowledgeBases.map(decodeKnowledgeBaseSummary);
  if (
    embeddingDeployments.some((deployment) => deployment === null) ||
    knowledgeBases.some((knowledgeBase) => knowledgeBase === null) ||
    new Set(embeddingDeployments.map((deployment) => deployment?.id)).size !== embeddingDeployments.length ||
    new Set(knowledgeBases.map((knowledgeBase) => knowledgeBase?.id)).size !== knowledgeBases.length
  ) {
    return null;
  }
  const publishableGroups: Array<{ id: string; name: string }> = [];
  for (const group of value.publishableGroups) {
    if (!isRecord(group) || !nonEmptyString(group.id) || !nonEmptyString(group.name)) {
      return null;
    }
    publishableGroups.push({ id: group.id, name: group.name });
  }
  if (new Set(publishableGroups.map((group) => group.id)).size !== publishableGroups.length) {
    return null;
  }
  return {
    embeddingDeployments: embeddingDeployments as KnowledgeEmbeddingDeployment[],
    knowledgeBases: knowledgeBases as KnowledgeBaseSummary[],
    publishableGroups,
    viewer: { canPublishInstallation: value.viewer.canPublishInstallation }
  };
}

export function decodeKnowledgeBaseDetailResponse(
  value: unknown
): KnowledgeBaseDetailResponse | null {
  if (!isRecord(value)) return null;
  const knowledgeBase = decodeKnowledgeBaseDetail(value.knowledgeBase);
  return knowledgeBase ? { knowledgeBase } : null;
}

export function decodeKnowledgeBasePublicationResponse(
  value: unknown
): KnowledgeBasePublicationResponse | null {
  if (!isRecord(value)) return null;
  const publication = decodeKnowledgeBasePublicationValue(value.publication);
  return publication ? { publication } : null;
}

export function decodeKnowledgeIngestionStatusResponse(
  value: unknown
): KnowledgeIngestionStatusResponse | null {
  if (!isRecord(value) || !Array.isArray(value.documents) || typeof value.owned !== "boolean" ||
    !isRecord(value.pagination)) {
    return null;
  }
  const documents = value.documents.map(decodeKnowledgeDocumentStatus);
  const reindex = value.reindex === null ? null : decodeKnowledgeReindexProgress(value.reindex);
  const pagination = value.pagination;
  if (
    documents.some((document) => document === null) ||
    new Set(documents.map((document) => document?.id)).size !== documents.length ||
    (value.reindex !== null && !reindex) ||
    !safeInteger(pagination.page, 1) ||
    !safeInteger(pagination.pageSize, 1) ||
    pagination.pageSize > KNOWLEDGE_DOCUMENT_PAGE_SIZE_MAX ||
    typeof pagination.query !== "string" ||
    pagination.query !== pagination.query.trim() ||
    pagination.query.length > KNOWLEDGE_DOCUMENT_SEARCH_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(pagination.query) ||
    !safeInteger(pagination.totalItems) ||
    !safeInteger(pagination.totalPages) ||
    pagination.totalPages !== (pagination.totalItems === 0
      ? 0
      : Math.ceil(pagination.totalItems / pagination.pageSize)) ||
    pagination.page > Math.max(1, pagination.totalPages) ||
    documents.length > pagination.pageSize ||
    documents.length !== (pagination.totalItems === 0
      ? 0
      : Math.min(
          pagination.pageSize,
          pagination.totalItems - (pagination.page - 1) * pagination.pageSize
        ))
  ) {
    return null;
  }
  return {
    documents: documents as KnowledgeDocumentStatus[],
    owned: value.owned,
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      query: pagination.query,
      totalItems: pagination.totalItems,
      totalPages: pagination.totalPages
    },
    reindex
  };
}

export function decodeKnowledgeDocumentMutationResponse(
  value: unknown
): KnowledgeDocumentMutationResponse | null {
  if (!isRecord(value)) return null;
  const document = decodeKnowledgeDocumentStatus(value.document);
  return document ? { document } : null;
}

export function decodeKnowledgeReindexResponse(value: unknown): KnowledgeReindexResponse | null {
  if (!isRecord(value)) return null;
  const reindex = decodeKnowledgeReindexProgress(value.reindex);
  return reindex ? { reindex } : null;
}
