import { createHash, randomUUID } from "node:crypto";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readBoundedFormData, RequestBodyTooLargeError } from "../http/requestBody";
import { getRequestBodyConfig, type RequestBodyConfig } from "../http/requestBodyConfig";
import { resolveUploadPermitGate, type UploadPermitGate } from "../http/uploadPermitGate";
import { createS3StorageAdapter, type StorageAdapter } from "./storage";
import { defaultUploadMaxBytes, validateUpload, type UploadKind } from "./validation";

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

export class UploadTargetUnavailableError extends Error {
  constructor() {
    super("upload_target_unavailable");
    this.name = "UploadTargetUnavailableError";
  }
}

export type UploadHandlerDeps = {
  createAttachment(
    input: Omit<CreatedAttachment, "id" | "updatedAt"> & {
      projectId?: string | null;
      processingOwnerUserId?: string;
      uploaderDisplayName?: string | null;
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
  /**
   * Resolve the optional project target carried by the multipart form.  Keeping
   * this check in the route composition means the generic upload pipeline never
   * turns a client supplied project id into an authorization decision.
   */
  resolveTarget?: (input: Readonly<{
    projectId: string | null;
    userId: string;
  }>) => Promise<Readonly<{
    projectId: string | null;
    uploaderDisplayName?: string | null;
  }> | null>;
  resolveAuth: RequestAuthResolver;
  storage?: StorageAdapter;
  uploadPermitGate?: UploadPermitGate;
  workspaceScopeAvailable?: () => Promise<boolean>;
};

function safeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function checksum(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function createUploadHandler(deps: UploadHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const maxBytes = deps.getMaxBytes?.() ?? defaultUploadMaxBytes();
    const bodyConfig = deps.getBodyConfig?.(maxBytes) ?? getRequestBodyConfig(process.env, maxBytes);
    const permitGate = deps.uploadPermitGate ?? resolveUploadPermitGate(bodyConfig.uploadMaxConcurrency);
    const releasePermit = permitGate.tryAcquire();

    if (!releasePermit) {
      return Response.json(
        { error: "upload_busy", message: "Upload capacity is busy. Try again shortly." },
        { headers: { "retry-after": "1" }, status: 429 }
      );
    }

    try {
      let form: FormData;
      try {
        form = await readBoundedFormData(request, bodyConfig.uploadMultipartMaxBytes);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return Response.json(
            {
              error: "file_too_large",
              limit: bodyConfig.uploadMultipartMaxBytes,
              message: `Upload envelope exceeds the ${bodyConfig.uploadMultipartMaxBytes}-byte limit.`
            },
            { status: 413 }
          );
        }

        if (request.signal.aborted) {
          throw error;
        }

        return Response.json({ error: "file_required" }, { status: 400 });
      }

      const file = form.get("file");

      if (!(file instanceof File)) {
        return Response.json({ error: "file_required" }, { status: 400 });
      }

      const requestedProjectId = form.get("projectId");
      const requestedScope = form.get("scope");
      const scope = requestedScope === "workspace" ? "workspace" as const : "attachment" as const;
      if (requestedScope !== null && requestedScope !== "" && requestedScope !== "workspace") {
        return Response.json({ error: "unsupported_type" }, { status: 400 });
      }
      const projectId = typeof requestedProjectId === "string" && requestedProjectId.trim().length > 0
        ? requestedProjectId.trim()
        : null;
      if (projectId !== null && projectId.length > 128) {
        return Response.json({ error: "project_not_found" }, { status: 404 });
      }
      const target = deps.resolveTarget
        ? await deps.resolveTarget({ projectId, userId: auth.userId })
        : projectId === null
          ? { projectId: null }
          : null;
      if (!target) {
        return Response.json({ error: "project_not_found" }, { status: 404 });
      }

      const initialValidation = validateUpload({
        byteSize: file.size,
        fileName: file.name,
        maxBytes,
        mimeType: file.type,
        scope
      });

      if (!initialValidation.ok) {
        return Response.json(
          { error: initialValidation.code },
          { status: initialValidation.code === "file_too_large" ? 413 : 400 }
        );
      }
      if (initialValidation.kind === "file") {
        let workspaceAvailable = false;
        try {
          workspaceAvailable = await deps.workspaceScopeAvailable?.() === true;
        } catch {
          workspaceAvailable = false;
        }
        if (!workspaceAvailable) {
          return Response.json({ error: "workspace_runtime_unavailable" }, { status: 503 });
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
        return Response.json({ error: validation.code }, { status: validation.code === "file_too_large" ? 413 : 400 });
      }

      const digest = checksum(buffer);
      const storageKey = `${target.projectId ? `projects/${target.projectId}` : auth.userId}/${randomUUID()}-${digest.slice(0, 16)}-${safeFileName(file.name)}`;
      const storage = deps.storage ?? createS3StorageAdapter();
      await storage.putObject({
        body: buffer,
        contentType: validation.mimeType,
        storageKey
      });

      let attachment: CreatedAttachment;
      const status = validation.kind === "file" ? "ready" as const : "processing" as const;
      try {
        attachment = await deps.createAttachment({
          byteSize: buffer.byteLength,
          checksum: digest,
          extractedText: null,
          fileName: file.name,
          kind: validation.kind,
          metadata: {},
          mimeType: validation.mimeType,
          processingErrorCode: null,
          status,
          storageKey,
          ...(target.projectId ? { projectId: target.projectId } : {}),
          ...(target.uploaderDisplayName ? { uploaderDisplayName: target.uploaderDisplayName } : {}),
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

        if (error instanceof UploadTargetUnavailableError) {
          return Response.json({ error: "project_not_found" }, { status: 404 });
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
          metadata: attachment.metadata,
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
