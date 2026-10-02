// @vitest-environment node

import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { IMAGE_MAX_BYTES } from "@/lib/contracts/imageGeneration";
import { getAuthConfig, TEST_AUTH_TOKEN } from "../auth/config";
import { createTestAuth } from "@/tests/support/auth";
import { createUploadPermitGate } from "../http/uploadPermitGate";
import {
  createUploadHandler,
  type CreatedAttachment,
  UploadTargetUnavailableError
} from "./handlers";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import {
  syntheticAnimatedWebp,
  syntheticJpeg,
  syntheticMpfJpeg,
  syntheticOversizedPng,
  syntheticPng,
  syntheticWebp
} from "@/tests/support/rasterFixtures";
import { StaticRasterError, validateStaticRaster } from "./staticRaster";

vi.mock("./staticRaster", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./staticRaster")>();
  return { ...actual, validateStaticRaster: vi.fn(actual.validateStaticRaster) };
});

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
  it("settles PDF originals and the safety page count without starting extraction", async () => {
    const document = await PDFDocument.create();
    for (let page = 0; page < 21; page += 1) document.addPage();
    const bytes = await document.save();
    const createAttachment = vi.fn(async (input) => created(input));
    const kickProcessing = vi.fn();
    const POST = createUploadHandler({ createAttachment, kickProcessing,
      resolveAuth: auth.resolveAuth, storage: createMemoryStorageAdapter() });
    const response = await POST(authenticatedUploadRequest(new File([bytes], "report.pdf", { type: "application/pdf" })));
    expect(response.status).toBe(200);
    expect((await response.json()).attachment).toMatchObject({ status: "ready", extractedText: null, pageCount: 21 });
    expect(createAttachment.mock.calls[0][0]).toMatchObject({ metadata: { pdfPageCount: 21 }, status: "ready" });
    expect(kickProcessing).not.toHaveBeenCalled();
  });

  it("rejects a malformed PDF before creating an attachment or object", async () => {
    const createAttachment = vi.fn();
    const storage = createMemoryStorageAdapter();
    const put = vi.spyOn(storage, "putObject");
    const POST = createUploadHandler({ createAttachment, resolveAuth: auth.resolveAuth, storage });
    const response = await POST(authenticatedUploadRequest(new File(["%PDF-1.4\nbroken"], "broken.pdf", { type: "application/pdf" })));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("pdf_invalid");
    expect(createAttachment).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

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

describe("upload handler static-raster normalization", () => {
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

  function rasterUpload(maxBytes?: number) {
    const storage = createMemoryStorageAdapter();
    const createAttachment = vi.fn(async (input: Parameters<Parameters<typeof createUploadHandler>[0]["createAttachment"]>[0]) => created(input));
    const POST = createUploadHandler({
      createAttachment,
      ...(maxBytes ? { getMaxBytes: () => maxBytes } : {}),
      resolveAuth: auth.resolveAuth,
      storage,
      workspaceScopeAvailable: async () => true
    });
    return { POST, createAttachment, storage };
  }

  it.each([
    { mimeType: "image/jpeg", scope: undefined },
    { mimeType: "image/png", scope: undefined },
    { mimeType: "", scope: undefined },
    { mimeType: "application/octet-stream", scope: undefined },
    { mimeType: "image/jpeg", scope: "workspace" as const },
    { mimeType: "image/png", scope: "workspace" as const }
  ])("admits a valid PNG named synthetic.jpeg ($mimeType, scope $scope) as synthetic.png", async ({ mimeType, scope }) => {
    vi.mocked(validateStaticRaster).mockClear();
    const png = syntheticPng();
    const { POST, createAttachment, storage } = rasterUpload();

    const response = await POST(authenticatedUploadRequest(new File([png], "synthetic.jpeg", { type: mimeType }), undefined, undefined, scope));

    expect(response.status).toBe(200);
    expect((await response.json()).attachment).toMatchObject({ fileName: "synthetic.png", kind: "image", mimeType: "image/png" });
    const persisted = createAttachment.mock.calls[0]![0];
    expect(persisted).toMatchObject({ byteSize: png.byteLength, checksum: sha256(png), fileName: "synthetic.png", kind: "image", mimeType: "image/png" });
    const object = storage.objects.get(persisted.storageKey)!;
    expect(object.contentType).toBe("image/png");
    expect(Buffer.compare(object.body, png)).toBe(0);
    expect(persisted.storageKey).toMatch(/-synthetic\.png$/u);
    expect(validateStaticRaster).toHaveBeenCalledOnce();
  });

  it("normalizes JPEG and WebP content and keeps a name that already fits the decoded format", async () => {
    const jpeg = await syntheticJpeg();
    const webp = await syntheticWebp();
    const cases = [
      { bytes: jpeg, fileName: "photo.png", mimeType: "image/png", expected: { fileName: "photo.jpg", mimeType: "image/jpeg" } },
      { bytes: jpeg, fileName: "photo.jpeg", mimeType: "image/png", expected: { fileName: "photo.jpeg", mimeType: "image/jpeg" } },
      { bytes: webp, fileName: "still.png", mimeType: "image/png", expected: { fileName: "still.webp", mimeType: "image/webp" } },
      { bytes: syntheticPng(), fileName: "still.webp", mimeType: "image/webp", expected: { fileName: "still.png", mimeType: "image/png" } }
    ];
    for (const { bytes, fileName, mimeType, expected } of cases) {
      const { POST, createAttachment, storage } = rasterUpload();
      const response = await POST(authenticatedUploadRequest(new File([bytes], fileName, { type: mimeType })));
      expect(response.status).toBe(200);
      expect((await response.json()).attachment).toMatchObject(expected);
      const persisted = createAttachment.mock.calls[0]![0];
      expect(persisted).toMatchObject({ ...expected, checksum: sha256(bytes) });
      expect(storage.objects.get(persisted.storageKey)?.contentType).toBe(expected.mimeType);
    }
  });

  it.each([
    { label: "truncated PNG", bytes: async () => syntheticPng().subarray(0, 40), error: "image_invalid", status: 400 },
    { label: "forged PNG signature", bytes: async () => Buffer.concat([syntheticPng().subarray(0, 8), Buffer.from("not an image body at all")]), error: "image_invalid", status: 400 },
    { label: "image beyond the pixel limit", bytes: syntheticOversizedPng, error: "image_limit_exceeded", status: 413 },
    { label: "APNG", bytes: async () => syntheticPng({ animated: true }), error: "unsupported_type", status: 400 },
    { label: "animated WebP", bytes: syntheticAnimatedWebp, error: "unsupported_type", status: 400 },
    { label: "MPF JPEG", bytes: syntheticMpfJpeg, error: "unsupported_type", status: 400 }
  ])("refuses a $label under another raster name with $error before storage", async ({ bytes, error, status }) => {
    const { POST, createAttachment, storage } = rasterUpload();
    const content = await bytes();
    const name = content[0] === 0xff ? "synthetic.png" : "synthetic.jpeg";

    const response = await POST(authenticatedUploadRequest(new File([content], name, { type: "image/jpeg" })));

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(createAttachment).not.toHaveBeenCalled();
    expect(storage.objects.size).toBe(0);
  });

  it("reports a decoder timeout as an unverifiable image", async () => {
    // validateStaticRaster classifies a sharp timeout as raster_invalid.
    vi.mocked(validateStaticRaster).mockRejectedValueOnce(new StaticRasterError("raster_invalid"));
    const { POST, createAttachment } = rasterUpload();

    const response = await POST(authenticatedUploadRequest(new File([syntheticPng()], "synthetic.jpeg", { type: "image/jpeg" })));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "image_invalid" });
    expect(createAttachment).not.toHaveBeenCalled();
  });

  it("refuses a rename beyond the safe file-name length", async () => {
    const { POST } = rasterUpload();
    const fits = await POST(authenticatedUploadRequest(new File([syntheticPng()], `${"a".repeat(251)}.jpg`, { type: "image/jpeg" })));
    expect(fits.status).toBe(200);
    const long = await POST(authenticatedUploadRequest(new File([await syntheticWebp()], `${"a".repeat(251)}.png`, { type: "image/png" })));
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({ error: "unsupported_type" });
  });

  it("refuses an image beyond the decode byte limit with 413 instead of decoding it", async () => {
    vi.mocked(validateStaticRaster).mockClear();
    const large = Buffer.concat([syntheticPng(), Buffer.alloc(IMAGE_MAX_BYTES)]);
    for (const mimeType of ["image/png", "image/jpeg"]) {
      const { POST, createAttachment } = rasterUpload(32 * 1024 * 1024);
      const response = await POST(authenticatedUploadRequest(new File([large], "large.jpeg", { type: mimeType })));
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "image_limit_exceeded" });
      expect(createAttachment).not.toHaveBeenCalled();
    }
    expect(validateStaticRaster).not.toHaveBeenCalled();
  });

  it("keeps matching uploads on the header-only path without a full decode", async () => {
    vi.mocked(validateStaticRaster).mockClear();
    const tailed = Buffer.concat([syntheticPng(), Buffer.from("trailing bytes after IEND")]);
    const cases = [
      { bytes: syntheticPng({ animated: true }), fileName: "motion.png", mimeType: "image/png" },
      { bytes: await syntheticAnimatedWebp(), fileName: "motion.webp", mimeType: "image/webp" },
      { bytes: await syntheticMpfJpeg(), fileName: "ultra-hdr.jpg", mimeType: "image/jpeg" },
      { bytes: tailed, fileName: "tailed.png", mimeType: "" },
      { bytes: await syntheticOversizedPng(), fileName: "huge.png", mimeType: "image/png" },
      { bytes: Buffer.concat([syntheticPng(), Buffer.alloc(IMAGE_MAX_BYTES)]), fileName: "heavy.png", mimeType: "image/png" }
    ];
    for (const { bytes, fileName, mimeType } of cases) {
      const { POST, createAttachment } = rasterUpload(32 * 1024 * 1024);
      const response = await POST(authenticatedUploadRequest(new File([bytes], fileName, { type: mimeType })));
      expect(response.status).toBe(200);
      expect(createAttachment.mock.calls[0]![0]).toMatchObject({ fileName, checksum: sha256(bytes), status: "processing" });
    }
    expect(validateStaticRaster).not.toHaveBeenCalled();
  });

  it.each([
    { label: "SVG", bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>") },
    { label: "HTML", bytes: Buffer.from("<!doctype html><main>Fixture</main>") },
    { label: "GIF", bytes: Buffer.from("GIF89a\x01\x00\x01\x00", "binary") },
    { label: "arbitrary bytes", bytes: Buffer.from([0, 1, 2, 3, 4, 5]) }
  ])("still refuses $label content under a raster name", async ({ bytes }) => {
    vi.mocked(validateStaticRaster).mockClear();
    for (const mimeType of ["image/jpeg", "image/png"]) {
      const { POST, createAttachment } = rasterUpload();
      const response = await POST(authenticatedUploadRequest(new File([bytes], "synthetic.jpeg", { type: mimeType })));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "unsupported_type" });
      expect(createAttachment).not.toHaveBeenCalled();
    }
    expect(validateStaticRaster).not.toHaveBeenCalled();
  });
});
