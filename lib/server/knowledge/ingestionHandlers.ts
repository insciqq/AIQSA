import { createHash, randomUUID } from "node:crypto";
import {
  decodeKnowledgeReindex,
  type KnowledgeDocumentMutationResponse,
  type KnowledgeDocumentStatus,
  type KnowledgeIngestionStatusResponse,
  type KnowledgeReindexResponse
} from "../../contracts/knowledge";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  readBoundedFormData,
  readJsonBodyOrNull,
  requestBodyErrorResponse,
  RequestBodyTooLargeError
} from "../http/requestBody";
import { getRequestBodyConfig, type RequestBodyConfig } from "../http/requestBodyConfig";
import { resolveUploadPermitGate, type UploadPermitGate } from "../http/uploadPermitGate";
import { resolveDocumentParserRoute } from "../parsing";
import type { StorageAdapter } from "../uploads/storage";
import { validateUpload } from "../uploads/validation";
import {
  getKnowledgeExtractionConfig,
  type KnowledgeExtractionConfig
} from "./knowledgeExtractionConfig";
import type {
  KnowledgeDocumentMutationResult,
  KnowledgeReindexStartResult,
  KnowledgeVersionCreateInput,
  KnowledgeVersionCreateResult,
  PrismaKnowledgeIngestionRepository
} from "./prismaIngestionRepository";

export type KnowledgeIngestionHandlerDeps = Readonly<{
  deletionOutbox: Readonly<{
    complete(jobId: string): Promise<void>;
    stage(storageKey: string): Promise<{ id: string }>;
  }>;
  getBodyConfig?: (
    uploadMaxBytes: number
  ) => Pick<RequestBodyConfig, "uploadMaxConcurrency" | "uploadMultipartMaxBytes">;
  getConfig?: () => KnowledgeExtractionConfig;
  kickProcessing?: () => void;
  repository: Pick<
    PrismaKnowledgeIngestionRepository,
    | "archiveDocument"
    | "canManage"
    | "createVersion"
    | "listStatus"
    | "retryVersion"
    | "startReindex"
  >;
  resolveAuth: RequestAuthResolver;
  storage: Pick<StorageAdapter, "deleteObject" | "putObject">;
  uploadPermitGate?: UploadPermitGate;
}>;

type BaseContext = {
  params: Promise<{ baseId: string }> | { baseId: string };
};

type DocumentContext = {
  params:
    | Promise<{ baseId: string; documentId: string }>
    | { baseId: string; documentId: string };
};

type VersionContext = {
  params:
    | Promise<{ baseId: string; documentId: string; versionId: string }>
    | { baseId: string; documentId: string; versionId: string };
};

function errorJson(code: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error: code }, { headers, status });
}

function boundedId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    !/[\u0000-\u0020\u007f]/u.test(value)
    ? value
    : null;
}

function safeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 180) || "document";
}

function checksum(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function kick(deps: KnowledgeIngestionHandlerDeps): void {
  try {
    deps.kickProcessing?.();
  } catch {
    // The database queue is authoritative; interval/restart reconciliation remains available.
  }
}

async function cleanupStoredObject(
  deps: KnowledgeIngestionHandlerDeps,
  storageKey: string
): Promise<void> {
  let job: { id: string } | null = null;
  try {
    job = await deps.deletionOutbox.stage(storageKey);
  } catch {
    // Direct cleanup remains useful if outbox persistence is unavailable.
  }
  try {
    await deps.storage.deleteObject(storageKey);
    if (job) await deps.deletionOutbox.complete(job.id);
  } catch {
    // A persisted job remains retryable. Preserve the caller's stable result.
  }
}

function documentFromStatus(
  status: KnowledgeIngestionStatusResponse | null,
  documentId: string
): KnowledgeDocumentStatus | null {
  return status?.documents.find((document) => document.id === documentId) ?? null;
}

async function ownerParams(
  deps: KnowledgeIngestionHandlerDeps,
  request: Request,
  context: BaseContext | DocumentContext | VersionContext
): Promise<
  | Readonly<{ baseId: string; documentId: string | null; userId: string; versionId: string | null }>
  | Response
> {
  const auth = await deps.resolveAuth(request);
  if (!auth) return errorJson("unauthorized", 401);
  const params = await context.params;
  const baseId = boundedId(params.baseId);
  const documentId = "documentId" in params ? boundedId(params.documentId) : null;
  const versionId = "versionId" in params ? boundedId(params.versionId) : null;
  if (!baseId || ("documentId" in params && !documentId) || ("versionId" in params && !versionId)) {
    return errorJson("knowledge_base_not_available", 404);
  }
  if (!await deps.repository.canManage(auth.userId, baseId)) {
    return errorJson("knowledge_base_not_available", 404);
  }
  return { baseId, documentId, userId: auth.userId, versionId };
}

function createKnowledgeDocumentUploadHandler(
  deps: KnowledgeIngestionHandlerDeps,
  replacing: boolean
) {
  return async function POST(
    request: Request,
    context: BaseContext | DocumentContext
  ): Promise<Response> {
    const owner = await ownerParams(deps, request, context);
    if (owner instanceof Response) return owner;
    if (replacing && !owner.documentId) return errorJson("knowledge_base_not_available", 404);

    const config = deps.getConfig?.() ?? getKnowledgeExtractionConfig();
    const bodyConfig = deps.getBodyConfig?.(config.maxFileBytes) ??
      getRequestBodyConfig(process.env, config.maxFileBytes);
    const gate = deps.uploadPermitGate ?? resolveUploadPermitGate(bodyConfig.uploadMaxConcurrency);
    const release = gate.tryAcquire();
    if (!release) {
      return errorJson("upload_busy", 429, { "retry-after": "1" });
    }

    try {
      let form: FormData;
      try {
        form = await readBoundedFormData(request, bodyConfig.uploadMultipartMaxBytes);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return errorJson("knowledge_file_limit_exceeded", 413);
        }
        if (request.signal.aborted) throw error;
        return errorJson("file_required", 400);
      }
      const file = form.get("file");
      if (!(file instanceof File)) return errorJson("file_required", 400);
      if (file.name.length > 512 || Buffer.byteLength(file.name, "utf8") > 1_024) {
        return errorJson("unsupported_type", 400);
      }
      const initial = validateUpload({
        byteSize: file.size,
        fileName: file.name,
        maxBytes: config.maxFileBytes,
        mimeType: file.type
      });
      if (!initial.ok) {
        return errorJson(
          initial.code === "file_too_large" ? "knowledge_file_limit_exceeded" : initial.code,
          initial.code === "file_too_large" ? 413 : 400
        );
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const validation = validateUpload({
        byteSize: buffer.byteLength,
        bytes: buffer,
        fileName: file.name,
        maxBytes: config.maxFileBytes,
        mimeType: file.type
      });
      if (!validation.ok || !resolveDocumentParserRoute(file.name, validation.ok ? validation.mimeType : file.type)) {
        return errorJson(
          !validation.ok && validation.code === "file_too_large"
            ? "knowledge_file_limit_exceeded"
            : "unsupported_type",
          !validation.ok && validation.code === "file_too_large" ? 413 : 400
        );
      }

      const digest = checksum(buffer);
      const documentId = owner.documentId ?? randomUUID();
      const documentVersionId = randomUUID();
      const originalStorageKey = [
        "knowledge",
        owner.userId,
        owner.baseId,
        `${randomUUID()}-${digest.slice(0, 16)}-${safeFileName(file.name)}`
      ].join("/");
      const normalizedTextStorageKey = [
        "knowledge",
        owner.userId,
        owner.baseId,
        documentId,
        documentVersionId,
        "normalized-v1.json"
      ].join("/");
      try {
        await deps.storage.putObject({
          body: buffer,
          contentType: validation.mimeType,
          storageKey: originalStorageKey
        });
      } catch {
        return errorJson("knowledge_storage_unavailable", 503);
      }

      let created: KnowledgeVersionCreateResult;
      try {
        const creation: KnowledgeVersionCreateInput = {
          byteSize: buffer.byteLength,
          checksum: digest,
          documentId,
          documentVersionId,
          fileName: file.name,
          knowledgeBaseId: owner.baseId,
          mimeType: validation.mimeType,
          normalizedTextStorageKey,
          originalStorageKey,
          replaceDocumentId: owner.documentId,
          userId: owner.userId
        };
        created = await deps.repository.createVersion(creation);
      } catch (error) {
        await cleanupStoredObject(deps, originalStorageKey);
        throw error;
      }
      if (created.kind !== "ok") {
        await cleanupStoredObject(deps, originalStorageKey);
        return created.kind === "active_ingest"
          ? errorJson("knowledge_document_ingest_in_progress", 409)
          : errorJson("knowledge_base_not_available", 404);
      }
      kick(deps);
      const status = await deps.repository.listStatus(owner.userId, owner.baseId);
      const document = documentFromStatus(status, created.documentId);
      if (!document) return errorJson("knowledge_base_not_available", 404);
      return Response.json(
        { document } satisfies KnowledgeDocumentMutationResponse,
        { status: 202 }
      );
    } finally {
      release();
    }
  };
}

export function createListKnowledgeDocumentsHandler(deps: KnowledgeIngestionHandlerDeps) {
  return async function GET(request: Request, context: BaseContext): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) return errorJson("unauthorized", 401);
    const baseId = boundedId((await context.params).baseId);
    if (!baseId) return errorJson("knowledge_base_not_available", 404);
    const status = await deps.repository.listStatus(auth.userId, baseId);
    if (!status) return errorJson("knowledge_base_not_available", 404);
    return Response.json(status satisfies KnowledgeIngestionStatusResponse, {
      headers: { "cache-control": "no-store" }
    });
  };
}

export function createUploadKnowledgeDocumentHandler(deps: KnowledgeIngestionHandlerDeps) {
  return createKnowledgeDocumentUploadHandler(deps, false);
}

export function createReplaceKnowledgeDocumentHandler(deps: KnowledgeIngestionHandlerDeps) {
  return createKnowledgeDocumentUploadHandler(deps, true);
}

export function createArchiveKnowledgeDocumentHandler(deps: KnowledgeIngestionHandlerDeps) {
  return async function DELETE(request: Request, context: DocumentContext): Promise<Response> {
    const owner = await ownerParams(deps, request, context);
    if (owner instanceof Response) return owner;
    const result: KnowledgeDocumentMutationResult = await deps.repository.archiveDocument({
      documentId: owner.documentId!,
      knowledgeBaseId: owner.baseId,
      now: new Date(),
      userId: owner.userId
    });
    if (result.kind !== "ok") return errorJson("knowledge_base_not_available", 404);
    kick(deps);
    return new Response(null, { status: 204 });
  };
}

export function createRetryKnowledgeDocumentVersionHandler(deps: KnowledgeIngestionHandlerDeps) {
  return async function POST(request: Request, context: VersionContext): Promise<Response> {
    const owner = await ownerParams(deps, request, context);
    if (owner instanceof Response) return owner;
    const result = await deps.repository.retryVersion({
      documentId: owner.documentId!,
      knowledgeBaseId: owner.baseId,
      now: new Date(),
      userId: owner.userId,
      versionId: owner.versionId!
    });
    if (result.kind === "not_found") return errorJson("knowledge_base_not_available", 404);
    if (result.kind === "not_retryable") {
      return errorJson("knowledge_document_retry_not_available", 409);
    }
    kick(deps);
    const status = await deps.repository.listStatus(owner.userId, owner.baseId);
    const document = documentFromStatus(status, owner.documentId!);
    if (!document) return errorJson("knowledge_base_not_available", 404);
    return Response.json(
      { document } satisfies KnowledgeDocumentMutationResponse,
      { status: 202 }
    );
  };
}

export function createStartKnowledgeReindexHandler(deps: KnowledgeIngestionHandlerDeps) {
  return async function POST(request: Request, context: BaseContext): Promise<Response> {
    const owner = await ownerParams(deps, request, context);
    if (owner instanceof Response) return owner;
    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) return bodyError;
    const decoded = decodeKnowledgeReindex(body);
    if (!decoded.ok) return errorJson(decoded.code, 400);
    const result: KnowledgeReindexStartResult = await deps.repository.startReindex({
      embeddingDeploymentId: decoded.value.embeddingDeploymentId,
      knowledgeBaseId: owner.baseId,
      now: new Date(),
      userId: owner.userId
    });
    if (result.kind === "not_found") return errorJson("knowledge_base_not_available", 404);
    if (result.kind === "embedding_not_available") {
      return errorJson("knowledge_embedding_not_available", 400);
    }
    if (result.kind === "embedding_dimension_not_supported") {
      return errorJson("knowledge_embedding_dimension_not_supported", 400);
    }
    if (result.kind === "normalized_text_unavailable") {
      return errorJson("knowledge_normalized_text_unavailable", 409);
    }
    if (result.kind === "reindex_in_progress") {
      return errorJson("knowledge_reindex_in_progress", 409);
    }
    kick(deps);
    const status = await deps.repository.listStatus(owner.userId, owner.baseId);
    if (!status?.reindex || status.reindex.generationId !== result.generationId) {
      return errorJson("knowledge_base_not_available", 404);
    }
    return Response.json(
      { reindex: status.reindex } satisfies KnowledgeReindexResponse,
      { status: 202 }
    );
  };
}
