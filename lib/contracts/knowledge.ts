export const KNOWLEDGE_BASE_NAME_MAX_LENGTH = 80;
export const KNOWLEDGE_BASE_DESCRIPTION_MAX_LENGTH = 2000;

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
  scope: "group" | "installation";
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
