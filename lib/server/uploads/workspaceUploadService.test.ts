// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { IMAGE_MAX_BYTES } from "@/lib/contracts/imageGeneration";
import { WORKSPACE_UPLOAD_PART_BYTES } from "@/lib/contracts/workspaceUploads";
import { createUploadPermitGate } from "../http/uploadPermitGate";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import {
  syntheticAnimatedWebp,
  syntheticJpeg,
  syntheticMpfJpeg,
  syntheticOversizedPng,
  syntheticPng
} from "@/tests/support/rasterFixtures";
import type { WorkspaceUploadRecord, WorkspaceUploadRepository } from "./workspaceUploadRepository";
import { WorkspaceUploadService } from "./workspaceUploadService";
import { validateStaticRaster } from "./staticRaster";

vi.mock("./staticRaster", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./staticRaster")>();
  return { ...actual, validateStaticRaster: vi.fn(actual.validateStaticRaster) };
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const createInput = (fileName: string, mimeType: string, byteSize = 1024) =>
  ({ byteSize, fileName, mimeType, projectId: null, idempotencyKey: "idempotency-key-123" });

/** One verifying upload of `bytes`, declared with the stored (already canonical) name and MIME. */
function settlement(bytes: Buffer, fileName: string, mimeType: string) {
  const storage = createMemoryStorageAdapter();
  const outputKey = "uploads/stream/upload-1/originals/claim-1";
  const objects = Array.from({ length: Math.ceil(bytes.byteLength / WORKSPACE_UPLOAD_PART_BYTES) }, (_, index) => {
    const body = bytes.subarray(index * WORKSPACE_UPLOAD_PART_BYTES, (index + 1) * WORKSPACE_UPLOAD_PART_BYTES);
    const storageKey = `uploads/stream/upload-1/parts/${index + 1}`;
    storage.objects.set(storageKey, { body, contentType: "application/octet-stream", storageKey });
    return { partNumber: index + 1, ready: true, byteSize: body.byteLength, storageKey, checksum: sha256(body) };
  });
  const row = {
    id: "upload-1", claimToken: "claim-1", byteSize: bytes.byteLength, fileName, mimeType, objects
  } as unknown as WorkspaceUploadRecord;
  let claimed = false;
  const repository = {
    claimSettlement: vi.fn(async () => {
      if (claimed) return null;
      claimed = true;
      return { row, output: { storageKey: outputKey } };
    }),
    heartbeat: vi.fn(async () => true),
    settle: vi.fn(async () => true),
    failSettlement: vi.fn(async () => undefined),
    claimCleanup: vi.fn(async () => null),
    finishCleanup: vi.fn()
  } as unknown as WorkspaceUploadRepository;
  const service = new WorkspaceUploadService({ repository, storage, available: async () => true, gate: createUploadPermitGate(2) });
  return { outputKey, repository, service, storage };
}

describe("Workspace multipart static-raster normalization", () => {
  it("stores the extension's canonical MIME at create and refuses an undecodable size early", async () => {
    const create = vi.fn(async (value: object) => ({
      ...value, id: "upload-1", objects: [], state: "uploading", expiresAt: new Date(0), errorCode: null, attachment: null
    }));
    const service = new WorkspaceUploadService({
      repository: { create } as unknown as WorkspaceUploadRepository,
      storage: createMemoryStorageAdapter(),
      available: async () => true
    });
    for (const mimeType of ["image/jpeg", "image/png", "", "application/octet-stream"]) {
      await service.create(createInput("synthetic.jpeg", mimeType), "owner");
    }
    expect(create.mock.calls.map(([value]) => (value as { fileName: string; mimeType: string })))
      .toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ fileName: "synthetic.jpeg", mimeType: "image/jpeg" })));
    await expect(service.create(createInput("large.jpeg", "image/png", IMAGE_MAX_BYTES + 1), "owner"))
      .rejects.toMatchObject({ code: "image_limit_exceeded", status: 413 });
    await expect(service.create(createInput("synthetic.jpeg", "image/gif"), "owner"))
      .rejects.toMatchObject({ code: "unsupported_type", status: 400 });
    expect(create).toHaveBeenCalledTimes(4);
  });

  it("decodes a mismatched raster, rewrites the same bytes with the decoded type and settles the normalized name", async () => {
    const png = syntheticPng();
    const { outputKey, repository, service, storage } = settlement(png, "synthetic.jpeg", "image/jpeg");

    await service.reconcileNow();

    expect(repository.failSettlement).not.toHaveBeenCalled();
    expect(repository.settle).toHaveBeenCalledWith(expect.objectContaining({
      checksum: sha256(png), fileName: "synthetic.png", mimeType: "image/png", storageKey: outputKey
    }));
    const object = storage.objects.get(outputKey)!;
    expect(object.contentType).toBe("image/png");
    expect(Buffer.compare(object.body, png)).toBe(0);
  });

  it("normalizes JPEG content under a PNG name to .jpg", async () => {
    const jpeg = await syntheticJpeg();
    const { outputKey, repository, service, storage } = settlement(jpeg, "photo.png", "image/png");
    await service.reconcileNow();
    expect(repository.settle).toHaveBeenCalledWith(expect.objectContaining({ fileName: "photo.jpg", mimeType: "image/jpeg" }));
    expect(storage.objects.get(outputKey)?.contentType).toBe("image/jpeg");
  });

  it.each([
    { label: "truncated PNG", bytes: async () => syntheticPng().subarray(0, 40), name: "broken.jpeg", mime: "image/jpeg", code: "image_invalid" },
    { label: "pixel-limit PNG", bytes: syntheticOversizedPng, name: "huge.jpeg", mime: "image/jpeg", code: "image_limit_exceeded" },
    { label: "APNG", bytes: async () => syntheticPng({ animated: true }), name: "motion.jpeg", mime: "image/jpeg", code: "unsupported_type" },
    { label: "animated WebP", bytes: syntheticAnimatedWebp, name: "motion.png", mime: "image/png", code: "unsupported_type" },
    { label: "MPF JPEG", bytes: syntheticMpfJpeg, name: "photo.png", mime: "image/png", code: "unsupported_type" },
    { label: "GIF", bytes: async () => Buffer.from("GIF89a\x01\x00\x01\x00", "binary"), name: "anim.jpeg", mime: "image/jpeg", code: "unsupported_type" }
  ])("fails a $label settlement with $code and no attachment", async ({ bytes, name, mime, code }) => {
    const { repository, service } = settlement(await bytes(), name, mime);
    await service.reconcileNow();
    expect(repository.settle).not.toHaveBeenCalled();
    expect(repository.failSettlement).toHaveBeenCalledWith("upload-1", "claim-1", code, false);
  });

  it("fails an over-limit mismatched raster without reading it into memory", async () => {
    const large = Buffer.concat([syntheticPng(), Buffer.alloc(IMAGE_MAX_BYTES)]);
    const { outputKey, repository, service, storage } = settlement(large, "large.jpeg", "image/jpeg");
    const getObject = vi.spyOn(storage, "getObject");
    vi.mocked(validateStaticRaster).mockClear();
    await service.reconcileNow();
    expect(repository.failSettlement).toHaveBeenCalledWith("upload-1", "claim-1", "image_limit_exceeded", false);
    // Parts stream through bounded reads; the assembled object is never buffered.
    expect(getObject.mock.calls.map(([key]) => key)).not.toContain(outputKey);
    expect(validateStaticRaster).not.toHaveBeenCalled();
  });

  it("settles matching rasters without a full decode or rewrite", async () => {
    vi.mocked(validateStaticRaster).mockClear();
    for (const [bytes, name, mime] of [
      [syntheticPng({ animated: true }), "motion.png", "image/png"],
      [await syntheticMpfJpeg(), "ultra-hdr.jpg", "image/jpeg"],
      [Buffer.concat([syntheticPng(), Buffer.from("trailing")]), "tailed.png", "image/png"]
    ] as const) {
      const { outputKey, repository, service, storage } = settlement(bytes, name, mime);
      const putObject = vi.spyOn(storage, "putObject");
      await service.reconcileNow();
      expect(repository.settle).toHaveBeenCalledWith(expect.objectContaining({ fileName: name, mimeType: mime, storageKey: outputKey }));
      expect(putObject).not.toHaveBeenCalled();
      expect(storage.objects.get(outputKey)?.contentType).toBe(mime);
    }
    expect(validateStaticRaster).not.toHaveBeenCalled();
  });
});
