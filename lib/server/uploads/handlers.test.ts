// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { getAuthConfig, TEST_AUTH_TOKEN } from "../auth/config";
import { createTestAuth } from "@/tests/support/auth";
import { createUploadPermitGate } from "../http/uploadPermitGate";
import {
  createUploadHandler,
  type CreatedAttachment,
  UploadTargetUnavailableError
} from "./handlers";
import { createMemoryStorageAdapter } from "@/tests/support/storage";

const oneByOnePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);
const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: TEST_AUTH_TOKEN,
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({ user: { id: config.bootstrapUserId } });

function authenticatedUploadRequest(
  file: File,
  signal?: AbortSignal,
  projectId?: string,
  scope?: "workspace"
): Request {
  const form = new FormData();
  form.set("file", file);
  if (projectId) form.set("projectId", projectId);
  if (scope) form.set("scope", scope);
  return new Request("http://app.local/api/uploads", {
    body: form,
    headers: { cookie: auth.cookie },
    method: "POST",
    ...(signal ? { signal } : {})
  });
}

function created(
  input: Omit<CreatedAttachment, "id" | "updatedAt"> & { userId: string },
  id = "attachment-1"
): CreatedAttachment {
  return { ...input, id, updatedAt: new Date("2026-08-08T00:00:00.000Z") };
}

describe("upload handler", () => {
  it("authenticates before consuming an upload body", async () => {
    let bodyReads = 0;
    const request = new Request("http://app.local/api/uploads", { method: "POST" });
    Object.defineProperty(request, "body", {
      configurable: true,
      get() { bodyReads += 1; return null; }
    });
    const POST = createUploadHandler({
      createAttachment: async () => { throw new Error("should_not_create"); },
      resolveAuth: auth.resolveAuth
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(bodyReads).toBe(0);
  });

  it("rejects an oversized multipart envelope before parsing it", async () => {
    const boundary = "aiqsa-test-boundary";
    const multipartChunk = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\noversized`
    );
    let cancelledWith: unknown;
    const POST = createUploadHandler({
      createAttachment: async () => { throw new Error("should_not_create"); },
      getBodyConfig: () => ({ uploadMaxConcurrency: 1, uploadMultipartMaxBytes: 16 }),
      resolveAuth: auth.resolveAuth,
      uploadPermitGate: createUploadPermitGate(1)
    });
    const request = new Request("http://app.local/api/uploads", {
      body: new ReadableStream<Uint8Array>({
        cancel(reason) { cancelledWith = reason; },
        start(controller) { controller.enqueue(multipartChunk); }
      }),
      duplex: "half",
      headers: {
        cookie: auth.cookie,
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      method: "POST"
    } as RequestInit);

    const response = await POST(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "file_too_large", limit: 16 });
    expect(cancelledWith).toMatchObject({
      actualBytes: multipartChunk.byteLength,
      limitBytes: 16,
      message: "request_body_too_large",
      name: "RequestBodyTooLargeError"
    });
  });

  it("rejects upload concurrency without reading the request body", async () => {
    const gate = createUploadPermitGate(1);
    const release = gate.tryAcquire();
    const POST = createUploadHandler({
      createAttachment: async () => { throw new Error("should_not_create"); },
      getBodyConfig: () => ({ uploadMaxConcurrency: 1, uploadMultipartMaxBytes: 1024 }),
      resolveAuth: auth.resolveAuth,
      uploadPermitGate: gate
    });
    const request = authenticatedUploadRequest(
      new File([oneByOnePng], "avatar.png", { type: "image/png" })
    );
    const originalBody = request.body;
    let bodyReads = 0;
    Object.defineProperty(request, "body", {
      configurable: true,
      get() { bodyReads += 1; return originalBody; }
    });

    const response = await POST(request);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(bodyReads).toBe(0);
    release?.();
  });

  it("releases its permit after malformed or cancelled multipart input", async () => {
    const gate = createUploadPermitGate(1);
    const POST = createUploadHandler({
      createAttachment: async () => { throw new Error("should_not_create"); },
      getBodyConfig: () => ({ uploadMaxConcurrency: 1, uploadMultipartMaxBytes: 1024 }),
      resolveAuth: auth.resolveAuth,
      uploadPermitGate: gate
    });
    const malformed = await POST(new Request("http://app.local/api/uploads", {
      body: "not-multipart",
      headers: { cookie: auth.cookie, "content-type": "multipart/form-data; boundary=missing" },
      method: "POST"
    }));
    expect(malformed.status).toBe(400);
    expect(gate.snapshot().active).toBe(0);

    const controller = new AbortController();
    const reason = new Error("upload_cancelled");
    const cancelled = new Request("http://app.local/api/uploads", {
      body: new ReadableStream<Uint8Array>(),
      duplex: "half",
      headers: { cookie: auth.cookie, "content-type": "multipart/form-data; boundary=pending" },
      method: "POST",
      signal: controller.signal
    } as RequestInit);
    controller.abort(reason);
    await expect(POST(cancelled)).rejects.toBe(reason);
    expect(gate.snapshot().active).toBe(0);
  });

  it("settles storage then creates one processing row and kicks durable work", async () => {
    const storage = createMemoryStorageAdapter();
    const kickProcessing = vi.fn();
    let persisted: Parameters<Parameters<typeof createUploadHandler>[0]["createAttachment"]>[0] | null = null;
    const POST = createUploadHandler({
      async createAttachment(input) {
        persisted = input;
        return created(input);
      },
      kickProcessing,
      resolveAuth: auth.resolveAuth,
      storage
    });

    const response = await POST(authenticatedUploadRequest(
      new File([oneByOnePng], "avatar.png", { type: "image/png" })
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(persisted).toMatchObject({
      byteSize: oneByOnePng.byteLength,
      extractedText: null,
      fileName: "avatar.png",
      kind: "image",
      metadata: {},
      mimeType: "image/png",
      processingErrorCode: null,
      status: "processing",
      userId: config.bootstrapUserId
    });
    expect(storage.objects.has(persisted!.storageKey)).toBe(true);
    expect(body).toEqual({
      attachment: {
        byteSize: oneByOnePng.byteLength,
        extractedText: null,
        fileName: "avatar.png",
        id: "attachment-1",
        kind: "image",
        metadata: {},
        mimeType: "image/png",
        processingErrorCode: null,
        status: "processing",
        updatedAt: "2026-08-08T00:00:00.000Z"
      }
    });
    expect(body.attachment).not.toHaveProperty("checksum");
    expect(body.attachment).not.toHaveProperty("storageKey");
    expect(kickProcessing).toHaveBeenCalledOnce();
  });

  it("admits opaque files only while the Workspace runtime is available", async () => {
    const unavailableStorage = createMemoryStorageAdapter();
    const unavailableCreate = vi.fn(async (input) => created(input));
    const unavailable = createUploadHandler({
      createAttachment: unavailableCreate,
      resolveAuth: auth.resolveAuth,
      storage: unavailableStorage,
      workspaceScopeAvailable: async () => false
    });
    const opaqueFile = () => new File(
      [Buffer.from([0, 1, 2, 3])],
      "payload.aiqsa-opaque",
      { type: "application/x-aiqsa-opaque" }
    );

    const rejected = await unavailable(authenticatedUploadRequest(
      opaqueFile(),
      undefined,
      undefined,
      "workspace"
    ));
    expect(rejected.status).toBe(503);
    await expect(rejected.json()).resolves.toEqual({ error: "workspace_runtime_unavailable" });
    expect(unavailableCreate).not.toHaveBeenCalled();
    expect(unavailableStorage.objects.size).toBe(0);

    const storage = createMemoryStorageAdapter();
    const kickProcessing = vi.fn();
    let persisted: Parameters<Parameters<typeof createUploadHandler>[0]["createAttachment"]>[0] | null = null;
    const available = createUploadHandler({
      async createAttachment(input) {
        persisted = input;
        return created(input);
      },
      kickProcessing,
      resolveAuth: auth.resolveAuth,
      storage,
      workspaceScopeAvailable: async () => true
    });
    const accepted = await available(authenticatedUploadRequest(
      opaqueFile(),
      undefined,
      undefined,
      "workspace"
    ));
    expect(accepted.status).toBe(200);
    expect(persisted).toMatchObject({
      kind: "file",
      mimeType: "application/x-aiqsa-opaque",
      status: "ready"
    });
    expect(kickProcessing).not.toHaveBeenCalled();
    expect(storage.objects.size).toBe(1);
  });

  it("returns the committed processing row when the process-local wake-up fails", async () => {
    const POST = createUploadHandler({
      createAttachment: async (input) => created(input),
      kickProcessing() {
        throw new Error("coordinator_wakeup_failed");
      },
      resolveAuth: auth.resolveAuth,
      storage: createMemoryStorageAdapter()
    });

    const response = await POST(authenticatedUploadRequest(
      new File([oneByOnePng], "avatar.png", { type: "image/png" })
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      attachment: { id: "attachment-1", status: "processing" }
    });
  });

  it("uses a unique private object key for identical uploads", async () => {
    const storage = createMemoryStorageAdapter();
    const persisted: Array<{ checksum: string; storageKey: string }> = [];
    const POST = createUploadHandler({
      async createAttachment(input) {
        persisted.push({ checksum: input.checksum, storageKey: input.storageKey });
        return created(input, `attachment-${persisted.length}`);
      },
      resolveAuth: auth.resolveAuth,
      storage
    });
    const upload = () => POST(authenticatedUploadRequest(
      new File([oneByOnePng], "same.png", { type: "image/png" })
    ));

    await upload();
    await upload();

    expect(persisted[0]!.checksum).toBe(persisted[1]!.checksum);
    expect(persisted[0]!.storageKey).not.toBe(persisted[1]!.storageKey);
    expect(storage.objects.size).toBe(2);
  });

  it("removes a just-written object and settles its outbox job when row creation fails", async () => {
    const storage = createMemoryStorageAdapter();
    const staged: string[] = [];
    const completed: string[] = [];
    const POST = createUploadHandler({
      createAttachment: async () => { throw new Error("attachment_row_failed"); },
      deletionOutbox: {
        async complete(jobId) { completed.push(jobId); },
        async stage(storageKey) { staged.push(storageKey); return { id: "cleanup-job" }; }
      },
      resolveAuth: auth.resolveAuth,
      storage
    });

    await expect(POST(authenticatedUploadRequest(
      new File([oneByOnePng], "failed.png", { type: "image/png" })
    ))).rejects.toThrow("attachment_row_failed");
    expect(staged).toHaveLength(1);
    expect(completed).toEqual(["cleanup-job"]);
    expect(storage.objects.size).toBe(0);
  });

  it("returns an unavailable Project target without retaining the uploaded object", async () => {
    const storage = createMemoryStorageAdapter();
    const completed: string[] = [];
    const POST = createUploadHandler({
      createAttachment: async () => { throw new UploadTargetUnavailableError(); },
      deletionOutbox: {
        async complete(jobId) { completed.push(jobId); },
        async stage() { return { id: "cleanup-job" }; }
      },
      resolveAuth: auth.resolveAuth,
      resolveTarget: async ({ projectId }) => ({ projectId }),
      storage
    });

    const response = await POST(authenticatedUploadRequest(
      new File([oneByOnePng], "revoked.png", { type: "image/png" }),
      undefined,
      "project-1"
    ));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "project_not_found" });
    expect(completed).toEqual(["cleanup-job"]);
    expect(storage.objects.size).toBe(0);
  });

  it("leaves a durable cleanup job when post-put deletion fails", async () => {
    const memory = createMemoryStorageAdapter();
    const staged: string[] = [];
    const completed: string[] = [];
    const POST = createUploadHandler({
      createAttachment: async () => { throw new Error("attachment_row_failed"); },
      deletionOutbox: {
        async complete(jobId) { completed.push(jobId); },
        async stage(storageKey) { staged.push(storageKey); return { id: "cleanup-job" }; }
      },
      resolveAuth: auth.resolveAuth,
      storage: { ...memory, async deleteObject() { throw new Error("storage_unavailable"); } }
    });

    await expect(POST(authenticatedUploadRequest(
      new File([oneByOnePng], "failed.png", { type: "image/png" })
    ))).rejects.toThrow("attachment_row_failed");
    expect(staged).toHaveLength(1);
    expect(completed).toEqual([]);
    expect(memory.objects.has(staged[0]!)).toBe(true);
  });

  it("releases the upload permit when object storage fails", async () => {
    const gate = createUploadPermitGate(1);
    const POST = createUploadHandler({
      createAttachment: async () => { throw new Error("should_not_create"); },
      resolveAuth: auth.resolveAuth,
      storage: {
        async deleteObject() {},
        async getObject() { throw new Error("should_not_read"); },
        async putObject() { throw new Error("storage_unavailable"); }
      },
      uploadPermitGate: gate
    });

    await expect(POST(authenticatedUploadRequest(
      new File([oneByOnePng], "failed.png", { type: "image/png" })
    ))).rejects.toThrow("storage_unavailable");
    expect(gate.snapshot().active).toBe(0);
  });

  it("rejects spoofed magic bytes before storage or row creation", async () => {
    const storage = createMemoryStorageAdapter();
    const createAttachment = vi.fn(async (input) => created(input));
    const POST = createUploadHandler({
      createAttachment,
      resolveAuth: auth.resolveAuth,
      storage
    });

    const response = await POST(authenticatedUploadRequest(
      new File([Buffer.from("%PDF-1.4\n")], "spoof.png", { type: "image/png" })
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "unsupported_type" });
    expect(createAttachment).not.toHaveBeenCalled();
    expect(storage.objects.size).toBe(0);
  });
});
