import { describe, expect, it } from "vitest";
import {
  decodeKnowledgeUploadBatchCreate,
  decodeKnowledgeUploadBatchListResponse,
  decodeKnowledgeUploadBatchResponse,
  decodeKnowledgeUploadAttempt,
  decodeKnowledgeUploadPartCheckpoint,
  KNOWLEDGE_UPLOAD_ATTEMPT_MAX
} from "./knowledgeUploads";

function item(overrides: Record<string, unknown> = {}) {
  return {
    attemptNumber: 1,
    byteSize: 12,
    clientFileId: "file-1",
    failureCode: null,
    fileName: "guide.md",
    id: "item-1",
    sourceId: null,
    state: "queued",
    transport: { kind: "proxy", uploadUrl: "/api/me/knowledge-bases/base-1/upload-batches/batch-1/items/item-1/content" },
    updatedAt: "2026-08-18T10:00:00.000Z",
    uploadedBytes: 0,
    ...overrides
  };
}

function batch(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: "2026-08-18T10:00:00.000Z",
    id: "batch-1",
    items: [item()],
    updatedAt: "2026-08-18T10:00:00.000Z",
    ...overrides
  };
}

describe("Knowledge upload contracts", () => {
  it("decodes a bounded idempotent batch request without accepting authority fields", () => {
    expect(decodeKnowledgeUploadBatchCreate({
      clientBatchId: "browser-batch-1",
      files: [{
        byteSize: 12,
        checksumHint: "a".repeat(64),
        clientFileId: "file-1",
        fileName: "guide.md",
        mimeType: "text/markdown"
      }]
    }, 100)).toEqual({
      ok: true,
      value: {
        clientBatchId: "browser-batch-1",
        files: [{
          byteSize: 12,
          checksumHint: "a".repeat(64),
          clientFileId: "file-1",
          fileName: "guide.md",
          mimeType: "text/markdown"
        }]
      }
    });
    expect(decodeKnowledgeUploadBatchCreate({
      clientBatchId: "browser-batch-1",
      files: [{
        byteSize: 12,
        clientFileId: "file-1",
        fileName: "guide.md",
        mimeType: "text/markdown",
        ownerUserId: "attacker"
      }]
    }, 100)).toMatchObject({ ok: false });
  });

  it("rejects over-limit batches, duplicate client ids, and malformed metadata", () => {
    const valid = {
      byteSize: 12,
      clientFileId: "file-1",
      fileName: "guide.md",
      mimeType: "text/markdown"
    };
    expect(decodeKnowledgeUploadBatchCreate({
      clientBatchId: "batch-1",
      files: [valid, valid]
    }, 100)).toMatchObject({ ok: false });
    expect(decodeKnowledgeUploadBatchCreate({
      clientBatchId: "batch-1",
      files: [valid, { ...valid, clientFileId: "file-2" }]
    }, 1)).toMatchObject({ ok: false });
    expect(decodeKnowledgeUploadBatchCreate({
      clientBatchId: "batch-1",
      files: [{ ...valid, byteSize: 0 }]
    }, 100)).toMatchObject({ ok: false });
  });

  it("decodes only fixed checkpoint and attempt-fenced mutation inputs", () => {
    expect(decodeKnowledgeUploadPartCheckpoint({
      attemptNumber: 2,
      byteSize: 8,
      etag: '"part-etag"'
    })).toEqual({
      ok: true,
      value: { attemptNumber: 2, byteSize: 8, etag: '"part-etag"' }
    });
    expect(decodeKnowledgeUploadPartCheckpoint({
      attemptNumber: 2,
      byteSize: 8,
      etag: "part",
      uploadId: "private"
    }))
      .toMatchObject({ ok: false });
    expect(decodeKnowledgeUploadAttempt({ attemptNumber: 2 }))
      .toEqual({ ok: true, value: { attemptNumber: 2 } });
    expect(decodeKnowledgeUploadAttempt({ attemptNumber: 0 })).toMatchObject({ ok: false });
    expect(decodeKnowledgeUploadAttempt({
      attemptNumber: KNOWLEDGE_UPLOAD_ATTEMPT_MAX + 1
    })).toMatchObject({ ok: false });
    expect(decodeKnowledgeUploadPartCheckpoint({
      attemptNumber: KNOWLEDGE_UPLOAD_ATTEMPT_MAX + 1,
      byteSize: 8,
      etag: "part"
    })).toMatchObject({ ok: false });
    expect(decodeKnowledgeUploadAttempt({ attemptNumber: 2, force: true }))
      .toMatchObject({ ok: false });
  });

  it("decodes proxy and multipart projections while excluding private storage state", () => {
    expect(decodeKnowledgeUploadBatchResponse({ batch: batch() })).toEqual({ batch: batch() });
    const multipart = item({
      state: "uploading",
      transport: {
        kind: "multipart",
        parts: [
          { byteOffset: 0, byteSize: 8, complete: true, partNumber: 1, uploadUrl: null },
          { byteOffset: 8, byteSize: 4, complete: false, partNumber: 2, uploadUrl: "https://objects.example.test/part-2?signature=y" }
        ]
      },
      uploadedBytes: 0
    });
    expect(decodeKnowledgeUploadBatchResponse({ batch: batch({ items: [multipart] }) }))
      .not.toBeNull();
    expect(decodeKnowledgeUploadBatchResponse({
      batch: batch({
        items: [item({
          state: "uploading",
          transport: {
            kind: "multipart",
            parts: [
              { byteOffset: 0, byteSize: 8, complete: false, partNumber: 1, uploadUrl: "https://objects.example.test/part-1" }
            ]
          }
        })]
      })
    })).toBeNull();
    expect(decodeKnowledgeUploadBatchResponse({
      batch: batch({ items: [{ ...item(), storageKey: "private/key" }] })
    })).toBeNull();
  });

  it("requires state, transport, source, and error fields to agree", () => {
    expect(decodeKnowledgeUploadBatchResponse({
      batch: batch({ items: [item({ state: "ready", transport: null })] })
    })).toBeNull();
    expect(decodeKnowledgeUploadBatchResponse({
      batch: batch({ items: [item({ failureCode: "upload_failed", state: "needs_attention", transport: null })] })
    })).not.toBeNull();
    expect(decodeKnowledgeUploadBatchListResponse({ batches: [batch(), batch()] })).toBeNull();
  });
});
