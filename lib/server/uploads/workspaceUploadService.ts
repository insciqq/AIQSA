import type { WorkspaceUploadConfigWire, WorkspaceUploadWire } from "@/lib/contracts/workspaceUploads";
import { getRequestBodyConfig } from "../http/requestBodyConfig";
import { resolveUploadPermitGate, type UploadPermitGate } from "../http/uploadPermitGate";
import { runInBackground, reportSubsystemFailure } from "../observability";
import type { StorageAdapter } from "./storage";
import { defaultUploadMaxBytes, UPLOAD_CONTENT_INSPECTION_NEEDLES, validateUpload, validateUploadInspection } from "./validation";
import { WORKSPACE_UPLOAD_PART_BYTES, WORKSPACE_UPLOAD_REQUEST_MS, workspaceUploadMaxBytes } from "./workspaceUploadConfig";
import { type WorkspaceUploadRepository, WorkspaceUploadError, workspaceUploadProjection } from "./workspaceUploadRepository";
import { joinedUploadParts, meteredUploadBody, WorkspaceUploadStreamError } from "./workspaceUploadStreams";

type CreateInput = { byteSize: number; fileName: string; mimeType: string; projectId: string | null; idempotencyKey: string };

export function decodeWorkspaceUploadCreate(value: unknown): CreateInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["byteSize", "fileName", "mimeType", "projectId", "idempotencyKey"].includes(key)) ||
    typeof v.byteSize !== "number" || !Number.isSafeInteger(v.byteSize) || v.byteSize < 1 ||
    typeof v.fileName !== "string" || v.fileName.length < 1 || v.fileName.length > 512 ||
    typeof v.mimeType !== "string" || v.mimeType.length > 255 || /[\u0000-\u001f\u007f]/u.test(v.mimeType) ||
    !(v.projectId === null || typeof v.projectId === "string" && /^[a-zA-Z0-9-]{1,128}$/u.test(v.projectId)) ||
    typeof v.idempotencyKey !== "string" || !/^[a-zA-Z0-9-]{16,64}$/u.test(v.idempotencyKey)) return null;
  return v as CreateInput;
}

export class WorkspaceUploadService {
  #pending: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #rerun = false;
  #controllers = new Map<string, Set<AbortController>>();
  constructor(readonly deps: {
    repository: WorkspaceUploadRepository; storage: StorageAdapter; available(): Promise<boolean>;
    maxBytes?: () => number; ordinaryMaxBytes?: () => number; gate?: UploadPermitGate;
  }) {}

  #gate() { return this.deps.gate ?? resolveUploadPermitGate(getRequestBodyConfig().uploadMaxConcurrency); }
  #maxBytes() { return this.deps.maxBytes?.() ?? workspaceUploadMaxBytes(); }
  #streaming() {
    const { storage } = this.deps;
    if (!storage.putObjectStream || !storage.getObjectStream || !storage.inspectObject) throw new WorkspaceUploadError("upload_streaming_unavailable", 503);
  }
  async #available() {
    this.#streaming();
    if (!await this.deps.available()) throw new WorkspaceUploadError("workspace_runtime_unavailable", 503);
  }
  #own(id: string, controller: AbortController) {
    const controllers = this.#controllers.get(id) ?? new Set();
    controllers.add(controller); this.#controllers.set(id, controllers);
    return () => { controllers.delete(controller); if (!controllers.size) this.#controllers.delete(id); };
  }
  async config(): Promise<WorkspaceUploadConfigWire> {
    return { maxBytes: this.#maxBytes(), ordinaryMaxBytes: this.deps.ordinaryMaxBytes?.() ?? defaultUploadMaxBytes(),
      partBytes: WORKSPACE_UPLOAD_PART_BYTES, available: await this.deps.available() };
  }
  async create(input: CreateInput, userId: string): Promise<WorkspaceUploadWire> {
    const validation = validateUpload({ ...input, maxBytes: this.#maxBytes(), scope: "workspace" });
    if (!validation.ok) throw new WorkspaceUploadError(validation.code, validation.code === "file_too_large" ? 413 : 400);
    await this.#available();
    return workspaceUploadProjection(await this.deps.repository.create({ ...input, mimeType: validation.mimeType, userId }));
  }
  async get(id: string, userId: string) {
    this.kick();
    return workspaceUploadProjection(await this.deps.repository.get(id, userId));
  }
  async part(request: Request, id: string, userId: string, partNumber: number) {
    const checksum = request.headers.get("x-upload-sha256") ?? "";
    if (!/^[a-f0-9]{64}$/u.test(checksum) || !request.body ||
      request.headers.get("content-type") !== "application/octet-stream" || request.headers.has("content-encoding")) {
      throw new WorkspaceUploadError("upload_invalid_part", 400);
    }
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d{1,10}$/u.test(length) || Number(length) > WORKSPACE_UPLOAD_PART_BYTES)) {
      throw new WorkspaceUploadError("file_too_large", 413);
    }
    this.#streaming();
    const release = this.#gate().tryAcquire();
    if (!release) throw new WorkspaceUploadError("upload_busy", 429);
    try {
      const claim = await this.deps.repository.claimPart({ id, userId, partNumber, checksum });
      if (claim.duplicate) { await request.body.cancel().catch(() => undefined); return; }
      const { part } = claim;
      const controller = new AbortController();
      const abort = () => controller.abort(request.signal.reason);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      const timeout = setTimeout(() => controller.abort(new Error("upload_timeout")), WORKSPACE_UPLOAD_REQUEST_MS);
      timeout.unref?.();
      const unown = this.#own(id, controller);
      const stream = meteredUploadBody(request.body, { byteSize: part.byteSize, checksum, controller });
      let ready = false;
      try {
        if (length !== null && Number(length) !== part.byteSize) throw new WorkspaceUploadError("upload_size_mismatch", 400);
        controller.signal.throwIfAborted();
        await this.deps.storage.putObjectStream!({ body: stream.body, byteSize: part.byteSize, checksum,
          contentType: "application/octet-stream", storageKey: part.storageKey, signal: controller.signal });
        if (!stream.verified()) throw new WorkspaceUploadError("upload_size_mismatch", 400);
        ready = true;
      } catch (error) {
        const cause = controller.signal.reason instanceof WorkspaceUploadStreamError ? controller.signal.reason : error;
        if (cause instanceof WorkspaceUploadStreamError) throw new WorkspaceUploadError(cause.code, 400);
        throw error;
      } finally {
        controller.abort(); stream.dispose(); unown(); clearTimeout(timeout); request.signal.removeEventListener("abort", abort);
        const accepted = await this.deps.repository.finishPart({ id, userId, objectId: part.id, claimToken: part.claimToken!, ready });
        if (ready && !accepted) throw new WorkspaceUploadError("upload_not_writable");
      }
    } finally { release(); this.kick(); }
  }
  async complete(id: string, userId: string) {
    // A lost completion response remains idempotent even if runtime availability changed.
    const prior = await this.deps.repository.get(id, userId);
    if (prior.state === "completed") return workspaceUploadProjection(prior);
    await this.#available();
    const row = await this.deps.repository.complete(id, userId);
    this.kick(); return workspaceUploadProjection(row);
  }
  async cancel(id: string, userId: string) {
    const row = await this.deps.repository.cancel(id, userId);
    if (row.state !== "completed") for (const controller of this.#controllers.get(id) ?? []) controller.abort();
    this.kick(); return workspaceUploadProjection(row);
  }
  start() {
    if (this.#timer) return;
    this.#timer = runInBackground(() => setInterval(() => this.kick(), 5_000));
    this.#timer.unref?.(); this.kick();
  }
  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }
  kick() {
    this.#rerun = true;
    if (this.#pending) return;
    this.#pending = runInBackground(async () => {
      do { this.#rerun = false; await this.#drain(); } while (this.#rerun);
    }).catch(() => {
      reportSubsystemFailure({ subsystem: "attachments", stage: "process", code: "workspace_upload_recovery_failed", action: "retry" });
    }).finally(() => { this.#pending = null; if (this.#rerun) this.kick(); });
  }
  async reconcileNow() { this.kick(); await this.#pending; }
  async #drain() {
    const release = this.#gate().tryAcquire();
    if (!release) return;
    try {
      const claim = await this.deps.repository.claimSettlement();
      if (claim) {
        const { row, output } = claim;
        const token = row.claimToken!;
        const controller = new AbortController();
        const unown = this.#own(row.id, controller);
        const timeout = setTimeout(() => controller.abort(new Error("upload_timeout")), WORKSPACE_UPLOAD_REQUEST_MS);
        const heartbeat = setInterval(() => {
          void this.deps.repository.heartbeat(row.id, token).then(ok => { if (!ok) controller.abort(); }).catch(() => controller.abort());
        }, 5_000);
        timeout.unref?.(); heartbeat.unref?.();
        try {
          await this.#available();
          const parts = row.objects.filter(part => part.partNumber !== null && part.ready)
            .sort((a, b) => a.partNumber! - b.partNumber!);
          if (parts.length !== Math.ceil(row.byteSize / WORKSPACE_UPLOAD_PART_BYTES) ||
            parts.some((part, index) => part.partNumber !== index + 1) || parts.reduce((sum, part) => sum + part.byteSize, 0) !== row.byteSize) {
            throw new WorkspaceUploadError("upload_incomplete");
          }
          await this.deps.storage.putObjectStream!({ body: joinedUploadParts(this.deps.storage, parts, controller.signal),
            byteSize: row.byteSize, contentType: row.mimeType, storageKey: output.storageKey, signal: controller.signal });
          const inspected = await this.deps.storage.inspectObject!(output.storageKey, { maxBytes: row.byteSize,
            needles: UPLOAD_CONTENT_INSPECTION_NEEDLES, sampleBytes: 64 * 1024, signal: controller.signal });
          if (inspected.byteSize !== row.byteSize) throw new WorkspaceUploadError("upload_size_mismatch");
          const validation = validateUploadInspection({ ...inspected, fileName: row.fileName, mimeType: row.mimeType,
            maxBytes: row.byteSize, scope: "workspace" });
          if (!validation.ok) throw new WorkspaceUploadError(validation.code, 400);
          controller.signal.throwIfAborted();
          await this.deps.repository.settle({ id: row.id, claimToken: token, storageKey: output.storageKey, checksum: inspected.checksum });
        } catch (error) {
          await this.deps.repository.failSettlement(row.id, token,
            error instanceof WorkspaceUploadError ? error.code : "upload_verification_failed", !(error instanceof WorkspaceUploadError));
        } finally { clearInterval(heartbeat); clearTimeout(timeout); controller.abort(); unown(); }
      }
      const cleanup = await this.deps.repository.claimCleanup();
      if (cleanup) {
        // Upload objects themselves are the durable deletion obligations. They
        // survive account/Project deletion and are removed only after storage ack.
        for (const object of cleanup.objects) await this.deps.storage.deleteObject(object.storageKey);
        await this.deps.repository.finishCleanup(cleanup.row.id, cleanup.row.claimToken!);
      }
    } finally { release(); }
  }
}
