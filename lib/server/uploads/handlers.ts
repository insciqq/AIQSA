import { inspectPdfForModelProcessing } from "../parsing/pdfPreparation";
import { getPdfExtractionConfig } from "./pdfConfig";
import { DocumentParserError } from "../parsing/errors";
import { createHash, randomUUID } from "node:crypto";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readBoundedFormData, RequestBodyTooLargeError } from "../http/requestBody";
import { getRequestBodyConfig, type RequestBodyConfig } from "../http/requestBodyConfig";
import { resolveUploadPermitGate, type UploadPermitGate } from "../http/uploadPermitGate";
import { normalizeUploadRaster } from "./rasterNormalization";
import { createS3StorageAdapter, type StorageAdapter } from "./storage";
import { declaredContentLength, refuseUpload, type UploadRefusalFacts } from "./uploadRefusal";
import { defaultUploadMaxBytes, validateUpload, type UploadKind, type UploadValidationResult } from "./validation";

export type CreatedAttachment = {
  byteSize: number;
  checksum: string;
  extractedText: string | null;
  fileName: string;
  id: string;
  kind: UploadKind;
  metadata: unknown;
  mimeType: string;
  processingErrorCode: null;
  status: "processing" | "ready";
  storageKey: string;
  updatedAt?: Date | string;
};

export type UploadHandlerDeps = {
  createAttachment(
    input: Omit<CreatedAttachment, "id" | "updatedAt"> & {
      processingOwnerUserId?: string;
      userId: string;
    }
  ): Promise<CreatedAttachment>;
  deletionOutbox?: {
    complete(jobId: string): Promise<void>;
    stage(storageKey: string): Promise<{ id: string }>;
  };
  getBodyConfig?: (uploadMaxBytes: number) => Pick<RequestBodyConfig, "uploadMaxConcurrency" | "uploadMultipartMaxBytes">;
  getMaxBytes?: () => number;
  kickProcessing?: () => void;
  resolveAuth: RequestAuthResolver;
  storage?: StorageAdapter;
  uploadPermitGate?: UploadPermitGate;
  workspaceScopeAvailable?: () => Promise<boolean>;
};

function safeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function refusalStatus(code: Extract<UploadValidationResult, { ok: false }>["code"]): 400 | 413 {
  return code === "file_too_large" || code === "image_limit_exceeded" ? 413 : 400;
}

function checksum(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function createUploadHandler(deps: UploadHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    // Every refusal goes through `refuse`, which logs its code with a size
    // bucket and MIME family: the declared body length until the form is
    // read, then the file's own size and declared type.
    const facts: UploadRefusalFacts = { byteSize: declaredContentLength(request) };
    const refuse = (
      stage: NonNullable<UploadRefusalFacts["stage"]>,
      code: string,
      status: number,
      extra: { body?: Readonly<Record<string, unknown>>; headers?: HeadersInit } = {}
    ) => refuseUpload({ ...facts, ...extra, code, operation: "upload", stage, status });

    const auth = await deps.resolveAuth(request);
    if (!auth) {
      return refuse("auth", "unauthorized", 401);
    }

    const maxBytes = deps.getMaxBytes?.() ?? defaultUploadMaxBytes();
    const bodyConfig = deps.getBodyConfig?.(maxBytes) ?? getRequestBodyConfig(process.env, maxBytes);
    const permitGate = deps.uploadPermitGate ?? resolveUploadPermitGate(bodyConfig.uploadMaxConcurrency);
    const releasePermit = permitGate.tryAcquire();

    if (!releasePermit) {
      return refuse("capacity", "upload_busy", 429, {
        body: { message: "Upload capacity is busy. Try again shortly." },
        headers: { "retry-after": "1" }
      });
    }

    try {
      let form: FormData;
      try {
        form = await readBoundedFormData(request, bodyConfig.uploadMultipartMaxBytes);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return refuse("body", "file_too_large", 413, { body: {
            limit: bodyConfig.uploadMultipartMaxBytes,
            message: `Upload envelope exceeds the ${bodyConfig.uploadMultipartMaxBytes}-byte limit.`
          } });
        }

        if (request.signal.aborted) {
          throw error;
        }

        return refuse("body", "file_required", 400);
      }

      const file = form.get("file");

      if (!(file instanceof File)) {
        return refuse("declaration", "file_required", 400);
      }
      facts.byteSize = file.size;
      facts.mimeType = file.type;

      const requestedScope = form.get("scope");
      const scope = requestedScope === "workspace" ? "workspace" as const : "attachment" as const;
      if (requestedScope !== null && requestedScope !== "" && requestedScope !== "workspace") {
        return refuse("declaration", "unsupported_type", 400);
      }
      const initialValidation = validateUpload({
        byteSize: file.size,
        fileName: file.name,
        maxBytes,
        mimeType: file.type,
        scope
      });

      if (!initialValidation.ok) {
        return refuse("declaration", initialValidation.code, refusalStatus(initialValidation.code));
      }
      if (initialValidation.kind === "file") {
        let workspaceAvailable = false;
        try {
          workspaceAvailable = await deps.workspaceScopeAvailable?.() === true;
        } catch {
          workspaceAvailable = false;
        }
        if (!workspaceAvailable) {
          return refuse("workspace", "workspace_runtime_unavailable", 503);
        }
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const validation = validateUpload({
        byteSize: buffer.byteLength,
        bytes: buffer,
        fileName: file.name,
        maxBytes,
        mimeType: file.type,
        scope
      });

      if (!validation.ok) {
        return refuse("content", validation.code, refusalStatus(validation.code));
      }

      let fileName = file.name;
      let mimeType = validation.mimeType;
      if (validation.rasterCheck) {
        const normalized = await normalizeUploadRaster(buffer, {
          fileName: file.name, format: validation.rasterCheck, signal: request.signal
        });
        if (!normalized.ok) return refuse("content", normalized.code, normalized.status);
        ({ fileName, mimeType } = normalized);
      }

      let pdfPageCount: number | undefined;
      if (validation.kind === "pdf") {
        const config = getPdfExtractionConfig();
        try {
          pdfPageCount = (await inspectPdfForModelProcessing({ bytes: buffer,
            mode: "system_model_direct_pdf", signal: request.signal }, {
            maxPages: config.maxPages, timeoutMs: config.timeoutMs
          })).pageCount;
        } catch (error) {
          if (request.signal.aborted) throw error;
          if (error instanceof DocumentParserError && error.code === "parser_output_too_large") {
            return refuse("pdf", "pdf_page_limit_exceeded", 413, { body: { maxPages: config.maxPages,
              message: "The PDF exceeds the page limit." } });
          }
          return refuse("pdf", "pdf_invalid", 400, { body: { message: "The PDF is corrupted, encrypted, or unsupported." } });
        }
      }

      const digest = checksum(buffer);
      const storageKey = `${auth.userId}/${randomUUID()}-${digest.slice(0, 16)}-${safeFileName(fileName)}`;
      const storage = deps.storage ?? createS3StorageAdapter();
      await storage.putObject({
        body: buffer,
        contentType: mimeType,
        storageKey
      });

      let attachment: CreatedAttachment;
      const status = (validation.kind === "file" || validation.kind === "pdf") ? "ready" as const : "processing" as const;
      try {
        attachment = await deps.createAttachment({
          byteSize: buffer.byteLength,
          checksum: digest,
          extractedText: null,
          fileName,
          kind: validation.kind,
          metadata: pdfPageCount === undefined ? {} : { pdfPageCount },
          mimeType,
          processingErrorCode: null,
          status,
          storageKey,
          processingOwnerUserId: auth.userId,
          userId: auth.userId
        });
      } catch (error) {
        let cleanupJob: { id: string } | null = null;

        try {
          cleanupJob = (await deps.deletionOutbox?.stage(storageKey)) ?? null;
        } catch {
          // Direct object cleanup remains useful when persistence itself is unavailable.
        }

        try {
          await storage.deleteObject(storageKey);
          if (cleanupJob) {
            await deps.deletionOutbox?.complete(cleanupJob.id);
          }
        } catch {
          // A staged job is retryable; if staging failed, preserve the original DB error.
        }

        throw error;
      }

      if (attachment.status === "processing") {
        try {
          deps.kickProcessing?.();
        } catch {
          // The persisted job is authoritative; the coordinator interval or a
          // later process restart will reconcile it if this wake-up fails.
        }
      }

      return Response.json({
        attachment: {
          byteSize: attachment.byteSize,
          extractedText: attachment.extractedText,
          fileName: attachment.fileName,
          id: attachment.id,
          kind: attachment.kind,
          ...(attachment.kind === "pdf" ? { pageCount: pdfPageCount } : { metadata: attachment.metadata }),
          mimeType: attachment.mimeType,
          processingErrorCode: attachment.processingErrorCode,
          status: attachment.status,
          ...(attachment.updatedAt
            ? { updatedAt: new Date(attachment.updatedAt).toISOString() }
            : {})
        }
      });
    } finally {
      releasePermit();
    }
  };
}
