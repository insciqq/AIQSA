import { CHAT_PDF_WORKSPACE_ORIGINAL_NOTICE, encodeChatPdfArtifact } from "../uploads/chatPdfCore";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { ProviderModelCapabilities } from "../providers/types";
import { StoredObjectTooLargeError } from "../uploads/storage";
import type { RunAttachmentLimits } from "./attachmentLimits";
import { loadProviderAttachments } from "./runAttachmentMaterialization";
import type { RunAttachmentRecord } from "./runRepositoryContract";
import { bitmap24, decodedPixels, syntheticTiff, type Rgb } from "@/tests/support/rasterFixtures";

const baseCapabilities: ProviderModelCapabilities = {
  nativePdfInput: false,
  nativeBackground: false,
  nativeImageGeneration: false,
  nativeSearch: false,
  pdf: true,
  reasoning: false,
  vision: true
};

function limits(overrides: Partial<RunAttachmentLimits> = {}): RunAttachmentLimits {
  return {
    maxCount: 20,
    maxEncodedBytes: 1_000,
    maxMaterializedBytes: 1_000,
    readConcurrency: 2,
    ...overrides
  };
}

function attachment(
  id: string,
  kind: "document" | "image" | "pdf",
  byteSize: number
): RunAttachmentRecord {
  return {
    byteSize,
    checksum: null,
    extractedText: kind === "image" ? null : "bounded extracted text",
    fileName: `${id}.bin`,
    id,
    kind,
    metadata: {},
    mimeType: kind === "image" ? "image/png" : kind === "pdf" ? "application/pdf" : "text/plain",
    processingErrorCode: null,
    status: "ready",
    storageKey: `private/${id}`
  };
}

function repository(records: readonly RunAttachmentRecord[]) {
  return {
    loadAttachments: vi.fn(async () => [...records])
  };
}

describe("run attachment materialization", () => {
  it("restores the original-only notice only for its accepted Workspace run", async () => {
    const source = { ...attachment("pdf", "pdf", 100), workspaceOriginalOnly: true,
      status: "failed", extractedText: "An older extraction must not replace the accepted outcome." };
    const store = repository([source]);
    const result = await loadProviderAttachments({ repository: store }, "user", ["pdf"], {
      capabilities: baseCapabilities, limits: limits(), runId: "accepted-run", workspaceEnabled: true
    });
    expect(result[0]?.extractedText).toBe(CHAT_PDF_WORKSPACE_ORIGINAL_NOTICE);
    expect(result[0]).not.toHaveProperty("workspaceOriginalOnly");
    expect(JSON.stringify(result)).not.toContain("private/pdf");
    await expect(loadProviderAttachments({ repository: store }, "user", ["pdf"], {
      capabilities: baseCapabilities, limits: limits(), runId: "accepted-run"
    })).rejects.toMatchObject({ code: "attachment_object_read_failed" });
  });

  it.each([true, false])("restores prepared text when answer native-PDF support is %s", async (nativePdfInput) => {
    const encoded = encodeChatPdfArtifact({ text: "Accepted document text.", pageCount: 2 });
    const source = { ...attachment("pdf", "pdf", 100), checksum: "a".repeat(64), extractedText: null,
      preparedPdf: { byteSize: encoded.body.length, checksum: encoded.checksum, pageCount: 2,
        sourceChecksum: "a".repeat(64), storageKey: "chat-pdf/accepted" } };
    const store = repository([source]);
    const getObject = vi.fn(async (storageKey: string) => ({ storageKey, contentType: "application/json", body: encoded.body }));
    const result = await loadProviderAttachments({ repository: store, storage: { getObject } }, "user", ["pdf"], {
      capabilities: { ...baseCapabilities, nativePdfInput }, limits: limits(), runId: "accepted-run"
    });
    expect(store.loadAttachments).toHaveBeenCalledWith("user", ["pdf"], "accepted-run");
    expect(result[0]?.pdfDelivery).toBe("prepared_text");
    expect(result[0]?.base64Data).toBeUndefined();
    expect(getObject).toHaveBeenCalledOnce();
    expect(result[0]?.extractedText).toBe("Accepted document text.");
    expect(result[0]).not.toHaveProperty("preparedPdf");
    expect(JSON.stringify(result)).not.toContain("chat-pdf/accepted");
    await expect(loadProviderAttachments({ repository: store, storage: { getObject } }, "user", ["pdf"], {
      capabilities: { ...baseCapabilities, nativePdfInput }, limits: limits()
    })).rejects.toMatchObject({ code: "attachment_object_read_failed" });
  });

  it("does not resolve PDF policy for an image-only request", async () => {
    const resolvePdfRoute = vi.fn(async () => { throw new Error("pdf_processing_configuration_incomplete"); });
    const image = attachment("image", "image", 3);
    const getObject = vi.fn(async () => ({ body: Buffer.from("abc"), contentType: "image/png", storageKey: "private/image" }));
    const result = await loadProviderAttachments({ repository: repository([image]), storage: { getObject } }, "user", [image.id], {
      capabilities: baseCapabilities, limits: limits(), resolvePdfRoute
    });
    expect(result[0]?.dataUrl).toBe("data:image/png;base64,YWJj");
    expect(resolvePdfRoute).not.toHaveBeenCalled();
  });

  it.each(["processing", "failed"])("rejects a %s attachment before object reads", async (status) => {
    const unsettled = { ...attachment("pending", "document", 10), status };
    const getObject = vi.fn();

    await expect(loadProviderAttachments(
      { repository: repository([unsettled]), storage: { getObject } },
      "user-1",
      [unsettled.id],
      { capabilities: baseCapabilities, limits: limits() }
    )).rejects.toMatchObject({
      code: "attachment_not_ready",
      status: 409
    });
    expect(getObject).not.toHaveBeenCalled();
  });

  it.each([
    { processingErrorCode: null, status: "processing" },
    { processingErrorCode: null, status: "ready" },
    { processingErrorCode: "parser_unavailable", status: "failed" },
    { processingErrorCode: "pdf_extraction_failed", status: "failed" }
  ])("sends direct PDF bytes while local processing is $status", async ({
    processingErrorCode,
    status
  }) => {
    const bytes = Buffer.from("%PDF-direct");
    const record = {
      ...attachment("direct", "pdf", bytes.length),
      checksum: createHash("sha256").update(bytes).digest("hex"),
      metadata: { pdfPageCount: 2 },
      processingErrorCode,
      status
    };
    const getObject = vi.fn(async (storageKey: string, options?: { maxBytes?: number }) => {
      expect(options?.maxBytes).toBe(bytes.length);
      return {
        body: bytes,
        contentType: "application/pdf",
        storageKey
      };
    });

    const result = await loadProviderAttachments(
      { repository: repository([record]), storage: { getObject } },
      "user-1",
      [record.id],
      {
        capabilities: { ...baseCapabilities, nativePdfInput: true },
        limits: limits()
      }
    );

    expect(result).toEqual([expect.objectContaining({
      base64Data: bytes.toString("base64"),
      extractedText: null,
      id: record.id,
      metadata: { pdfPageCount: 2 }
    })]);
    expect(result[0]).not.toHaveProperty("checksum");
    expect(result[0]).not.toHaveProperty("processingErrorCode");
    expect(result[0]).not.toHaveProperty("storageKey");
  });

  it.each(["processing", "failed"])(
    "keeps extraction-mode PDF blocked while local processing is %s",
    async (status) => {
      const record = { ...attachment("fallback", "pdf", 10), status };
      await expect(loadProviderAttachments(
        { repository: repository([record]) },
        "user-1",
        [record.id],
        { capabilities: baseCapabilities, limits: limits() }
      )).rejects.toMatchObject({ code: "attachment_not_ready", status: 409 });
    }
  );

  it("leaves ready extraction-mode PDF text semantics to run validation without reading storage", async () => {
    const record = { ...attachment("fallback", "pdf", 10), extractedText: "   " };
    const result = await loadProviderAttachments(
      { repository: repository([record]) },
      "user-1",
      [record.id],
      { capabilities: baseCapabilities, limits: limits() }
    );

    expect(result).toEqual([expect.objectContaining({ extractedText: "   " })]);
  });

  it.each([
    ["attachment_checksum_mismatch", "attachment_checksum_mismatch"],
    ["attachment_object_size_mismatch", "attachment_object_size_mismatch"],
    ["attachment_object_read_failed", "attachment_object_read_failed"],
    ["attachment_unavailable", "attachment_object_read_failed"]
  ])("blocks direct PDF storage failure %s", async (processingErrorCode, expectedCode) => {
    const record = {
      ...attachment("broken", "pdf", 10),
      checksum: "a".repeat(64),
      processingErrorCode,
      status: "failed"
    };
    const getObject = vi.fn();
    await expect(loadProviderAttachments(
      { repository: repository([record]), storage: { getObject } },
      "user-1",
      [record.id],
      {
        capabilities: { ...baseCapabilities, nativePdfInput: true },
        limits: limits()
      }
    )).rejects.toMatchObject({ code: expectedCode });
    expect(getObject).not.toHaveBeenCalled();
  });

  it("fails closed on a missing or mismatched direct-PDF checksum", async () => {
    const bytes = Buffer.from("%PDF-direct");
    const getObject = vi.fn(async (storageKey: string) => ({
      body: bytes,
      contentType: "application/pdf",
      storageKey
    }));
    const missing = attachment("missing-checksum", "pdf", bytes.length);
    const mismatched = {
      ...attachment("wrong-checksum", "pdf", bytes.length),
      checksum: "a".repeat(64)
    };
    const options = {
      capabilities: { ...baseCapabilities, nativePdfInput: true },
      limits: limits()
    };

    await expect(loadProviderAttachments(
      { repository: repository([missing]), storage: { getObject } },
      "user-1",
      [missing.id],
      options
    )).rejects.toMatchObject({ code: "attachment_checksum_mismatch" });
    expect(getObject).not.toHaveBeenCalled();

    await expect(loadProviderAttachments(
      { repository: repository([mismatched]), storage: { getObject } },
      "user-1",
      [mismatched.id],
      options
    )).rejects.toMatchObject({ code: "attachment_checksum_mismatch" });
    expect(getObject).toHaveBeenCalledOnce();
  });

  it("rejects direct PDF object size drift and missing objects", async () => {
    const bytes = Buffer.from("%PDF-direct");
    const record = {
      ...attachment("direct-object", "pdf", bytes.length),
      checksum: createHash("sha256").update(bytes).digest("hex")
    };
    const options = {
      capabilities: { ...baseCapabilities, nativePdfInput: true },
      limits: limits()
    };

    await expect(loadProviderAttachments(
      {
        repository: repository([record]),
        storage: {
          async getObject(storageKey) {
            return { body: bytes.subarray(1), contentType: "application/pdf", storageKey };
          }
        }
      },
      "user-1",
      [record.id],
      options
    )).rejects.toMatchObject({
      code: "attachment_object_size_mismatch",
      status: 409
    });

    await expect(loadProviderAttachments(
      {
        repository: repository([record]),
        storage: {
          async getObject() {
            throw new Error("NoSuchKey: private/direct-object");
          }
        }
      },
      "user-1",
      [record.id],
      options
    )).rejects.toMatchObject({
      code: "attachment_object_read_failed",
      status: 503
    });
  });

  it("lets a processing direct PDF through readiness checks but blocks a processing document", async () => {
    const bytes = Buffer.from("%PDF-direct");
    const pdf = {
      ...attachment("direct", "pdf", bytes.length),
      checksum: createHash("sha256").update(bytes).digest("hex"),
      status: "processing"
    };
    const document = {
      ...attachment("document", "document", 10),
      status: "processing"
    };
    const getObject = vi.fn();

    await expect(loadProviderAttachments(
      { repository: repository([pdf, document]), storage: { getObject } },
      "user-1",
      [pdf.id, document.id],
      {
        capabilities: { ...baseCapabilities, nativePdfInput: true },
        limits: limits()
      }
    )).rejects.toMatchObject({ code: "attachment_not_ready", status: 409 });
    expect(getObject).not.toHaveBeenCalled();
  });

  it("rejects missing references without returning a partial attachment list", async () => {
    const present = attachment("present", "document", 10);
    const getObject = vi.fn();
    await expect(loadProviderAttachments(
      { repository: repository([present]), storage: { getObject } },
      "user-1",
      [present.id, "missing"],
      { capabilities: baseCapabilities, limits: limits() }
    )).rejects.toMatchObject({
      actual: { requestedCount: 2, resolvedCount: 1 },
      code: "attachment_reference_invalid"
    });
    expect(getObject).not.toHaveBeenCalled();
  });

  it("rejects metadata source and encoded estimates before any object read", async () => {
    const sourceRecords = [attachment("a", "image", 6), attachment("b", "image", 5)];
    const sourceRepository = repository(sourceRecords);
    const getObject = vi.fn();

    await expect(loadProviderAttachments(
      { repository: sourceRepository, storage: { getObject } },
      "user-1",
      ["a", "b"],
      { capabilities: baseCapabilities, limits: limits({ maxMaterializedBytes: 10 }) }
    )).rejects.toMatchObject({
      actual: { materializedBytes: 11 },
      code: "attachment_materialization_limit_exceeded",
      limits: { maxMaterializedBytes: 10 },
      status: 413
    });
    expect(getObject).not.toHaveBeenCalled();

    const encodedRecord = attachment("image", "image", 3);
    await expect(loadProviderAttachments(
      { repository: repository([encodedRecord]), storage: { getObject } },
      "user-1",
      ["image"],
      { capabilities: baseCapabilities, limits: limits({ maxEncodedBytes: 25 }) }
    )).rejects.toMatchObject({
      code: "attachment_encoded_size_limit_exceeded",
      limits: { maxEncodedBytes: 25 },
      status: 413
    });
    expect(getObject).not.toHaveBeenCalled();
  });

  it("does not charge or read documents and extraction-mode PDFs", async () => {
    const records = [
      attachment("document", "document", 500),
      attachment("pdf", "pdf", 500)
    ];
    const getObject = vi.fn();

    const result = await loadProviderAttachments(
      { repository: repository(records), storage: { getObject } },
      "user-1",
      ["document", "pdf"],
      {
        capabilities: { ...baseCapabilities, nativePdfInput: false },
        limits: limits({ maxEncodedBytes: 1, maxMaterializedBytes: 1 })
      }
    );

    expect(result.map(({ id }) => id)).toEqual(["document", "pdf"]);
    expect(result.every((entry) => !entry.base64Data && !entry.dataUrl)).toBe(true);
    expect(getObject).not.toHaveBeenCalled();
  });

  it("keeps exact-limit reads bounded, concurrent, and in attachment-reference order", async () => {
    const records = [
      attachment("third", "image", 3),
      attachment("first", "image", 3),
      attachment("second", "image", 3)
    ];
    let active = 0;
    let maximumActive = 0;
    const getObject = vi.fn(async (storageKey: string, options?: { maxBytes?: number }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      expect(options?.maxBytes).toBe(3);
      await Promise.resolve();
      active -= 1;
      return {
        body: Buffer.from("abc"),
        contentType: "image/png",
        storageKey
      };
    });

    const result = await loadProviderAttachments(
      { repository: repository(records), storage: { getObject } },
      "user-1",
      ["first", "second", "third"],
      {
        capabilities: baseCapabilities,
        limits: limits({ maxMaterializedBytes: 9, readConcurrency: 2 })
      }
    );

    expect(maximumActive).toBe(2);
    expect(getObject).toHaveBeenCalledTimes(3);
    expect(result.map(({ id }) => id)).toEqual(["first", "second", "third"]);
    expect(result.every(({ dataUrl }) => dataUrl === "data:image/png;base64,YWJj")).toBe(true);
  });

  it("sends an image over the patch limit as a smaller copy and leaves the stored object alone", async () => {
    const source = await sharp({ create: { background: "#808080", channels: 3, height: 6120, width: 8160 } }).jpeg().toBuffer();
    const record = { ...attachment("photo", "image", source.length), metadata: { image: { format: "jpeg", height: 6120, width: 8160 } },
      mimeType: "image/jpeg" };
    const getObject = vi.fn(async (storageKey: string) => ({ body: source, contentType: "image/jpeg", storageKey }));
    const [sent] = await loadProviderAttachments({ repository: repository([record]), storage: { getObject } }, "user-1", ["photo"],
      { capabilities: baseCapabilities, limits: limits({ maxEncodedBytes: 8_000_000, maxMaterializedBytes: 8_000_000 }) });
    const copy = await sharp(Buffer.from(sent!.dataUrl!.split(",")[1]!, "base64")).metadata();
    expect(Math.ceil(copy.width! / 32) * Math.ceil(copy.height! / 32)).toBeLessThanOrEqual(30_000);
    expect(sent).toMatchObject({ fileName: "photo.bin", metadata: { image: { format: "jpeg", height: copy.height, width: copy.width } },
      mimeType: "image/jpeg" });
    expect(sent!.byteSize).toBe(Buffer.from(sent!.dataUrl!.split(",")[1]!, "base64").length);
    expect(record.byteSize).toBe(source.length);
  });

  it("refuses visibly an image too large to resize, before decoding it", async () => {
    const source = await sharp({ create: { background: "#808080", channels: 3, height: 10_100, width: 11_000 } }).jpeg({ quality: 10 }).toBuffer();
    const record = { ...attachment("huge", "image", source.length), mimeType: "image/jpeg" };
    const getObject = vi.fn(async (storageKey: string) => ({ body: source, contentType: "image/jpeg", storageKey }));
    await expect(loadProviderAttachments({ repository: repository([record]), storage: { getObject } }, "user-1", ["huge"],
      { capabilities: baseCapabilities, limits: limits({ maxEncodedBytes: 8_000_000, maxMaterializedBytes: 8_000_000 }) }))
      .rejects.toMatchObject({ code: "attachment_materialization_limit_exceeded", status: 413 });
  });

  it("sends an image within the limit byte for byte", async () => {
    const source = await sharp({ create: { background: "#808080", channels: 3, height: 64, width: 64 } }).png().toBuffer();
    const record = attachment("small", "image", source.length);
    const getObject = vi.fn(async (storageKey: string) => ({ body: source, contentType: "image/png", storageKey }));
    const [sent] = await loadProviderAttachments({ repository: repository([record]), storage: { getObject } }, "user-1", ["small"],
      { capabilities: baseCapabilities, limits: limits({ maxEncodedBytes: 1_000_000, maxMaterializedBytes: 1_000_000 }) });
    expect(sent!.dataUrl).toBe(`data:image/png;base64,${source.toString("base64")}`);
    expect(sent!.metadata).toEqual({});
  });

  it("accepts an encoded provider payload exactly at its estimated boundary", async () => {
    const record = attachment("exact", "image", 3);
    const getObject = vi.fn(async (storageKey: string) => ({
      body: Buffer.from("abc"),
      contentType: "image/png",
      storageKey
    }));

    await expect(loadProviderAttachments(
      { repository: repository([record]), storage: { getObject } },
      "user-1",
      ["exact"],
      {
        capabilities: baseCapabilities,
        limits: limits({ maxEncodedBytes: 26, maxMaterializedBytes: 3 })
      }
    )).resolves.toEqual([
      expect.objectContaining({ dataUrl: "data:image/png;base64,YWJj", id: "exact" })
    ]);
    expect(getObject).toHaveBeenCalledOnce();
  });

  it("fails closed when actual object bytes disagree with settled metadata", async () => {
    const record = attachment("stale", "image", 3);
    const oversizedRead = vi.fn(async () => {
      throw new StoredObjectTooLargeError({ maxBytes: 3, observedBytes: 4 });
    });

    await expect(loadProviderAttachments(
      { repository: repository([record]), storage: { getObject: oversizedRead } },
      "user-1",
      ["stale"],
      { capabilities: baseCapabilities, limits: limits() }
    )).rejects.toMatchObject({
      actual: { observedBytes: 4, recordedBytes: 3 },
      code: "attachment_object_size_mismatch",
      status: 409
    });

    await expect(loadProviderAttachments(
      {
        repository: repository([record]),
        storage: {
          async getObject(storageKey) {
            return { body: Buffer.from("ab"), contentType: "image/png", storageKey };
          }
        }
      },
      "user-1",
      ["stale"],
      { capabilities: baseCapabilities, limits: limits() }
    )).rejects.toMatchObject({
      actual: { observedBytes: 2, recordedBytes: 3 },
      code: "attachment_object_size_mismatch",
      status: 409
    });
  });

  it("sanitizes arbitrary storage failures before they cross the run boundary", async () => {
    const record = attachment("private-id", "image", 3);
    const privateFailure = `ENOENT /private/storage/${record.storageKey}`;

    const error = await loadProviderAttachments(
      {
        repository: repository([record]),
        storage: {
          async getObject() {
            throw new Error(privateFailure);
          }
        }
      },
      "user-1",
      [record.id],
      { capabilities: baseCapabilities, limits: limits() }
    ).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      code: "attachment_object_read_failed",
      message: "An attachment object could not be read.",
      status: 503
    });
    expect(JSON.stringify(error)).not.toContain(record.storageKey);
    expect((error as Error).message).not.toContain(privateFailure);
  });

  it("propagates caller cancellation, aborts in-flight work, and schedules no later read", async () => {
    const controller = new AbortController();
    const reason = new Error("request_cancelled");
    const records = [attachment("one", "image", 3), attachment("two", "image", 3)];
    const getObject = vi.fn((_storageKey: string, options?: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      })
    );
    const materialization = loadProviderAttachments(
      { repository: repository(records), storage: { getObject } },
      "user-1",
      ["one", "two"],
      {
        capabilities: baseCapabilities,
        limits: limits({ readConcurrency: 1 }),
        signal: controller.signal
      }
    );

    await vi.waitFor(() => expect(getObject).toHaveBeenCalledOnce());
    controller.abort(reason);
    await expect(materialization).rejects.toBe(reason);
    expect(getObject).toHaveBeenCalledOnce();
  });

  it("cancels sibling reads after the first materialization failure", async () => {
    const records = [
      attachment("one", "image", 3),
      attachment("two", "image", 3),
      attachment("three", "image", 3)
    ];
    let started = 0;
    let releaseFirst: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const siblingCancelled = vi.fn();
    const getObject = vi.fn(async (
      storageKey: string,
      options?: { signal?: AbortSignal }
    ) => {
      started += 1;
      if (started === 2) {
        releaseFirst?.();
      }

      if (storageKey === "private/one") {
        await bothStarted;
        throw new StoredObjectTooLargeError({ maxBytes: 3, observedBytes: 4 });
      }

      return new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          siblingCancelled();
          reject(options.signal?.reason);
        }, { once: true });
      });
    });

    await expect(loadProviderAttachments(
      { repository: repository(records), storage: { getObject } },
      "user-1",
      ["one", "two", "three"],
      {
        capabilities: baseCapabilities,
        limits: limits({ readConcurrency: 2 })
      }
    )).rejects.toMatchObject({
      code: "attachment_object_size_mismatch",
      status: 409
    });
    expect(getObject).toHaveBeenCalledTimes(2);
    expect(getObject).not.toHaveBeenCalledWith(
      "private/three",
      expect.anything()
    );
    expect(siblingCancelled).toHaveBeenCalledOnce();
  });

  describe("BMP and TIFF images", () => {
    const pattern = (x: number, y: number): Rgb => [x * 100, y * 100, 50];
    const imageRecord = (id: string, mimeType: string, body: Buffer): RunAttachmentRecord => ({
      ...attachment(id, "image", body.length), fileName: `${id}.${mimeType.split("/")[1]}`, mimeType
    });
    function storageFor(bodies: Record<string, Buffer>) {
      return { getObject: vi.fn(async (storageKey: string) => ({
        body: bodies[storageKey.replace("private/", "")]!, contentType: "application/octet-stream", storageKey })) };
    }
    const encoded = (mimeType: string, bytes: number) => `data:${mimeType};base64,`.length + 4 * Math.ceil(bytes / 3);

    it("sends a BMP and a TIFF as PNG and leaves other images as stored", async () => {
      const bmp = bitmap24(2, 2, pattern);
      const tiff = await syntheticTiff(2, 2, pattern);
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      const records = [imageRecord("bmp", "image/bmp", bmp), imageRecord("tiff", "image/tiff", tiff),
        imageRecord("jpeg", "image/jpeg", jpeg)];
      const storage = storageFor({ bmp, jpeg, tiff });

      const result = await loadProviderAttachments({ repository: repository(records), storage }, "user-1", ["bmp", "tiff", "jpeg"],
        { capabilities: baseCapabilities, limits: limits({ maxEncodedBytes: 100_000, maxMaterializedBytes: 100_000 }) });

      for (const converted of result.slice(0, 2)) {
        expect(converted).toMatchObject({ kind: "image", mimeType: "image/png" });
        expect(converted.dataUrl).toMatch(/^data:image\/png;base64,/u);
        const png = Buffer.from(converted.dataUrl!.split(",")[1]!, "base64");
        expect(converted.byteSize).toBe(png.length);
        const decoded = await decodedPixels(png);
        expect(decoded).toMatchObject({ format: "png", width: 2, height: 2 });
        expect(decoded.pixels.map((pixel) => pixel.slice(0, 3))).toEqual([pattern(0, 0), pattern(1, 0), pattern(0, 1), pattern(1, 1)]);
      }
      expect(result.map(({ fileName }) => fileName)).toEqual(["bmp.bmp", "tiff.tiff", "jpeg.jpeg"]);
      expect(result[2]).toMatchObject({ byteSize: jpeg.length, dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
        mimeType: "image/jpeg" });
      // Only reads: the stored objects are never rewritten.
      expect(Object.keys(storage)).toEqual(["getObject"]);
    });

    it("refuses a converted PNG that outgrows the encoded budget its source fit", async () => {
      // A 1x1 bitmap is smaller than its PNG, so the source estimate passes admission.
      const bmp = bitmap24(1, 1, pattern);
      const record = imageRecord("small", "image/bmp", bmp);
      const maxEncodedBytes = encoded("image/bmp", bmp.length);
      await expect(loadProviderAttachments({ repository: repository([record]), storage: storageFor({ small: bmp }) }, "user-1", ["small"],
        { capabilities: baseCapabilities, limits: limits({ maxEncodedBytes, maxMaterializedBytes: 1_000 }) }))
        .rejects.toMatchObject({ code: "attachment_encoded_size_limit_exceeded", limits: { maxEncodedBytes }, status: 413 });

      // Each image fits alone; the request total after conversion does not.
      const png = Buffer.alloc(60, 1);
      const records = [imageRecord("plain", "image/png", png), record];
      const alone = (await loadProviderAttachments({ repository: repository([record]), storage: storageFor({ small: bmp }) }, "user-1",
        ["small"], { capabilities: baseCapabilities, limits: limits({ maxEncodedBytes: 1_000 }) }))[0]!.dataUrl!.length;
      const total = encoded("image/png", png.length) + encoded("image/bmp", bmp.length);
      expect(alone).toBeLessThanOrEqual(total);
      expect(alone + encoded("image/png", png.length)).toBeGreaterThan(total);
      await expect(loadProviderAttachments({ repository: repository(records), storage: storageFor({ plain: png, small: bmp }) }, "user-1",
        ["plain", "small"], { capabilities: baseCapabilities, limits: limits({ maxEncodedBytes: total }) }))
        .rejects.toMatchObject({ code: "attachment_encoded_size_limit_exceeded", status: 413 });
    });

    it("refuses an image over the pixel bounds and one that cannot be decoded", async () => {
      const bomb = bitmap24(1, 1, pattern);
      bomb.writeInt32LE(20_000, 18);
      bomb.writeInt32LE(20_000, 22);
      await expect(loadProviderAttachments({ repository: repository([imageRecord("bomb", "image/bmp", bomb)]),
        storage: storageFor({ bomb }) }, "user-1", ["bomb"], { capabilities: baseCapabilities, limits: limits() }))
        .rejects.toMatchObject({ code: "attachment_materialization_limit_exceeded", actual: { width: 20_000, height: 20_000 }, status: 413 });

      const broken = Buffer.from("BMgarbage");
      await expect(loadProviderAttachments({ repository: repository([imageRecord("broken", "image/x-bmp", broken)]),
        storage: storageFor({ broken }) }, "user-1", ["broken"], { capabilities: baseCapabilities, limits: limits() }))
        .rejects.toMatchObject({ code: "attachment_image_invalid", status: 400 });
    });

    it("reads nothing for a model without vision", async () => {
      const bmp = bitmap24(1, 1, pattern);
      const storage = storageFor({ bmp });
      const result = await loadProviderAttachments({ repository: repository([imageRecord("bmp", "image/bmp", bmp)]), storage },
        "user-1", ["bmp"], { capabilities: { ...baseCapabilities, vision: false }, limits: limits() });
      expect(storage.getObject).not.toHaveBeenCalled();
      expect(result[0]).toMatchObject({ mimeType: "image/bmp" });
      expect(result[0]).not.toHaveProperty("dataUrl");
    });
  });
});
