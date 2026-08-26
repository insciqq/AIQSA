import { randomUUID } from "node:crypto";
import type {
  KnowledgeUploadBatch,
  KnowledgeUploadBatchCreateInput,
  KnowledgeUploadItem,
  KnowledgeUploadItemState,
  KnowledgeUploadTransport
} from "../../contracts/knowledgeUploads";
import { resolveDocumentParserRoute } from "../parsing";
import type {
  DirectMultipartUploadAdapter,
  StorageAdapter
} from "../uploads/storage";
import {
  UPLOAD_CONTENT_INSPECTION_NEEDLES,
  validateUpload,
  validateUploadInspection
} from "../uploads/validation";
import type { KnowledgeExtractionConfig } from "./knowledgeExtractionConfig";
import type { KnowledgeUploadConfig } from "./knowledgeUploadConfig";
import {
  knowledgeUploadAdmissionMatches,
  newKnowledgeUploadSettlementIds,
  type KnowledgeUploadAdmissionItem,
  type KnowledgeUploadBatchRecord,
  type KnowledgeUploadCleanup,
  type KnowledgeUploadItemRecord,
  type KnowledgeUploadPrivateTarget,
  type PrismaKnowledgeUploadRepository
} from "./uploadRepository";

export type KnowledgeUploadDeletionOutbox = Readonly<{
  complete(jobId: string): Promise<void>;
  stage(storageKey: string, multipartUploadId?: string | null): Promise<{ id: string }>;
}>;

export type KnowledgeUploadServiceDeps = Readonly<{
  deletionOutbox: KnowledgeUploadDeletionOutbox;
  kickProcessing?: () => void;
  repository: Pick<
    PrismaKnowledgeUploadRepository,
    | "cancel"
    | "claimProxyStream"
    | "checkpointPart"
    | "createBatch"
    | "getBatch"
    | "getByClientBatchId"
    | "getTarget"
    | "listBatches"
    | "markAttention"
    | "markStored"
    | "retry"
    | "settle"
    | "start"
  >;
  storage: StorageAdapter;
}>;

export type KnowledgeUploadServiceErrorCode =
  | "knowledge_base_not_available"
  | "knowledge_checksum_mismatch"
  | "knowledge_file_limit_exceeded"
  | "knowledge_storage_unavailable"
  | "knowledge_upload_conflict"
  | "knowledge_upload_input_invalid"
  | "knowledge_upload_not_available"
  | "knowledge_upload_session_expired"
  | "unsupported_type";

export class KnowledgeUploadServiceError extends Error {
  readonly code: KnowledgeUploadServiceErrorCode;

  constructor(code: KnowledgeUploadServiceErrorCode) {
    super(code);
    this.name = "KnowledgeUploadServiceError";
    this.code = code;
  }
}

function storageKey(): string {
  return `knowledge/objects/${randomUUID()}`;
}

function multipartParts(byteSize: number, partBytes: number) {
  const parts: Array<{ byteOffset: number; byteSize: number; partNumber: number }> = [];
  for (let byteOffset = 0, partNumber = 1; byteOffset < byteSize; partNumber += 1) {
    const currentBytes = Math.min(partBytes, byteSize - byteOffset);
    parts.push({ byteOffset, byteSize: currentBytes, partNumber });
    byteOffset += currentBytes;
  }
  return parts;
}

async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length && !failed) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await operation(values[index]!, index);
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
  }));
  if (failed) throw failure;
  return results;
}

function validateAdmission(
  input: KnowledgeUploadBatchCreateInput,
  extraction: KnowledgeExtractionConfig
): Array<Readonly<{
  byteSize: number;
  checksumHint: string | null;
  clientFileId: string;
  fileName: string;
  normalizedMimeType: string;
  suppliedMimeType: string;
}>> {
  return input.files.map((file) => {
    const validated = validateUpload({
      byteSize: file.byteSize,
      fileName: file.fileName,
      maxBytes: extraction.maxFileBytes,
      mimeType: file.mimeType,
      scope: "knowledge"
    });
    if (!validated.ok) {
      throw new KnowledgeUploadServiceError(
        validated.code === "file_too_large"
          ? "knowledge_file_limit_exceeded"
          : validated.code === "unsupported_type"
            ? "unsupported_type"
            : "knowledge_upload_input_invalid"
      );
    }
    if (!resolveDocumentParserRoute(file.fileName, validated.mimeType)) {
      throw new KnowledgeUploadServiceError("unsupported_type");
    }
    return {
      byteSize: file.byteSize,
      checksumHint: file.checksumHint ?? null,
      clientFileId: file.clientFileId,
      fileName: file.fileName,
      normalizedMimeType: validated.mimeType,
      suppliedMimeType: file.mimeType
    };
  });
}

export async function cleanupKnowledgeUploadObject(
  deps: KnowledgeUploadServiceDeps,
  cleanup: KnowledgeUploadCleanup
): Promise<void> {
  if (!cleanup.storageKey) return;
  let job: { id: string } | null = null;
  try {
    job = await deps.deletionOutbox.stage(cleanup.storageKey, cleanup.multipartUploadId);
  } catch {
    // Best-effort direct cleanup may still settle the unreferenced object.
  }
  try {
    if (cleanup.transport === "MULTIPART" && cleanup.multipartUploadId) {
      if (!deps.storage.directMultipartUpload) throw new Error("multipart_abort_unavailable");
      await deps.storage.directMultipartUpload.abortMultipartUpload({
        storageKey: cleanup.storageKey,
        uploadId: cleanup.multipartUploadId
      });
    }
    await deps.storage.deleteObject(cleanup.storageKey);
    if (job) await deps.deletionOutbox.complete(job.id);
  } catch {
    // The durable outbox retains both multipart-abort and object-delete authority.
  }
}

async function cleanupAdmissions(
  deps: KnowledgeUploadServiceDeps,
  items: readonly KnowledgeUploadAdmissionItem[]
): Promise<void> {
  await mapBounded(items, 4, async (item) => cleanupKnowledgeUploadObject(deps, {
    multipartUploadId: item.multipartUploadId,
    storageKey: item.storageKey,
    transport: item.transport
  }));
}

function admissionShape(
  metadata: ReturnType<typeof validateAdmission>,
  input: Readonly<{
    config: KnowledgeUploadConfig;
    direct: DirectMultipartUploadAdapter | undefined;
    now: Date;
  }>
): Array<KnowledgeUploadAdmissionItem & { contentType: string }> {
  const sessionExpiresAt = new Date(input.now.getTime() + input.config.sessionSeconds * 1_000);
  return metadata.map((file) => {
    const id = randomUUID();
    return {
      checksumHint: file.checksumHint,
      clientFileId: file.clientFileId,
      contentType: file.normalizedMimeType,
      declaredByteSize: file.byteSize,
      declaredMimeType: file.suppliedMimeType,
      fileName: file.fileName,
      id,
      multipartUploadId: null,
      normalizedMimeType: file.normalizedMimeType,
      parts: input.direct
        ? multipartParts(file.byteSize, input.config.multipartPartBytes)
        : [],
      sessionExpiresAt,
      storageKey: storageKey(),
      transport: input.direct ? "MULTIPART" : "PROXY"
    };
  });
}

async function activateMultipartAdmissions(
  deps: KnowledgeUploadServiceDeps,
  direct: DirectMultipartUploadAdapter,
  items: Array<KnowledgeUploadAdmissionItem & { contentType: string }>
): Promise<KnowledgeUploadAdmissionItem[]> {
  const activated: KnowledgeUploadAdmissionItem[] = [];
  try {
    return await mapBounded(items, 4, async (item) => {
      const created = await direct.createMultipartUpload({
        contentType: item.contentType,
        storageKey: item.storageKey
      });
      const next = { ...item, multipartUploadId: created.uploadId };
      activated.push(next);
      const { contentType: _contentType, ...admission } = next;
      return admission;
    });
  } catch (error) {
    await cleanupAdmissions(deps, activated);
    throw error;
  }
}

function sourceProjection(item: KnowledgeUploadItemRecord): Readonly<{
  errorCode: string | null;
  sourceId: string | null;
  state: KnowledgeUploadItemState;
}> {
  if (item.state === "REUSED") {
    return { errorCode: null, sourceId: item.sourceId, state: "reused" };
  }
  if (item.state !== "PROCESSING" || !item.sourceId || !item.sourceVersionId) {
    return {
      errorCode: "knowledge_processing_failed",
      sourceId: item.sourceId,
      state: "needs_attention"
    };
  }
  const version = item.sourceState?.versionStates.find(({ id }) => id === item.sourceVersionId);
  if (item.sourceState?.currentVersionId === item.sourceVersionId && version?.state === "ready") {
    return {
      errorCode: null,
      sourceId: item.sourceId,
      state: version.warningCodes.length > 0 ? "ready_with_warnings" : "ready"
    };
  }
  if (version?.state === "failed") {
    return {
      errorCode: "knowledge_processing_failed",
      sourceId: item.sourceId,
      state: "needs_attention"
    };
  }
  return { errorCode: null, sourceId: item.sourceId, state: "processing" };
}

async function itemProjection(
  deps: KnowledgeUploadServiceDeps,
  batch: KnowledgeUploadBatchRecord,
  item: KnowledgeUploadItemRecord,
  input: Readonly<{ config: KnowledgeUploadConfig; now: Date }>
): Promise<KnowledgeUploadItem> {
  let state: KnowledgeUploadItemState;
  let errorCode: string | null = null;
  let sourceId: string | null = null;
  let transport: KnowledgeUploadTransport | null = null;
  const uploadedBytes = item.parts.reduce(
    (total, part) => total + (part.completedAt ? part.byteSize : 0),
    item.transport === "PROXY" ? item.uploadedByteSize : 0
  );
  const sourceUpdatedAt = item.sourceState?.versionStates.find(
    ({ id }) => id === item.sourceVersionId
  )?.updatedAt;
  const projectedUpdatedAt = sourceUpdatedAt && sourceUpdatedAt > item.updatedAt
    ? sourceUpdatedAt
    : item.updatedAt;

  if (item.state === "CANCELLED") state = "cancelled";
  else if (item.state === "NEEDS_ATTENTION") {
    state = "needs_attention";
    errorCode = item.errorCode ?? "knowledge_upload_not_available";
  } else if (item.state === "STORED") state = "upload_complete";
  else if (item.state === "PROCESSING" || item.state === "REUSED") {
    const source = sourceProjection(item);
    state = source.state;
    errorCode = source.errorCode;
    sourceId = source.sourceId;
  } else if (item.sessionExpiresAt <= input.now) {
    state = "needs_attention";
    errorCode = "knowledge_upload_session_expired";
  } else {
    state = item.state === "UPLOADING" ? "uploading" : "queued";
    if (item.transport === "PROXY") {
      transport = {
        kind: "proxy",
        uploadUrl: [
          "/api/me/knowledge-uploads",
          encodeURIComponent(batch.knowledgeBaseId),
          encodeURIComponent(batch.id),
          encodeURIComponent(item.id),
          "content"
        ].join("/") + `?attempt=${item.attemptNumber}`
      };
    } else if (item.multipartUploadId && deps.storage.directMultipartUpload) {
      const remainingSeconds = Math.max(
        1,
        Math.min(
          3_600,
          input.config.sessionSeconds,
          Math.floor((item.sessionExpiresAt.getTime() - input.now.getTime()) / 1_000)
        )
      );
      const direct = deps.storage.directMultipartUpload;
      transport = {
        kind: "multipart",
        parts: await mapBounded(item.parts, 4, async (part) => ({
          byteOffset: part.byteOffset,
          byteSize: part.byteSize,
          complete: part.completedAt !== null,
          partNumber: part.partNumber,
          uploadUrl: part.completedAt
            ? null
            : await direct.presignMultipartPart({
                expiresInSeconds: remainingSeconds,
                partNumber: part.partNumber,
                storageKey: item.storageKey!,
                uploadId: item.multipartUploadId!
              })
        }))
      };
    } else {
      state = "needs_attention";
      errorCode = "knowledge_storage_unavailable";
    }
  }
  return {
    attemptNumber: item.attemptNumber,
    byteSize: item.declaredByteSize,
    clientFileId: item.clientFileId,
    failureCode: errorCode,
    fileName: item.fileName,
    id: item.id,
    sourceId,
    state,
    transport,
    updatedAt: projectedUpdatedAt.toISOString(),
    uploadedBytes: Math.min(item.declaredByteSize, uploadedBytes)
  };
}

export async function projectKnowledgeUploadBatch(
  deps: KnowledgeUploadServiceDeps,
  batch: KnowledgeUploadBatchRecord,
  input: Readonly<{ config: KnowledgeUploadConfig; now: Date }>
): Promise<KnowledgeUploadBatch> {
  const items = await mapBounded(batch.items, 4, (item) =>
    itemProjection(deps, batch, item, input));
  const updatedAt = items.reduce((latest, item) => {
    const candidate = new Date(item.updatedAt);
    return candidate > latest ? candidate : latest;
  }, batch.updatedAt);
  return {
    createdAt: batch.createdAt.toISOString(),
    id: batch.id,
    items,
    updatedAt: updatedAt.toISOString()
  };
}

export async function createKnowledgeUploadBatch(
  deps: KnowledgeUploadServiceDeps,
  input: Readonly<{
    batch: KnowledgeUploadBatchCreateInput;
    config: KnowledgeUploadConfig;
    extraction: KnowledgeExtractionConfig;
    knowledgeBaseId: string;
    now: Date;
    userId: string;
  }>
): Promise<KnowledgeUploadBatchRecord> {
  const metadata = validateAdmission(input.batch, input.extraction);
  const existing = await deps.repository.getByClientBatchId(
    input.userId,
    input.batch.clientBatchId
  );
  const direct = deps.storage.directMultipartUpload;
  const batchId = randomUUID();
  const pending = admissionShape(metadata, {
    config: input.config,
    direct,
    now: input.now
  });
  if (existing) {
    const comparable = pending.map(({ contentType: _contentType, ...item }) => item);
    if (!knowledgeUploadAdmissionMatches(existing, comparable, input.knowledgeBaseId)) {
      throw new KnowledgeUploadServiceError("knowledge_upload_conflict");
    }
    return existing;
  }

  let admissions: KnowledgeUploadAdmissionItem[];
  try {
    admissions = direct
      ? await activateMultipartAdmissions(deps, direct, pending)
      : pending.map(({ contentType: _contentType, ...item }) => item);
  } catch {
    throw new KnowledgeUploadServiceError("knowledge_storage_unavailable");
  }
  const result = await deps.repository.createBatch({
    batchId,
    clientBatchId: input.batch.clientBatchId,
    items: admissions,
    knowledgeBaseId: input.knowledgeBaseId,
    userId: input.userId
  }).catch(async (error) => {
    await cleanupAdmissions(deps, admissions);
    throw error;
  });
  if (result.kind === "created") return result.batch;
  await cleanupAdmissions(deps, admissions);
  if (result.kind === "existing") return result.batch;
  throw new KnowledgeUploadServiceError(
    result.kind === "not_found" ? "knowledge_base_not_available" : "knowledge_upload_conflict"
  );
}

function retryAdmission(
  target: KnowledgeUploadPrivateTarget,
  input: Readonly<{
    config: KnowledgeUploadConfig;
    direct: DirectMultipartUploadAdapter | undefined;
    now: Date;
  }>
): KnowledgeUploadAdmissionItem & { contentType: string } {
  return {
    checksumHint: target.checksumHint?.trim() ?? null,
    clientFileId: target.clientFileId,
    contentType: target.normalizedMimeType,
    declaredByteSize: target.declaredByteSize,
    declaredMimeType: target.declaredMimeType,
    fileName: target.fileName,
    id: target.id,
    multipartUploadId: null,
    normalizedMimeType: target.normalizedMimeType,
    parts: input.direct
      ? multipartParts(target.declaredByteSize, input.config.multipartPartBytes)
      : [],
    sessionExpiresAt: new Date(input.now.getTime() + input.config.sessionSeconds * 1_000),
    storageKey: storageKey(),
    transport: input.direct ? "MULTIPART" : "PROXY"
  };
}

export async function retryKnowledgeUploadItem(
  deps: KnowledgeUploadServiceDeps,
  input: Readonly<{
    attemptNumber: number;
    batchId: string;
    config: KnowledgeUploadConfig;
    itemId: string;
    knowledgeBaseId: string;
    now: Date;
    userId: string;
  }>
): Promise<void> {
  const target = await deps.repository.getTarget(input);
  if (!target) throw new KnowledgeUploadServiceError("knowledge_upload_not_available");
  if (target.attemptNumber !== input.attemptNumber) {
    throw new KnowledgeUploadServiceError("knowledge_upload_conflict");
  }
  const pending = retryAdmission(target, {
    config: input.config,
    direct: deps.storage.directMultipartUpload,
    now: input.now
  });
  let admission: KnowledgeUploadAdmissionItem;
  try {
    [admission] = deps.storage.directMultipartUpload
      ? await activateMultipartAdmissions(deps, deps.storage.directMultipartUpload, [pending])
      : [pending].map(({ contentType: _contentType, ...item }) => item);
  } catch {
    throw new KnowledgeUploadServiceError("knowledge_storage_unavailable");
  }
  const result = await deps.repository.retry({
    ...input,
    multipartUploadId: admission.multipartUploadId,
    parts: admission.parts,
    sessionExpiresAt: admission.sessionExpiresAt,
    storageKey: admission.storageKey,
    transport: admission.transport
  });
  if (result.kind !== "ok") {
    await cleanupAdmissions(deps, [admission]);
    throw new KnowledgeUploadServiceError(
      result.kind === "not_found" ? "knowledge_upload_not_available" : "knowledge_upload_conflict"
    );
  }
  await cleanupKnowledgeUploadObject(deps, result.cleanup);
}

export async function cancelKnowledgeUploadItem(
  deps: KnowledgeUploadServiceDeps,
  input: Readonly<{
    attemptNumber: number;
    batchId: string;
    itemId: string;
    knowledgeBaseId: string;
    now: Date;
    userId: string;
  }>
): Promise<void> {
  const result = await deps.repository.cancel(input);
  if (result.kind === "not_found") {
    throw new KnowledgeUploadServiceError("knowledge_upload_not_available");
  }
  if (result.kind === "settled") {
    throw new KnowledgeUploadServiceError("knowledge_upload_conflict");
  }
  if ("cleanup" in result && result.cleanup) {
    await cleanupKnowledgeUploadObject(deps, result.cleanup);
  }
}

export async function settleKnowledgeUploadItem(
  deps: KnowledgeUploadServiceDeps,
  input: Readonly<{
    attemptNumber: number;
    batchId: string;
    extraction: KnowledgeExtractionConfig;
    itemId: string;
    knowledgeBaseId: string;
    now: Date;
    userId: string;
  }>
): Promise<void> {
  const target = await deps.repository.getTarget(input);
  if (!target) throw new KnowledgeUploadServiceError("knowledge_upload_not_available");
  if (target.attemptNumber !== input.attemptNumber) {
    throw new KnowledgeUploadServiceError("knowledge_upload_conflict");
  }
  if (target.state === "PROCESSING" || target.state === "REUSED") return;
  if (!target.storageKey || target.state === "CANCELLED" || target.state === "NEEDS_ATTENTION") {
    throw new KnowledgeUploadServiceError("knowledge_upload_conflict");
  }
  if (target.transport === "PROXY" && target.state !== "STORED") {
    throw new KnowledgeUploadServiceError("knowledge_upload_conflict");
  }

  if (target.transport === "MULTIPART" && target.state !== "STORED") {
    const direct = deps.storage.directMultipartUpload;
    if (!direct || !target.multipartUploadId || target.parts.length < 1 ||
      target.parts.some((part) => !part.etag || !part.completedAt) ||
      target.parts.reduce((total, part) => total + part.byteSize, 0) !== target.declaredByteSize) {
      throw new KnowledgeUploadServiceError("knowledge_upload_conflict");
    }
    try {
      await direct.completeMultipartUpload({
        parts: target.parts.map((part) => ({
          etag: part.etag!,
          partNumber: part.partNumber
        })),
        storageKey: target.storageKey,
        uploadId: target.multipartUploadId
      });
    } catch {
      // Completion may have committed before a lost response. The bounded object
      // inspection below is the authoritative idempotent proof.
    }
  }

  if (!deps.storage.inspectObject) {
    throw new KnowledgeUploadServiceError("knowledge_storage_unavailable");
  }
  let inspected: Awaited<ReturnType<NonNullable<StorageAdapter["inspectObject"]>>>;
  try {
    inspected = await deps.storage.inspectObject(target.storageKey, {
      maxBytes: input.extraction.maxFileBytes,
      needles: UPLOAD_CONTENT_INSPECTION_NEEDLES,
      sampleBytes: 64 * 1_024
    });
  } catch {
    await deps.repository.markAttention({
      ...input,
      attemptNumber: target.attemptNumber,
      errorCode: "knowledge_storage_unavailable",
      storageKey: target.storageKey
    });
    throw new KnowledgeUploadServiceError("knowledge_storage_unavailable");
  }
  if (inspected.byteSize !== target.declaredByteSize) {
    await deps.repository.markAttention({
      ...input,
      attemptNumber: target.attemptNumber,
      errorCode: "knowledge_upload_size_mismatch",
      storageKey: target.storageKey
    });
    throw new KnowledgeUploadServiceError("knowledge_upload_conflict");
  }
  if (target.checksumHint?.trim() && target.checksumHint.trim() !== inspected.checksum) {
    await deps.repository.markAttention({
      ...input,
      attemptNumber: target.attemptNumber,
      errorCode: "knowledge_checksum_mismatch",
      storageKey: target.storageKey
    });
    throw new KnowledgeUploadServiceError("knowledge_checksum_mismatch");
  }
  const validated = validateUploadInspection({
    byteSize: inspected.byteSize,
    fileName: target.fileName,
    foundNeedles: inspected.foundNeedles,
    maxBytes: input.extraction.maxFileBytes,
    mimeType: target.normalizedMimeType,
    sample: inspected.sample,
    scope: "knowledge"
  });
  if (!validated.ok || !resolveDocumentParserRoute(target.fileName, validated.ok
    ? validated.mimeType
    : target.normalizedMimeType)) {
    await deps.repository.markAttention({
      ...input,
      attemptNumber: target.attemptNumber,
      errorCode: "unsupported_type",
      storageKey: target.storageKey
    });
    throw new KnowledgeUploadServiceError("unsupported_type");
  }
  if (!await deps.repository.markStored({
    ...input,
    attemptNumber: target.attemptNumber,
    storageKey: target.storageKey
  })) {
    throw new KnowledgeUploadServiceError("knowledge_upload_conflict");
  }
  const ids = newKnowledgeUploadSettlementIds();
  const result = await deps.repository.settle({
    ...ids,
    ...input,
    byteSize: inspected.byteSize,
    checksum: inspected.checksum,
    fileName: target.fileName,
    mimeType: validated.mimeType,
    normalizedTextStorageKey: [
      "knowledge",
      input.userId,
      input.knowledgeBaseId,
      ids.sourceId,
      ids.sourceVersionId,
      "normalized-v2.json"
    ].join("/")
  });
  if (result.kind === "not_found") {
    throw new KnowledgeUploadServiceError("knowledge_base_not_available");
  }
  if (result.kind === "conflict") {
    throw new KnowledgeUploadServiceError("knowledge_upload_conflict");
  }
  if (result.kind === "reused") {
    await cleanupKnowledgeUploadObject(deps, {
      multipartUploadId: null,
      storageKey: result.cleanupStorageKey,
      transport: target.transport
    });
  }
  if (result.kind === "created") {
    try {
      deps.kickProcessing?.();
    } catch {
      // The durable ingestion queue remains authoritative.
    }
  }
}
