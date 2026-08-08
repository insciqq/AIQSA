import type {
  ProviderAttachment,
  ProviderModelCapabilities
} from "../providers/types";
import {
  isStoredObjectTooLargeError,
  type StorageAdapter
} from "../uploads/storage";
import type { RunAttachmentLimits } from "./attachmentLimits";
import type { RunAttachmentRecord, RunRepository } from "./runRepositoryContract";

export const MAX_RUN_CONTENT_BLOCKS = 256;

export type AttachmentMaterializationErrorCode =
  | "attachment_count_limit_exceeded"
  | "attachment_encoded_size_limit_exceeded"
  | "attachment_materialization_limit_exceeded"
  | "attachment_object_read_failed"
  | "attachment_object_size_mismatch"
  | "attachment_not_ready"
  | "attachment_reference_invalid"
  | "content_block_limit_exceeded";

export type AttachmentLimitNumericFacts = Readonly<Record<string, number>>;

export class AttachmentMaterializationError extends Error {
  readonly actual: AttachmentLimitNumericFacts;
  readonly code: AttachmentMaterializationErrorCode;
  readonly limits: AttachmentLimitNumericFacts;
  readonly status: 400 | 409 | 413 | 503;

  constructor(input: Readonly<{
    actual?: AttachmentLimitNumericFacts;
    code: AttachmentMaterializationErrorCode;
    limits?: AttachmentLimitNumericFacts;
    message: string;
    status: 400 | 409 | 413 | 503;
  }>) {
    super(input.message);
    this.name = "AttachmentMaterializationError";
    this.actual = Object.freeze({ ...(input.actual ?? {}) });
    this.code = input.code;
    this.limits = Object.freeze({ ...(input.limits ?? {}) });
    this.status = input.status;
  }
}

export function isAttachmentMaterializationError(
  error: unknown
): error is AttachmentMaterializationError {
  return error instanceof AttachmentMaterializationError;
}

function referenceError(input: Readonly<{
  actual?: AttachmentLimitNumericFacts;
  code: "attachment_reference_invalid" | "content_block_limit_exceeded";
  limits?: AttachmentLimitNumericFacts;
  message: string;
}>): AttachmentMaterializationError {
  return new AttachmentMaterializationError({
    ...input,
    status: 400
  });
}

export function attachmentIdsFromContentBlocks(blocks: readonly unknown[]): string[] {
  if (blocks.length > MAX_RUN_CONTENT_BLOCKS) {
    throw referenceError({
      actual: { blockCount: blocks.length },
      code: "content_block_limit_exceeded",
      limits: { maxBlocks: MAX_RUN_CONTENT_BLOCKS },
      message: `This run contains ${blocks.length} content blocks; the limit is ${MAX_RUN_CONTENT_BLOCKS}.`
    });
  }

  const attachmentIds: string[] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      continue;
    }

    const record = block as Record<string, unknown>;
    const hasAttachmentId = Object.prototype.hasOwnProperty.call(record, "attachmentId");
    const attachmentLike = record.type === "attachment" || record.type === "file" || record.type === "image";
    if (!hasAttachmentId) {
      if (attachmentLike) {
        throw referenceError({
          code: "attachment_reference_invalid",
          message: "Every attachment block must contain one non-empty attachment reference."
        });
      }
      continue;
    }

    if (!attachmentLike) {
      throw referenceError({
        code: "attachment_reference_invalid",
        message: "Attachment references are allowed only in attachment content blocks."
      });
    }

    if (
      typeof record.attachmentId !== "string" ||
      record.attachmentId.length === 0 ||
      record.attachmentId !== record.attachmentId.trim()
    ) {
      throw referenceError({
        code: "attachment_reference_invalid",
        message: "Every attachment reference must be a non-empty canonical identifier."
      });
    }
    attachmentIds.push(record.attachmentId);
  }

  const uniqueCount = new Set(attachmentIds).size;
  if (uniqueCount !== attachmentIds.length) {
    throw referenceError({
      actual: {
        count: attachmentIds.length,
        uniqueCount
      },
      code: "attachment_reference_invalid",
      message: "Attachment references must be unique within one run."
    });
  }

  return attachmentIds;
}

function countLimitError(count: number, maxCount: number): AttachmentMaterializationError {
  return new AttachmentMaterializationError({
    actual: { count },
    code: "attachment_count_limit_exceeded",
    limits: { maxCount },
    message: `This run contains ${count} attachments; the limit is ${maxCount}.`,
    status: 413
  });
}

export function enforceAttachmentReferenceLimit(
  attachmentIds: readonly string[],
  limits: Pick<RunAttachmentLimits, "maxCount">
): void {
  if (attachmentIds.length > limits.maxCount) {
    throw countLimitError(attachmentIds.length, limits.maxCount);
  }
}

export function validatePersistedAttachmentReferences(
  blocks: readonly unknown[],
  persistedAttachmentIds: readonly string[],
  limits: Pick<RunAttachmentLimits, "maxCount">
): string[] {
  const contentAttachmentIds = attachmentIdsFromContentBlocks(blocks);
  enforceAttachmentReferenceLimit(contentAttachmentIds, limits);

  if (
    contentAttachmentIds.length !== persistedAttachmentIds.length ||
    contentAttachmentIds.some(
      (attachmentId, index) => attachmentId !== persistedAttachmentIds[index]
    )
  ) {
    throw referenceError({
      actual: {
        contentCount: contentAttachmentIds.length,
        persistedCount: persistedAttachmentIds.length
      },
      code: "attachment_reference_invalid",
      message: "Persisted attachment references do not match the normalized run content."
    });
  }

  return contentAttachmentIds;
}

function safeByteSize(record: RunAttachmentRecord): number {
  if (!Number.isSafeInteger(record.byteSize) || record.byteSize <= 0) {
    throw new AttachmentMaterializationError({
      code: "attachment_object_size_mismatch",
      message: "An attachment object did not match its recorded size.",
      status: 409
    });
  }
  return record.byteSize;
}

function safeSum(left: number, right: number): number | null {
  const result = left + right;
  return Number.isSafeInteger(result) && result >= left ? result : null;
}

function base64EncodedBytes(byteSize: number): number {
  return 4 * Math.ceil(byteSize / 3);
}

function imageDataUrlPrefixBytes(mimeType: string): number {
  return Buffer.byteLength(`data:${mimeType};base64,`, "utf8");
}

function estimatedEncodedBytes(record: RunAttachmentRecord): number {
  const encoded = base64EncodedBytes(safeByteSize(record));
  return record.kind === "image"
    ? encoded + imageDataUrlPrefixBytes(record.mimeType || "application/octet-stream")
    : encoded;
}

function requiresBinaryMaterialization(
  record: RunAttachmentRecord,
  capabilities: ProviderModelCapabilities
): boolean {
  return (record.kind === "image" && capabilities.vision) ||
    (record.kind === "pdf" && capabilities.nativePdfInput);
}

type MaterializationPlanEntry = Readonly<{
  encodedBytes: number;
  maxReadBytes: number;
  record: RunAttachmentRecord;
  sourceBytes: number;
}>;

function materializationPlan(
  records: readonly RunAttachmentRecord[],
  capabilities: ProviderModelCapabilities,
  limits: RunAttachmentLimits
): Readonly<{
  binaryById: ReadonlyMap<string, MaterializationPlanEntry>;
  encodedBytes: number;
  sourceBytes: number;
}> {
  let encodedBytes = 0;
  let sourceBytes = 0;
  const binaryById = new Map<string, MaterializationPlanEntry>();

  for (const record of records) {
    if (!requiresBinaryMaterialization(record, capabilities)) {
      continue;
    }
    const recordSourceBytes = safeByteSize(record);
    const recordEncodedBytes = estimatedEncodedBytes(record);
    // Reserve the metadata-sized objects in stable order. Each concurrent read
    // is capped by both its settled object size and the budget remaining at its
    // reservation point, so their aggregate cannot outrun the admitted total.
    const maxReadBytes = Math.min(
      recordSourceBytes,
      limits.maxMaterializedBytes - sourceBytes
    );
    const nextSourceBytes = safeSum(sourceBytes, recordSourceBytes);
    if (nextSourceBytes === null || nextSourceBytes > limits.maxMaterializedBytes) {
      throw new AttachmentMaterializationError({
        actual: { materializedBytes: nextSourceBytes ?? Number.MAX_SAFE_INTEGER },
        code: "attachment_materialization_limit_exceeded",
        limits: { maxMaterializedBytes: limits.maxMaterializedBytes },
        message: `Selected attachments require ${nextSourceBytes ?? "more than the supported number of"} source bytes; the limit is ${limits.maxMaterializedBytes}.`,
        status: 413
      });
    }
    const nextEncodedBytes = safeSum(encodedBytes, recordEncodedBytes);
    if (nextEncodedBytes === null || nextEncodedBytes > limits.maxEncodedBytes) {
      throw new AttachmentMaterializationError({
        actual: { encodedBytes: nextEncodedBytes ?? Number.MAX_SAFE_INTEGER },
        code: "attachment_encoded_size_limit_exceeded",
        limits: { maxEncodedBytes: limits.maxEncodedBytes },
        message: `Selected attachments require about ${nextEncodedBytes ?? "more than the supported number of"} encoded bytes; the limit is ${limits.maxEncodedBytes}.`,
        status: 413
      });
    }
    sourceBytes = nextSourceBytes;
    encodedBytes = nextEncodedBytes;
    binaryById.set(record.id, {
      encodedBytes: recordEncodedBytes,
      maxReadBytes,
      record,
      sourceBytes: recordSourceBytes
    });
  }

  return {
    binaryById,
    encodedBytes,
    sourceBytes
  };
}

function orderedAttachmentRecords(
  records: readonly RunAttachmentRecord[],
  attachmentIds: readonly string[]
): RunAttachmentRecord[] {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  return attachmentIds.flatMap((attachmentId) => {
    const record = recordsById.get(attachmentId);
    return record ? [record] : [];
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function objectSizeMismatch(input: Readonly<{
  maxBytes: number;
  observedBytes?: number;
  recordedBytes: number;
}>): AttachmentMaterializationError {
  return new AttachmentMaterializationError({
    actual: {
      ...(input.observedBytes === undefined ? {} : { observedBytes: input.observedBytes }),
      recordedBytes: input.recordedBytes
    },
    code: "attachment_object_size_mismatch",
    limits: { maxObjectBytes: input.maxBytes },
    message: "An attachment object did not match its recorded size.",
    status: 409
  });
}

function objectReadFailed(): AttachmentMaterializationError {
  return new AttachmentMaterializationError({
    code: "attachment_object_read_failed",
    message: "An attachment object could not be read.",
    status: 503
  });
}

async function materializeOne(
  storage: Pick<StorageAdapter, "getObject">,
  entry: MaterializationPlanEntry,
  signal: AbortSignal
): Promise<ProviderAttachment> {
  const { storageKey, ...attachment } = entry.record;
  let object: Awaited<ReturnType<StorageAdapter["getObject"]>>;
  try {
    object = await storage.getObject(storageKey, {
      maxBytes: entry.maxReadBytes,
      signal
    });
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    if (isStoredObjectTooLargeError(error)) {
      throw objectSizeMismatch({
        maxBytes: entry.sourceBytes,
        observedBytes: error.observedBytes,
        recordedBytes: entry.sourceBytes
      });
    }
    throw objectReadFailed();
  }

  if (object.body.length !== entry.sourceBytes) {
    throw objectSizeMismatch({
      maxBytes: entry.sourceBytes,
      observedBytes: object.body.length,
      recordedBytes: entry.sourceBytes
    });
  }

  if (attachment.kind === "pdf") {
    return {
      ...attachment,
      base64Data: object.body.toString("base64")
    };
  }

  const contentType = attachment.mimeType || object.contentType;
  return {
    ...attachment,
    dataUrl: `data:${contentType};base64,${object.body.toString("base64")}`
  };
}

export async function loadProviderAttachments(
  deps: Readonly<{
    repository: Pick<RunRepository, "loadAttachments">;
    storage?: Pick<StorageAdapter, "getObject">;
  }>,
  userId: string,
  attachmentIds: readonly string[],
  options: Readonly<{
    capabilities: ProviderModelCapabilities;
    limits: RunAttachmentLimits;
    signal?: AbortSignal;
  }>
): Promise<ProviderAttachment[]> {
  if (options.signal?.aborted) throw abortReason(options.signal);
  const uniqueCount = new Set(attachmentIds).size;
  if (uniqueCount !== attachmentIds.length) {
    throw referenceError({
      actual: { count: attachmentIds.length, uniqueCount },
      code: "attachment_reference_invalid",
      message: "Attachment references must be unique within one run."
    });
  }
  enforceAttachmentReferenceLimit(attachmentIds, options.limits);
  if (attachmentIds.length === 0) {
    return [];
  }

  const loadedRecords = await deps.repository.loadAttachments(userId, [...attachmentIds]);
  if (options.signal?.aborted) throw abortReason(options.signal);
  const records = orderedAttachmentRecords(loadedRecords, attachmentIds);
  if (records.some((record) => record.status !== "ready")) {
    throw new AttachmentMaterializationError({
      code: "attachment_not_ready",
      message: "Every selected attachment must finish processing before a run can start.",
      status: 409
    });
  }
  if (records.length !== attachmentIds.length) {
    return records.map(({ storageKey: _storageKey, ...attachment }) => attachment);
  }
  const plan = materializationPlan(records, options.capabilities, options.limits);
  if (!deps.storage || plan.binaryById.size === 0) {
    return records.map(({ storageKey: _storageKey, ...attachment }) => attachment);
  }

  const internalController = new AbortController();
  let firstError: unknown;
  let nextIndex = 0;
  const results = new Array<ProviderAttachment | undefined>(records.length);
  const onCallerAbort = () => {
    firstError ??= abortReason(options.signal as AbortSignal);
    internalController.abort(firstError);
  };
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (options.signal?.aborted) onCallerAbort();

  const worker = async () => {
    while (firstError === undefined && !internalController.signal.aborted) {
      const index = nextIndex;
      if (index >= records.length) return;
      nextIndex += 1;
      const record = records[index];
      const entry = plan.binaryById.get(record.id);
      if (!entry) {
        const { storageKey: _storageKey, ...attachment } = record;
        results[index] = attachment;
        continue;
      }

      try {
        results[index] = await materializeOne(deps.storage!, entry, internalController.signal);
      } catch (error) {
        if (firstError === undefined) {
          firstError = error;
          internalController.abort(error);
        }
        return;
      }
    }
  };

  try {
    await Promise.all(
      Array.from(
        { length: Math.min(options.limits.readConcurrency, records.length) },
        () => worker()
      )
    );
  } finally {
    options.signal?.removeEventListener("abort", onCallerAbort);
  }

  if (firstError !== undefined) throw firstError;
  if (results.some((result) => result === undefined)) {
    throw new AttachmentMaterializationError({
      code: "attachment_object_size_mismatch",
      message: "Attachment materialization did not settle every selected object.",
      status: 409
    });
  }
  return results as ProviderAttachment[];
}
