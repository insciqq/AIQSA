// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { createUploadPermitGate } from "../http/uploadPermitGate";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import type {
  KnowledgeUploadAdmissionItem,
  KnowledgeUploadBatchRecord,
  KnowledgeUploadPrivateTarget
} from "./uploadRepository";
import {
  createKnowledgeUploadBatchCollectionHandlers,
  createStreamKnowledgeUploadItemHandler,
  type KnowledgeUploadHandlerDeps
} from "./uploadHandlers";

const now = new Date("2026-08-18T10:00:00.000Z");

function session(): AuthenticatedSession {
  return {
    expiresAt: new Date("2026-08-19T00:00:00.000Z"),
    id: "session-1",
    user: {
      displayName: "Owner",
      email: "owner@example.test",
      id: "owner-1",
      role: "user",
      status: "active"
    },
    userId: "owner-1"
  };
}

function itemRecord(
  input: Partial<KnowledgeUploadAdmissionItem> & Readonly<{
    id?: string;
    state?: "QUEUED" | "STORED";
  }> = {}
) {
  const state = input.state ?? "QUEUED";
  return {
    attemptNumber: 1,
    batchId: "batch-1",
    cancelledAt: null,
    checksumHint: null,
    clientFileId: input.clientFileId ?? "file-1",
    createdAt: now,
    declaredByteSize: input.declaredByteSize ?? 5,
    declaredMimeType: input.declaredMimeType ?? "text/plain",
    documentId: null,
    documentVersionId: null,
    failureCode: null,
    fileName: input.fileName ?? "document.txt",
    id: input.id ?? "item-1",
    multipartUploadId: null,
    normalizedMimeType: input.normalizedMimeType ?? "text/plain",
    parts: [],
    sessionExpiresAt: input.sessionExpiresAt ?? new Date("2026-08-18T10:15:00.000Z"),
    settledAt: null,
    sourceId: null,
    sourceState: null,
    sourceVersionId: null,
    state,
    storageKey: input.storageKey ?? "knowledge/uploads/owner-1/batch-1/item-1",
    transport: "PROXY",
    updatedAt: now,
    uploadedByteSize: state === "STORED" ? input.declaredByteSize ?? 5 : 0
  };
}

function batchRecord(items = [itemRecord()]): KnowledgeUploadBatchRecord {
  return {
    clientBatchId: "client-batch-1",
    createdAt: now,
    id: "batch-1",
    items,
    knowledgeBaseId: "base-1",
    ownerUserId: "owner-1",
    updatedAt: now
  } as unknown as KnowledgeUploadBatchRecord;
}

function repository(overrides: Record<string, unknown> = {}): KnowledgeUploadHandlerDeps["repository"] {
  return {
    cancel: vi.fn(),
    claimProxyStream: vi.fn(async () => "ok" as const),
    checkpointPart: vi.fn(),
    createBatch: vi.fn(),
    getBatch: vi.fn(async () => batchRecord()),
    getByClientBatchId: vi.fn(async () => null),
    getTarget: vi.fn(async () => null),
    listBatches: vi.fn(async () => []),
    markAttention: vi.fn(async () => true),
    markStored: vi.fn(async () => true),
    retry: vi.fn(),
    settle: vi.fn(),
    start: vi.fn(async () => "ok" as const),
    ...overrides
  } as unknown as KnowledgeUploadHandlerDeps["repository"];
}

function deps(
  repo: KnowledgeUploadHandlerDeps["repository"],
  storage = createMemoryStorageAdapter()
): KnowledgeUploadHandlerDeps {
  return {
    deletionOutbox: {
      complete: vi.fn(async () => undefined),
      stage: vi.fn(async () => ({ id: "deletion-job-1" }))
    },
    getBodyConfig: () => ({ uploadMaxConcurrency: 4 }),
    getExtractionConfig: () => ({
      maxChunksPerDocument: 10_000,
      maxFileBytes: 50_000_000,
      maxNormalizedChars: 5_000_000,
      maxNormalizedObjectBytes: 24_194_304,
      maxPages: 2_000
    }),
    getUploadConfig: () => ({
      maxBatchFiles: 100,
      multipartPartBytes: 8 * 1_024 * 1_024,
      sessionSeconds: 900
    }),
    now: () => now,
    repository: repo,
    resolveAuth: vi.fn(async () => session()),
    storage,
    uploadPermitGate: createUploadPermitGate(4)
  };
}

describe("Knowledge bulk upload handlers", () => {
  it("admits a 50-file metadata batch without receiving file bodies", async () => {
    let createdBatch: KnowledgeUploadBatchRecord | null = null;
    let createdItemCount = 0;
    const createBatch = vi.fn(async (input: Readonly<{
      batchId: string;
      clientBatchId: string;
      items: readonly KnowledgeUploadAdmissionItem[];
      knowledgeBaseId: string;
      userId: string;
    }>) => {
      createdBatch = {
        ...batchRecord(input.items.map((item) => itemRecord({ ...item }))),
        clientBatchId: input.clientBatchId,
        id: input.batchId,
        items: input.items.map((item) => ({
          ...itemRecord({ ...item }),
          batchId: input.batchId,
          id: item.id
        }))
      } as unknown as KnowledgeUploadBatchRecord;
      createdItemCount = input.items.length;
      return { batch: createdBatch, kind: "created" as const };
    });
    const repo = repository({ createBatch });
    const storage = createMemoryStorageAdapter();
    const handler = createKnowledgeUploadBatchCollectionHandlers(deps(repo, storage)).POST;
    const files = Array.from({ length: 50 }, (_, index) => ({
      byteSize: index + 1,
      clientFileId: `file-${index + 1}`,
      fileName: `document-${index + 1}.md`,
      mimeType: "text/markdown"
    }));

    const response = await handler(new Request("http://app.local/api/me/knowledge-bases/base-1/upload-batches", {
      body: JSON.stringify({ clientBatchId: "batch-browser-1", files }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }), { params: { baseId: "base-1" } });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      batch: { items: expect.arrayContaining([expect.objectContaining({ fileName: "document-50.md" })]) }
    });
    expect(createBatch).toHaveBeenCalledWith(expect.objectContaining({
      items: expect.arrayContaining([expect.objectContaining({
        declaredByteSize: 50,
        fileName: "document-50.md"
      })])
    }));
    expect(createdItemCount).toBe(50);
    expect(storage.objects.size).toBe(0);
  });

  it("streams a proxy body without calling whole-body readers", async () => {
    const storage = createMemoryStorageAdapter();
    const target = itemRecord() as unknown as KnowledgeUploadPrivateTarget;
    const repo = repository({
      getBatch: vi.fn(async () => batchRecord([itemRecord({ state: "STORED" })])),
      getTarget: vi.fn(async () => target)
    });
    const handler = createStreamKnowledgeUploadItemHandler(deps(repo, storage));
    const request = new Request("http://app.local/content?attempt=1", {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("he"));
          controller.enqueue(new TextEncoder().encode("llo"));
          controller.close();
        }
      }),
      headers: { "content-length": "5" },
      method: "PUT",
      duplex: "half"
    } as RequestInit & { duplex: "half" });
    const arrayBuffer = vi.spyOn(request, "arrayBuffer");
    const formData = vi.spyOn(request, "formData");

    const response = await handler(request, {
      params: { baseId: "base-1", batchId: "batch-1", itemId: "item-1" }
    });

    expect(response.status).toBe(202);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(formData).not.toHaveBeenCalled();
    expect(storage.objects.get(target.storageKey!)?.body.toString()).toBe("hello");
    expect(repo.claimProxyStream).toHaveBeenCalledWith({
      attemptNumber: 1,
      batchId: "batch-1",
      itemId: "item-1",
      knowledgeBaseId: "base-1",
      now,
      storageKey: target.storageKey,
      userId: "owner-1"
    });
    expect(repo.start).not.toHaveBeenCalled();
    expect(repo.markStored).toHaveBeenCalledWith({
      attemptNumber: 1,
      batchId: "batch-1",
      itemId: "item-1",
      knowledgeBaseId: "base-1",
      storageKey: target.storageKey,
      userId: "owner-1"
    });
    expect(JSON.stringify(await response.json())).not.toContain(target.storageKey);
  });

  it("deletes a streamed object when its durable attempt was superseded", async () => {
    const storage = createMemoryStorageAdapter();
    const target = itemRecord() as unknown as KnowledgeUploadPrivateTarget;
    const repo = repository({
      getTarget: vi.fn(async () => target),
      markStored: vi.fn(async () => false)
    });
    const input = deps(repo, storage);
    const handler = createStreamKnowledgeUploadItemHandler(input);
    const response = await handler(new Request("http://app.local/content?attempt=1", {
      body: "hello",
      headers: { "content-length": "5" },
      method: "PUT"
    }), {
      params: { baseId: "base-1", batchId: "batch-1", itemId: "item-1" }
    });

    expect(response.status).toBe(409);
    expect(storage.objects.has(target.storageKey!)).toBe(false);
    expect(input.deletionOutbox.stage).toHaveBeenCalledWith(target.storageKey, null);
    expect(input.deletionOutbox.complete).toHaveBeenCalledWith("deletion-job-1");
  });

  it("rejects a stale proxy URL before claiming or consuming the replacement attempt", async () => {
    const storage = createMemoryStorageAdapter();
    const target = {
      ...itemRecord(),
      attemptNumber: 2,
      storageKey: "knowledge/objects/replacement"
    } as unknown as KnowledgeUploadPrivateTarget;
    const repo = repository({ getTarget: vi.fn(async () => target) });
    const handler = createStreamKnowledgeUploadItemHandler(deps(repo, storage));

    const response = await handler(new Request("http://app.local/content?attempt=1", {
      body: "hello",
      headers: { "content-length": "5" },
      method: "PUT"
    }), {
      params: { baseId: "base-1", batchId: "batch-1", itemId: "item-1" }
    });

    expect(response.status).toBe(404);
    expect(repo.claimProxyStream).not.toHaveBeenCalled();
    expect(storage.objects.size).toBe(0);
  });

  it("authenticates before inspecting a streaming request body", async () => {
    const repo = repository();
    const input: KnowledgeUploadHandlerDeps = {
      ...deps(repo),
      resolveAuth: vi.fn(async () => null)
    };
    const handler = createStreamKnowledgeUploadItemHandler(input);
    const request = new Request("http://app.local/content", { method: "PUT" });
    let bodyReads = 0;
    Object.defineProperty(request, "body", {
      configurable: true,
      get() {
        bodyReads += 1;
        return null;
      }
    });

    const response = await handler(request, {
      params: { baseId: "base-1", batchId: "batch-1", itemId: "item-1" }
    });

    expect(response.status).toBe(401);
    expect(bodyReads).toBe(0);
    expect(repo.getTarget).not.toHaveBeenCalled();
  });
});
