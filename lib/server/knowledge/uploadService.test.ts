import { describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../uploads/storage";
import {
  cancelKnowledgeUploadItem,
  createKnowledgeUploadBatch,
  type KnowledgeUploadServiceDeps
} from "./uploadService";

describe("Knowledge upload cleanup", () => {
  it("waits for every in-flight multipart admission before aborting a failed batch", async () => {
    let call = 0;
    const createMultipartUpload = vi.fn(async () => {
      call += 1;
      if (call === 2) throw new Error("multipart_create_failed");
      return { uploadId: `multipart-upload-${call}` };
    });
    const abortMultipartUpload = vi.fn(async () => undefined);
    const deps = {
      deletionOutbox: {
        complete: vi.fn(async () => undefined),
        stage: vi.fn(async () => ({ id: "deletion-job-1" }))
      },
      repository: {
        createBatch: vi.fn(),
        getByClientBatchId: vi.fn(async () => null)
      },
      storage: {
        deleteObject: vi.fn(),
        directMultipartUpload: {
          abortMultipartUpload,
          completeMultipartUpload: vi.fn(),
          createMultipartUpload,
          presignMultipartPart: vi.fn()
        }
      } as unknown as StorageAdapter
    } as unknown as KnowledgeUploadServiceDeps;

    await expect(createKnowledgeUploadBatch(deps, {
      batch: {
        clientBatchId: "batch-browser-1",
        files: Array.from({ length: 4 }, (_, index) => ({
          byteSize: 5,
          clientFileId: `file-${index + 1}`,
          fileName: `file-${index + 1}.md`,
          mimeType: "text/markdown"
        }))
      },
      config: { maxBatchFiles: 100, multipartPartBytes: 8 * 1_024 * 1_024, sessionSeconds: 900 },
      extraction: {
        maxChunksPerDocument: 10_000,
        maxFileBytes: 50_000_000,
        maxNormalizedChars: 5_000_000,
        maxNormalizedObjectBytes: 24_194_304,
        maxPages: 2_000
      },
      knowledgeBaseId: "base-1",
      now: new Date("2026-08-18T10:00:00.000Z"),
      userId: "owner-1"
    })).rejects.toMatchObject({ code: "knowledge_storage_unavailable" });

    expect(createMultipartUpload).toHaveBeenCalledTimes(4);
    expect(abortMultipartUpload).toHaveBeenCalledTimes(3);
    expect(deps.deletionOutbox.stage).toHaveBeenCalledTimes(3);
    expect(deps.repository.createBatch).not.toHaveBeenCalled();
  });

  it("retains multipart abort authority when direct cleanup fails", async () => {
    const complete = vi.fn(async () => undefined);
    const stage = vi.fn(async () => ({ id: "deletion-job-1" }));
    const abortMultipartUpload = vi.fn(async () => {
      throw new Error("storage_temporarily_unavailable");
    });
    const deleteObject = vi.fn(async () => undefined);
    const deps = {
      deletionOutbox: { complete, stage },
      repository: {
        cancel: vi.fn(async () => ({
          cleanup: {
            multipartUploadId: "multipart-upload-1",
            storageKey: "knowledge/uploads/owner-1/batch-1/item-1",
            transport: "MULTIPART" as const
          },
          kind: "ok" as const
        }))
      },
      storage: {
        deleteObject,
        directMultipartUpload: {
          abortMultipartUpload,
          completeMultipartUpload: vi.fn(),
          createMultipartUpload: vi.fn(),
          presignMultipartPart: vi.fn()
        }
      } as unknown as StorageAdapter
    } as unknown as KnowledgeUploadServiceDeps;

    await expect(cancelKnowledgeUploadItem(deps, {
      attemptNumber: 1,
      batchId: "batch-1",
      itemId: "item-1",
      knowledgeBaseId: "base-1",
      now: new Date("2026-08-18T10:00:00.000Z"),
      userId: "owner-1"
    })).resolves.toBeUndefined();

    expect(stage).toHaveBeenCalledWith(
      "knowledge/uploads/owner-1/batch-1/item-1",
      "multipart-upload-1"
    );
    expect(abortMultipartUpload).toHaveBeenCalledOnce();
    expect(deleteObject).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
