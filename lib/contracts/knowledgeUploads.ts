export const KNOWLEDGE_UPLOAD_CLIENT_ID_MAX_LENGTH = 128;
export const KNOWLEDGE_UPLOAD_FILE_NAME_MAX_LENGTH = 512;
export const KNOWLEDGE_UPLOAD_RESPONSE_MAX_ITEMS = 500;
export const KNOWLEDGE_UPLOAD_RESPONSE_MAX_PARTS = 64;
export const KNOWLEDGE_UPLOAD_ATTEMPT_MAX = 2_147_483_647;

export const KNOWLEDGE_UPLOAD_ITEM_STATES = Object.freeze([
  "queued",
  "uploading",
  "upload_complete",
  "processing",
  "ready",
  "ready_with_warnings",
  "needs_attention",
  "cancelled",
  "reused"
] as const);

export type KnowledgeUploadItemState = (typeof KNOWLEDGE_UPLOAD_ITEM_STATES)[number];

export type KnowledgeUploadBatchCreateInput = Readonly<{
  clientBatchId: string;
  files: Array<Readonly<{
    byteSize: number;
    checksumHint?: string;
    clientFileId: string;
    fileName: string;
    mimeType: string;
  }>>;
}>;

export type KnowledgeUploadAttemptInput = Readonly<{
  attemptNumber: number;
}>;

export type KnowledgeUploadPartCheckpointInput = Readonly<{
  attemptNumber: number;
  byteSize: number;
  etag: string;
}>;

export type KnowledgeUploadTransport =
  | Readonly<{
      kind: "proxy";
      uploadUrl: string;
    }>
  | Readonly<{
      kind: "multipart";
      parts: Array<Readonly<{
        byteOffset: number;
        byteSize: number;
        complete: boolean;
        partNumber: number;
        uploadUrl: string | null;
      }>>;
    }>;

export type KnowledgeUploadItem = Readonly<{
  attemptNumber: number;
  byteSize: number;
  clientFileId: string;
  failureCode: string | null;
  fileName: string;
  id: string;
  sourceId: string | null;
  state: KnowledgeUploadItemState;
  transport: KnowledgeUploadTransport | null;
  updatedAt: string;
  uploadedBytes: number;
}>;

export type KnowledgeUploadBatch = Readonly<{
  createdAt: string;
  id: string;
  items: KnowledgeUploadItem[];
  updatedAt: string;
}>;

export type KnowledgeUploadBatchResponse = Readonly<{
  batch: KnowledgeUploadBatch;
}>;

export type KnowledgeUploadBatchListResponse = Readonly<{
  batches: KnowledgeUploadBatch[];
}>;

type InputDecodeResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ code: "knowledge_upload_input_invalid"; ok: false }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedClientId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 &&
    value.length <= KNOWLEDGE_UPLOAD_CLIENT_ID_MAX_LENGTH &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value)
    ? value
    : null;
}

function safeFileName(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 &&
    value.length <= KNOWLEDGE_UPLOAD_FILE_NAME_MAX_LENGTH &&
    new TextEncoder().encode(value).byteLength <= 1_024 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function safeMimeType(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(value)
    ? value.toLowerCase()
    : null;
}

function checksum(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : null;
}

export function decodeKnowledgeUploadBatchCreate(
  value: unknown,
  maxFiles: number
): InputDecodeResult<KnowledgeUploadBatchCreateInput> {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 ||
    maxFiles > KNOWLEDGE_UPLOAD_RESPONSE_MAX_ITEMS || !isRecord(value) ||
    !allowedKeys(value, ["clientBatchId", "files"]) || !Array.isArray(value.files) ||
    value.files.length < 1 || value.files.length > maxFiles) {
    return { code: "knowledge_upload_input_invalid", ok: false };
  }
  const clientBatchId = boundedClientId(value.clientBatchId);
  if (!clientBatchId) return { code: "knowledge_upload_input_invalid", ok: false };
  const files: KnowledgeUploadBatchCreateInput["files"] = [];
  for (const candidate of value.files) {
    if (!isRecord(candidate) || !allowedKeys(candidate, [
      "byteSize",
      "checksumHint",
      "clientFileId",
      "fileName",
      "mimeType"
    ]) || !Number.isSafeInteger(candidate.byteSize) || Number(candidate.byteSize) < 1) {
      return { code: "knowledge_upload_input_invalid", ok: false };
    }
    const clientFileId = boundedClientId(candidate.clientFileId);
    const fileName = safeFileName(candidate.fileName);
    const mimeType = safeMimeType(candidate.mimeType);
    const checksumHint = candidate.checksumHint === undefined
      ? undefined
      : checksum(candidate.checksumHint);
    if (!clientFileId || !fileName || !mimeType ||
      (candidate.checksumHint !== undefined && !checksumHint)) {
      return { code: "knowledge_upload_input_invalid", ok: false };
    }
    files.push({
      byteSize: Number(candidate.byteSize),
      ...(checksumHint ? { checksumHint } : {}),
      clientFileId,
      fileName,
      mimeType
    });
  }
  if (new Set(files.map(({ clientFileId }) => clientFileId)).size !== files.length) {
    return { code: "knowledge_upload_input_invalid", ok: false };
  }
  return { ok: true, value: { clientBatchId, files } };
}

export function decodeKnowledgeUploadPartCheckpoint(
  value: unknown
): InputDecodeResult<KnowledgeUploadPartCheckpointInput> {
  if (!isRecord(value) || !allowedKeys(value, ["attemptNumber", "byteSize", "etag"]) ||
    !Number.isSafeInteger(value.attemptNumber) || Number(value.attemptNumber) < 1 ||
    Number(value.attemptNumber) > KNOWLEDGE_UPLOAD_ATTEMPT_MAX ||
    !Number.isSafeInteger(value.byteSize) || Number(value.byteSize) < 1 ||
    typeof value.etag !== "string" || value.etag.length < 1 || value.etag.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value.etag)) {
    return { code: "knowledge_upload_input_invalid", ok: false };
  }
  return {
    ok: true,
    value: {
      attemptNumber: Number(value.attemptNumber),
      byteSize: Number(value.byteSize),
      etag: value.etag
    }
  };
}

export function decodeKnowledgeUploadAttempt(
  value: unknown
): InputDecodeResult<KnowledgeUploadAttemptInput> {
  return isRecord(value) && allowedKeys(value, ["attemptNumber"]) &&
    Number.isSafeInteger(value.attemptNumber) && Number(value.attemptNumber) >= 1 &&
    Number(value.attemptNumber) <= KNOWLEDGE_UPLOAD_ATTEMPT_MAX
    ? { ok: true, value: { attemptNumber: Number(value.attemptNumber) } }
    : { code: "knowledge_upload_input_invalid", ok: false };
}

function isoDate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function nonEmptyString(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeUploadUrl(value: unknown, proxy: boolean): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192 || /\s/u.test(value)) {
    return false;
  }
  if (proxy) return value.startsWith("/api/") && !value.includes("#");
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.username === "" && parsed.password === "" && parsed.hash === "";
  } catch {
    return false;
  }
}

function decodeTransport(value: unknown, itemByteSize: number): KnowledgeUploadTransport | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "proxy") {
    return allowedKeys(value, ["kind", "uploadUrl"]) && safeUploadUrl(value.uploadUrl, true)
      ? { kind: "proxy", uploadUrl: value.uploadUrl }
      : null;
  }
  if (value.kind !== "multipart" || !allowedKeys(value, ["kind", "parts"]) ||
    !Array.isArray(value.parts) || value.parts.length < 1 ||
    value.parts.length > KNOWLEDGE_UPLOAD_RESPONSE_MAX_PARTS) return null;
  const parts: Extract<KnowledgeUploadTransport, { kind: "multipart" }>["parts"] = [];
  let expectedOffset = 0;
  for (const candidate of value.parts) {
    if (!isRecord(candidate) || !allowedKeys(candidate, [
      "byteOffset",
      "byteSize",
      "complete",
      "partNumber",
      "uploadUrl"
    ]) || !Number.isSafeInteger(candidate.byteOffset) || candidate.byteOffset !== expectedOffset ||
      !Number.isSafeInteger(candidate.byteSize) || Number(candidate.byteSize) < 1 ||
      !Number.isSafeInteger(candidate.partNumber) || Number(candidate.partNumber) !== parts.length + 1 ||
      typeof candidate.complete !== "boolean" ||
      (candidate.complete
        ? candidate.uploadUrl !== null
        : !safeUploadUrl(candidate.uploadUrl, false))) return null;
    const byteSize = Number(candidate.byteSize);
    parts.push({
      byteOffset: Number(candidate.byteOffset),
      byteSize,
      complete: candidate.complete,
      partNumber: Number(candidate.partNumber),
      uploadUrl: candidate.uploadUrl as string | null
    });
    expectedOffset += byteSize;
  }
  return expectedOffset === itemByteSize ? { kind: "multipart", parts } : null;
}

function decodeItem(value: unknown): KnowledgeUploadItem | null {
  if (!isRecord(value) || !allowedKeys(value, [
    "attemptNumber",
    "byteSize",
    "clientFileId",
    "failureCode",
    "fileName",
    "id",
    "sourceId",
    "state",
    "transport",
    "updatedAt",
    "uploadedBytes"
  ]) || !Number.isSafeInteger(value.attemptNumber) || Number(value.attemptNumber) < 1 ||
    Number(value.attemptNumber) > KNOWLEDGE_UPLOAD_ATTEMPT_MAX ||
    !Number.isSafeInteger(value.byteSize) || Number(value.byteSize) < 1 ||
    !boundedClientId(value.clientFileId) || !safeFileName(value.fileName) ||
    !nonEmptyString(value.id, 256) || !isoDate(value.updatedAt) ||
    !Number.isSafeInteger(value.uploadedBytes) || Number(value.uploadedBytes) < 0 ||
    Number(value.uploadedBytes) > Number(value.byteSize) ||
    !KNOWLEDGE_UPLOAD_ITEM_STATES.includes(value.state as KnowledgeUploadItemState) ||
    !(value.failureCode === null || typeof value.failureCode === "string" &&
      /^[a-z][a-z0-9_]{0,63}$/u.test(value.failureCode)) ||
    !(value.sourceId === null || nonEmptyString(value.sourceId, 256))) return null;
  const transport = value.transport === null
    ? null
    : decodeTransport(value.transport, Number(value.byteSize));
  if (value.transport !== null && !transport) return null;
  const state = value.state as KnowledgeUploadItemState;
  if ((state === "queued" || state === "uploading") !== (transport !== null) ||
    (state === "needs_attention") !== (value.failureCode !== null) ||
    ((state === "processing" || state === "ready" || state === "ready_with_warnings" ||
      state === "reused") && value.sourceId === null) ||
    ((state === "queued" || state === "uploading" || state === "upload_complete" ||
      state === "cancelled") && value.sourceId !== null)) return null;
  return {
    attemptNumber: Number(value.attemptNumber),
    byteSize: Number(value.byteSize),
    clientFileId: value.clientFileId as string,
    failureCode: value.failureCode,
    fileName: value.fileName as string,
    id: value.id,
    sourceId: value.sourceId,
    state,
    transport,
    updatedAt: value.updatedAt,
    uploadedBytes: Number(value.uploadedBytes)
  };
}

export function decodeKnowledgeUploadBatch(value: unknown): KnowledgeUploadBatch | null {
  if (!isRecord(value) || !allowedKeys(value, ["createdAt", "id", "items", "updatedAt"]) ||
    !nonEmptyString(value.id, 256) || !isoDate(value.createdAt) || !isoDate(value.updatedAt) ||
    !Array.isArray(value.items) || value.items.length < 1 ||
    value.items.length > KNOWLEDGE_UPLOAD_RESPONSE_MAX_ITEMS) return null;
  const items = value.items.map(decodeItem);
  if (items.some((item) => item === null) ||
    new Set(items.map((item) => item?.id)).size !== items.length ||
    new Set(items.map((item) => item?.clientFileId)).size !== items.length) return null;
  return {
    createdAt: value.createdAt,
    id: value.id,
    items: items as KnowledgeUploadItem[],
    updatedAt: value.updatedAt
  };
}

export function decodeKnowledgeUploadBatchResponse(
  value: unknown
): KnowledgeUploadBatchResponse | null {
  if (!isRecord(value) || !allowedKeys(value, ["batch"])) return null;
  const batch = decodeKnowledgeUploadBatch(value.batch);
  return batch ? { batch } : null;
}

export function decodeKnowledgeUploadBatchListResponse(
  value: unknown
): KnowledgeUploadBatchListResponse | null {
  if (!isRecord(value) || !allowedKeys(value, ["batches"]) || !Array.isArray(value.batches) ||
    value.batches.length > 20) return null;
  const batches = value.batches.map(decodeKnowledgeUploadBatch);
  if (batches.some((batch) => batch === null) ||
    new Set(batches.map((batch) => batch?.id)).size !== batches.length) return null;
  return { batches: batches as KnowledgeUploadBatch[] };
}
