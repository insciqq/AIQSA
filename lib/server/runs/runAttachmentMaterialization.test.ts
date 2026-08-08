import { describe, expect, it, vi } from "vitest";
import type { ProviderModelCapabilities } from "../providers/types";
import { StoredObjectTooLargeError } from "../uploads/storage";
import type { RunAttachmentLimits } from "./attachmentLimits";
import {
  attachmentIdsFromContentBlocks,
  enforceAttachmentReferenceLimit,
  loadProviderAttachments,
  MAX_RUN_CONTENT_BLOCKS,
  validatePersistedAttachmentReferences
} from "./runAttachmentMaterialization";
import type { RunAttachmentRecord } from "./runRepositoryContract";

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
    extractedText: kind === "image" ? null : "bounded extracted text",
    fileName: `${id}.bin`,
    id,
    kind,
    metadata: {},
    mimeType: kind === "image" ? "image/png" : kind === "pdf" ? "application/pdf" : "text/plain",
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

  it("bounds content blocks and rejects duplicate references as malformed", () => {
    expect(() => attachmentIdsFromContentBlocks(
      Array.from({ length: MAX_RUN_CONTENT_BLOCKS + 1 }, () => ({ text: "x", type: "text" }))
    )).toThrow(expect.objectContaining({
      code: "content_block_limit_exceeded",
      status: 400
    }));
    expect(() => attachmentIdsFromContentBlocks([
      { attachmentId: "same", type: "file" },
      { attachmentId: "same", type: "file" }
    ])).toThrow(expect.objectContaining({
      code: "attachment_reference_invalid",
      status: 400
    }));
    expect(() => attachmentIdsFromContentBlocks([
      { attachmentId: "hidden", type: "text" }
    ])).toThrow(expect.objectContaining({
      code: "attachment_reference_invalid",
      status: 400
    }));
    expect(() => enforceAttachmentReferenceLimit(["one", "two"], limits({ maxCount: 1 })))
      .toThrow(expect.objectContaining({
        actual: { count: 2 },
        code: "attachment_count_limit_exceeded",
        limits: { maxCount: 1 },
        status: 413
      }));
    expect(() => enforceAttachmentReferenceLimit(["one", "two"], limits({ maxCount: 2 })))
      .not.toThrow();
    expect(validatePersistedAttachmentReferences(
      [{ attachmentId: "one", type: "file" }],
      ["one"],
      limits()
    )).toEqual(["one"]);
    expect(() => validatePersistedAttachmentReferences(
      [{ attachmentId: "one", type: "file" }],
      ["other"],
      limits()
    )).toThrow(expect.objectContaining({
      code: "attachment_reference_invalid",
      status: 400
    }));
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
});
