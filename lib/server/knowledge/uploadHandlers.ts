import {
  decodeKnowledgeUploadBatchCreate,
  decodeKnowledgeUploadAttempt,
  decodeKnowledgeUploadPartCheckpoint,
  KNOWLEDGE_UPLOAD_ATTEMPT_MAX,
  type KnowledgeUploadBatchListResponse,
  type KnowledgeUploadBatchResponse
} from "../../contracts/knowledgeUploads";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../http/requestBody";
import { getRequestBodyConfig, type RequestBodyConfig } from "../http/requestBodyConfig";
import { resolveUploadPermitGate, type UploadPermitGate } from "../http/uploadPermitGate";
import type { StorageAdapter } from "../uploads/storage";
import {
  getKnowledgeExtractionConfig,
  type KnowledgeExtractionConfig
} from "./knowledgeExtractionConfig";
import {
  getKnowledgeUploadConfig,
  type KnowledgeUploadConfig
} from "./knowledgeUploadConfig";
import {
  cancelKnowledgeUploadItem,
  cleanupKnowledgeUploadObject,
  createKnowledgeUploadBatch,
  KnowledgeUploadServiceError,
  projectKnowledgeUploadBatch,
  retryKnowledgeUploadItem,
  settleKnowledgeUploadItem,
  type KnowledgeUploadServiceDeps
} from "./uploadService";

export type KnowledgeUploadHandlerDeps = KnowledgeUploadServiceDeps & Readonly<{
  getBodyConfig?: (
    uploadMaxBytes: number
  ) => Pick<RequestBodyConfig, "uploadMaxConcurrency">;
  getExtractionConfig?: () => KnowledgeExtractionConfig;
  getUploadConfig?: () => KnowledgeUploadConfig;
  now?: () => Date;
  resolveAuth: RequestAuthResolver;
  uploadPermitGate?: UploadPermitGate;
}>;

type BaseContext = {
  params: Promise<{ baseId: string }> | { baseId: string };
};

type BatchContext = {
  params:
    | Promise<{ baseId: string; batchId: string }>
    | { baseId: string; batchId: string };
};

type ItemContext = {
  params:
    | Promise<{ baseId: string; batchId: string; itemId: string }>
    | { baseId: string; batchId: string; itemId: string };
};

type PartContext = {
  params:
    | Promise<{ baseId: string; batchId: string; itemId: string; partNumber: string }>
    | { baseId: string; batchId: string; itemId: string; partNumber: string };
};

function errorJson(code: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error: code }, { headers, status });
}

function boundedId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u0020\u007f]/u.test(value)
    ? value
    : null;
}

function boundedPositiveInteger(value: unknown, maximum: number): number | null {
  if (typeof value !== "string" || !/^[1-9]\d{0,9}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function serviceError(error: unknown): Response | null {
  if (!(error instanceof KnowledgeUploadServiceError)) return null;
  const status = error.code === "knowledge_base_not_available" ||
      error.code === "knowledge_upload_not_available"
    ? 404
    : error.code === "knowledge_file_limit_exceeded"
      ? 413
      : error.code === "knowledge_storage_unavailable"
        ? 503
        : error.code === "knowledge_upload_conflict" ||
            error.code === "knowledge_upload_session_expired" ||
            error.code === "knowledge_checksum_mismatch"
          ? 409
          : 400;
  return errorJson(error.code, status);
}

async function authBase(
  deps: KnowledgeUploadHandlerDeps,
  request: Request,
  context: BaseContext | BatchContext | ItemContext | PartContext
): Promise<Readonly<{
  baseId: string;
  batchId: string | null;
  itemId: string | null;
  partNumber: number | null;
  userId: string;
}> | Response> {
  const auth = await deps.resolveAuth(request);
  if (!auth) return errorJson("unauthorized", 401);
  const params = await context.params;
  const baseId = boundedId(params.baseId);
  const batchId = "batchId" in params ? boundedId(params.batchId) : null;
  const itemId = "itemId" in params ? boundedId(params.itemId) : null;
  const parsedPart = "partNumber" in params
    ? boundedPositiveInteger(params.partNumber, 10_000)
    : null;
  if (!baseId || ("batchId" in params && !batchId) || ("itemId" in params && !itemId) ||
    ("partNumber" in params && parsedPart === null)) {
    return errorJson("knowledge_upload_not_available", 404);
  }
  return { baseId, batchId, itemId, partNumber: parsedPart, userId: auth.userId };
}

function configs(deps: KnowledgeUploadHandlerDeps) {
  return {
    extraction: deps.getExtractionConfig?.() ?? getKnowledgeExtractionConfig(),
    upload: deps.getUploadConfig?.() ?? getKnowledgeUploadConfig()
  };
}

async function batchResponse(
  deps: KnowledgeUploadHandlerDeps,
  input: Readonly<{ baseId: string; batchId: string; userId: string }>,
  status = 200
): Promise<Response> {
  const batch = await deps.repository.getBatch(input.userId, input.baseId, input.batchId);
  if (!batch) return errorJson("knowledge_upload_not_available", 404);
  const projected = await projectKnowledgeUploadBatch(deps, batch, {
    config: configs(deps).upload,
    now: deps.now?.() ?? new Date()
  });
  return Response.json({ batch: projected } satisfies KnowledgeUploadBatchResponse, {
    headers: { "cache-control": "no-store" },
    status
  });
}

async function attemptMutationBody(
  request: Request
): Promise<Readonly<{ attemptNumber: number }> | Response> {
  const body = await readJsonBodyOrNull(request, "json");
  const bodyError = requestBodyErrorResponse(body);
  if (bodyError) return bodyError;
  const decoded = decodeKnowledgeUploadAttempt(body);
  return decoded.ok ? decoded.value : errorJson(decoded.code, 400);
}

export function createKnowledgeUploadBatchCollectionHandlers(deps: KnowledgeUploadHandlerDeps) {
  return {
    async GET(request: Request, context: BaseContext): Promise<Response> {
      const owner = await authBase(deps, request, context);
      if (owner instanceof Response) return owner;
      const batches = await deps.repository.listBatches(owner.userId, owner.baseId);
      const configuration = configs(deps).upload;
      const now = deps.now?.() ?? new Date();
      const projected = await Promise.all(batches.map((batch) =>
        projectKnowledgeUploadBatch(deps, batch, { config: configuration, now })));
      return Response.json({ batches: projected } satisfies KnowledgeUploadBatchListResponse, {
        headers: { "cache-control": "no-store" }
      });
    },

    async POST(request: Request, context: BaseContext): Promise<Response> {
      const owner = await authBase(deps, request, context);
      if (owner instanceof Response) return owner;
      const configuration = configs(deps);
      const body = await readJsonBodyOrNull(request, "json");
      const bodyError = requestBodyErrorResponse(body);
      if (bodyError) return bodyError;
      const decoded = decodeKnowledgeUploadBatchCreate(body, configuration.upload.maxBatchFiles);
      if (!decoded.ok) return errorJson(decoded.code, 400);
      try {
        const batch = await createKnowledgeUploadBatch(deps, {
          batch: decoded.value,
          config: configuration.upload,
          extraction: configuration.extraction,
          knowledgeBaseId: owner.baseId,
          now: deps.now?.() ?? new Date(),
          userId: owner.userId
        });
        const projected = await projectKnowledgeUploadBatch(deps, batch, {
          config: configuration.upload,
          now: deps.now?.() ?? new Date()
        });
        return Response.json({ batch: projected } satisfies KnowledgeUploadBatchResponse, {
          headers: { "cache-control": "no-store" },
          status: 201
        });
      } catch (error) {
        const response = serviceError(error);
        if (response) return response;
        throw error;
      }
    }
  };
}

export function createGetKnowledgeUploadBatchHandler(deps: KnowledgeUploadHandlerDeps) {
  return async function GET(request: Request, context: BatchContext): Promise<Response> {
    const owner = await authBase(deps, request, context);
    if (owner instanceof Response) return owner;
    return batchResponse(deps, {
      baseId: owner.baseId,
      batchId: owner.batchId!,
      userId: owner.userId
    });
  };
}

export function createStartKnowledgeUploadItemHandler(deps: KnowledgeUploadHandlerDeps) {
  return async function POST(request: Request, context: ItemContext): Promise<Response> {
    const owner = await authBase(deps, request, context);
    if (owner instanceof Response) return owner;
    const attempt = await attemptMutationBody(request);
    if (attempt instanceof Response) return attempt;
    const result = await deps.repository.start({
      attemptNumber: attempt.attemptNumber,
      batchId: owner.batchId!,
      itemId: owner.itemId!,
      knowledgeBaseId: owner.baseId,
      now: deps.now?.() ?? new Date(),
      userId: owner.userId
    });
    if (result === "not_found") return errorJson("knowledge_upload_not_available", 404);
    if (result === "expired") return errorJson("knowledge_upload_session_expired", 409);
    return batchResponse(deps, {
      baseId: owner.baseId,
      batchId: owner.batchId!,
      userId: owner.userId
    });
  };
}

export function createCheckpointKnowledgeUploadPartHandler(deps: KnowledgeUploadHandlerDeps) {
  return async function POST(request: Request, context: PartContext): Promise<Response> {
    const owner = await authBase(deps, request, context);
    if (owner instanceof Response) return owner;
    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) return bodyError;
    const decoded = decodeKnowledgeUploadPartCheckpoint(body);
    if (!decoded.ok) return errorJson(decoded.code, 400);
    const result = await deps.repository.checkpointPart({
      attemptNumber: decoded.value.attemptNumber,
      batchId: owner.batchId!,
      byteSize: decoded.value.byteSize,
      etag: decoded.value.etag,
      itemId: owner.itemId!,
      knowledgeBaseId: owner.baseId,
      now: deps.now?.() ?? new Date(),
      partNumber: owner.partNumber!,
      userId: owner.userId
    });
    if (result === "not_found") return errorJson("knowledge_upload_not_available", 404);
    if (result === "expired") return errorJson("knowledge_upload_session_expired", 409);
    if (result === "conflict") return errorJson("knowledge_upload_conflict", 409);
    return batchResponse(deps, {
      baseId: owner.baseId,
      batchId: owner.batchId!,
      userId: owner.userId
    });
  };
}

export function createStreamKnowledgeUploadItemHandler(deps: KnowledgeUploadHandlerDeps) {
  return async function PUT(request: Request, context: ItemContext): Promise<Response> {
    const owner = await authBase(deps, request, context);
    if (owner instanceof Response) return owner;
    const requestedAttempt = boundedPositiveInteger(
      new URL(request.url).searchParams.get("attempt"),
      KNOWLEDGE_UPLOAD_ATTEMPT_MAX
    );
    if (requestedAttempt === null) return errorJson("knowledge_upload_input_invalid", 400);
    const target = await deps.repository.getTarget({
      batchId: owner.batchId!,
      itemId: owner.itemId!,
      knowledgeBaseId: owner.baseId,
      userId: owner.userId
    });
    if (!target || target.transport !== "PROXY" || target.state !== "QUEUED" ||
      target.attemptNumber !== requestedAttempt) {
      return errorJson("knowledge_upload_not_available", 404);
    }
    const now = deps.now?.() ?? new Date();
    if (target.sessionExpiresAt <= now) {
      return errorJson("knowledge_upload_session_expired", 409);
    }
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) !== target.declaredByteSize)) {
      return errorJson("knowledge_upload_conflict", 409);
    }
    if (!request.body || !target.storageKey || !deps.storage.putObjectStream) {
      return errorJson("knowledge_storage_unavailable", 503);
    }
    const extraction = configs(deps).extraction;
    const bodyConfiguration = deps.getBodyConfig?.(extraction.maxFileBytes) ??
      getRequestBodyConfig(process.env, extraction.maxFileBytes);
    const gate = deps.uploadPermitGate ?? resolveUploadPermitGate(
      bodyConfiguration.uploadMaxConcurrency
    );
    const release = gate.tryAcquire();
    if (!release) return errorJson("upload_busy", 429, { "retry-after": "1" });
    try {
      const started = await deps.repository.claimProxyStream({
        attemptNumber: target.attemptNumber,
        batchId: owner.batchId!,
        itemId: owner.itemId!,
        knowledgeBaseId: owner.baseId,
        now,
        storageKey: target.storageKey,
        userId: owner.userId
      });
      if (started === "expired") return errorJson("knowledge_upload_session_expired", 409);
      if (started === "not_found") return errorJson("knowledge_upload_not_available", 404);
      try {
        await deps.storage.putObjectStream({
          body: request.body,
          byteSize: target.declaredByteSize,
          contentType: target.normalizedMimeType,
          signal: request.signal,
          storageKey: target.storageKey
        });
      } catch (error) {
        const retained = await deps.repository.markAttention({
          attemptNumber: target.attemptNumber,
          batchId: owner.batchId!,
          errorCode: "knowledge_storage_unavailable",
          itemId: owner.itemId!,
          knowledgeBaseId: owner.baseId,
          storageKey: target.storageKey,
          userId: owner.userId
        });
        if (!retained) {
          await cleanupKnowledgeUploadObject(deps, {
            multipartUploadId: null,
            storageKey: target.storageKey,
            transport: "PROXY"
          });
        }
        if (request.signal.aborted) throw error;
        return errorJson("knowledge_storage_unavailable", 503);
      }
      if (!await deps.repository.markStored({
        attemptNumber: target.attemptNumber,
        batchId: owner.batchId!,
        itemId: owner.itemId!,
        knowledgeBaseId: owner.baseId,
        storageKey: target.storageKey,
        userId: owner.userId
      })) {
        await cleanupKnowledgeUploadObject(deps, {
          multipartUploadId: null,
          storageKey: target.storageKey,
          transport: "PROXY"
        });
        return errorJson("knowledge_upload_conflict", 409);
      }
      return batchResponse(deps, {
        baseId: owner.baseId,
        batchId: owner.batchId!,
        userId: owner.userId
      }, 202);
    } finally {
      release();
    }
  };
}

export function createSettleKnowledgeUploadItemHandler(deps: KnowledgeUploadHandlerDeps) {
  return async function POST(request: Request, context: ItemContext): Promise<Response> {
    const owner = await authBase(deps, request, context);
    if (owner instanceof Response) return owner;
    const attempt = await attemptMutationBody(request);
    if (attempt instanceof Response) return attempt;
    const extraction = configs(deps).extraction;
    const bodyConfiguration = deps.getBodyConfig?.(extraction.maxFileBytes) ??
      getRequestBodyConfig(process.env, extraction.maxFileBytes);
    const gate = deps.uploadPermitGate ?? resolveUploadPermitGate(
      bodyConfiguration.uploadMaxConcurrency
    );
    const release = gate.tryAcquire();
    if (!release) return errorJson("upload_busy", 429, { "retry-after": "1" });
    try {
      try {
        await settleKnowledgeUploadItem(deps, {
          attemptNumber: attempt.attemptNumber,
          batchId: owner.batchId!,
          extraction,
          itemId: owner.itemId!,
          knowledgeBaseId: owner.baseId,
          now: deps.now?.() ?? new Date(),
          userId: owner.userId
        });
      } catch (error) {
        const response = serviceError(error);
        if (response) return response;
        throw error;
      }
      return batchResponse(deps, {
        baseId: owner.baseId,
        batchId: owner.batchId!,
        userId: owner.userId
      }, 202);
    } finally {
      release();
    }
  };
}

export function createRetryKnowledgeUploadItemHandler(deps: KnowledgeUploadHandlerDeps) {
  return async function POST(request: Request, context: ItemContext): Promise<Response> {
    const owner = await authBase(deps, request, context);
    if (owner instanceof Response) return owner;
    const attempt = await attemptMutationBody(request);
    if (attempt instanceof Response) return attempt;
    try {
      await retryKnowledgeUploadItem(deps, {
        attemptNumber: attempt.attemptNumber,
        batchId: owner.batchId!,
        config: configs(deps).upload,
        itemId: owner.itemId!,
        knowledgeBaseId: owner.baseId,
        now: deps.now?.() ?? new Date(),
        userId: owner.userId
      });
    } catch (error) {
      const response = serviceError(error);
      if (response) return response;
      throw error;
    }
    return batchResponse(deps, {
      baseId: owner.baseId,
      batchId: owner.batchId!,
      userId: owner.userId
    });
  };
}

export function createCancelKnowledgeUploadItemHandler(deps: KnowledgeUploadHandlerDeps) {
  return async function DELETE(request: Request, context: ItemContext): Promise<Response> {
    const owner = await authBase(deps, request, context);
    if (owner instanceof Response) return owner;
    const attempt = await attemptMutationBody(request);
    if (attempt instanceof Response) return attempt;
    try {
      await cancelKnowledgeUploadItem(deps, {
        attemptNumber: attempt.attemptNumber,
        batchId: owner.batchId!,
        itemId: owner.itemId!,
        knowledgeBaseId: owner.baseId,
        now: deps.now?.() ?? new Date(),
        userId: owner.userId
      });
    } catch (error) {
      const response = serviceError(error);
      if (response) return response;
      throw error;
    }
    return batchResponse(deps, {
      baseId: owner.baseId,
      batchId: owner.batchId!,
      userId: owner.userId
    });
  };
}
