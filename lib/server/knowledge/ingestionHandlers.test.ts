// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { KnowledgeIngestionStatusResponse } from "../../contracts/knowledge";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { createUploadPermitGate } from "../http/uploadPermitGate";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import {
  createArchiveKnowledgeDocumentHandler,
  createListKnowledgeDocumentsHandler,
  createReplaceKnowledgeDocumentHandler,
  createRetryKnowledgeDocumentVersionHandler,
  createStartKnowledgeReindexHandler,
  createUploadKnowledgeDocumentHandler,
  type KnowledgeIngestionHandlerDeps
} from "./ingestionHandlers";

const now = "2026-08-08T10:00:00.000Z";

function session(): AuthenticatedSession {
  return {
    expiresAt: new Date("2026-08-09T00:00:00.000Z"),
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

function status(): KnowledgeIngestionStatusResponse {
  return {
    documents: [{
      archived: false,
      currentVersionId: null,
      id: "document-1",
      versions: [{
        byteSize: 5,
        completedAt: null,
        createdAt: now,
        current: false,
        embeddedChunks: 0,
        errorCode: null,
        fileName: "document.txt",
        id: "version-1",
        mimeType: "text/plain",
        pageCount: null,
        payloadAvailable: true,
        state: "queued",
        totalChunks: null,
        updatedAt: now,
        versionNumber: 1,
        visibleFromRevision: null,
        visibleUntilRevision: null
      }]
    }],
    owned: true,
    pagination: {
      page: 1,
      pageSize: 25,
      query: "",
      totalItems: 1,
      totalPages: 1
    },
    reindex: null
  };
}

function repository(
  overrides: Partial<KnowledgeIngestionHandlerDeps["repository"]> = {}
): KnowledgeIngestionHandlerDeps["repository"] {
  return {
    archiveDocument: vi.fn(async () => ({ kind: "ok" as const })),
    canManage: vi.fn(async () => true),
    createVersion: vi.fn(async () => ({
      documentId: "document-1",
      kind: "ok" as const,
      versionId: "version-1"
    })),
    listStatus: vi.fn(async () => status()),
    retryVersion: vi.fn(async () => ({ kind: "ok" as const })),
    startReindex: vi.fn(async () => ({ generationId: "generation-2", kind: "ok" as const })),
    ...overrides
  };
}

function deps(
  repo = repository(),
  storage = createMemoryStorageAdapter()
): KnowledgeIngestionHandlerDeps {
  return {
    deletionOutbox: {
      complete: vi.fn(async () => undefined),
      stage: vi.fn(async () => ({ id: "deletion-job-1" }))
    },
    getBodyConfig: () => ({ uploadMaxConcurrency: 1, uploadMultipartMaxBytes: 20_000 }),
    getConfig: () => ({
      maxChunksPerDocument: 100,
      maxFileBytes: 10_000,
      maxNormalizedChars: 100_000,
      maxNormalizedObjectBytes: 500_000,
      maxPages: 100
    }),
    kickProcessing: vi.fn(),
    repository: repo,
    resolveAuth: vi.fn(async () => session()),
    storage,
    uploadPermitGate: createUploadPermitGate(1)
  };
}

function uploadRequest(): Request {
  const form = new FormData();
  form.set("file", new File([Buffer.from("hello")], "document.txt", { type: "text/plain" }));
  return new Request("http://app.local/api/me/knowledge-bases/base-1/documents", {
    body: form,
    method: "POST"
  });
}

describe("Knowledge ingestion handlers", () => {
  it("checks owner authority before consuming a multipart body", async () => {
    const repo = repository({ canManage: vi.fn(async () => false) });
    const handler = createUploadKnowledgeDocumentHandler(deps(repo));
    const request = new Request("http://app.local/api/me/knowledge-bases/base-1/documents", {
      method: "POST"
    });
    let bodyReads = 0;
    Object.defineProperty(request, "body", {
      configurable: true,
      get() { bodyReads += 1; return null; }
    });

    const response = await handler(request, { params: { baseId: "base-1" } });

    expect(response.status).toBe(404);
    expect(bodyReads).toBe(0);
    expect(repo.createVersion).not.toHaveBeenCalled();
  });

  it("settles an original object, creates queued durable work, and returns status", async () => {
    const repo = repository();
    const storage = createMemoryStorageAdapter();
    const input = deps(repo, storage);
    const response = await createUploadKnowledgeDocumentHandler(input)(
      uploadRequest(),
      { params: { baseId: "base-1" } }
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      document: { id: "document-1", versions: [{ state: "queued" }] }
    });
    expect(repo.createVersion).toHaveBeenCalledWith(expect.objectContaining({
      byteSize: 5,
      checksum: expect.stringMatching(/^[0-9a-f]{64}$/u),
      knowledgeBaseId: "base-1",
      mimeType: "text/plain",
      userId: "owner-1"
    }));
    expect(storage.objects.size).toBe(1);
    expect(input.kickProcessing).toHaveBeenCalledOnce();
  });

  it("derives both upload envelopes from the 50,000,000-byte Knowledge limit", async () => {
    const getBodyConfig = vi.fn(() => ({
      uploadMaxConcurrency: 1,
      uploadMultipartMaxBytes: 51_048_576
    }));
    const input: KnowledgeIngestionHandlerDeps = {
      ...deps(),
      getBodyConfig,
      getConfig: () => ({
        maxChunksPerDocument: 10_000,
        maxFileBytes: 50_000_000,
        maxNormalizedChars: 5_000_000,
        maxNormalizedObjectBytes: 24_194_304,
        maxPages: 2_000
      })
    };

    const created = await createUploadKnowledgeDocumentHandler(input)(
      uploadRequest(),
      { params: { baseId: "base-1" } }
    );
    const replaced = await createReplaceKnowledgeDocumentHandler(input)(
      uploadRequest(),
      { params: { baseId: "base-1", documentId: "document-1" } }
    );

    expect(created.status).toBe(202);
    expect(replaced.status).toBe(202);
    expect(getBodyConfig).toHaveBeenNthCalledWith(1, 50_000_000);
    expect(getBodyConfig).toHaveBeenNthCalledWith(2, 50_000_000);
  });

  it("releases a stored object through the durable outbox when queue creation loses a race", async () => {
    const repo = repository({ createVersion: vi.fn(async () => ({ kind: "active_ingest" as const })) });
    const storage = createMemoryStorageAdapter();
    const input = deps(repo, storage);

    const response = await createUploadKnowledgeDocumentHandler(input)(
      uploadRequest(),
      { params: { baseId: "base-1" } }
    );

    expect(response.status).toBe(409);
    expect(storage.objects.size).toBe(0);
    expect(input.deletionOutbox.stage).toHaveBeenCalledOnce();
    expect(input.deletionOutbox.complete).toHaveBeenCalledWith("deletion-job-1");
  });

  it("returns no-store progress and exposes no private storage keys", async () => {
    const repo = repository();
    const response = await createListKnowledgeDocumentsHandler(deps(repo))(
      new Request("http://app.local/api/me/knowledge-bases/base-1/documents?q=Guide&page=2&pageSize=10"),
      { params: { baseId: "base-1" } }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).not.toContain("storageKey");
    expect(repo.listStatus).toHaveBeenCalledWith("owner-1", "base-1", {
      page: 2,
      pageSize: 10,
      query: "Guide"
    });
  });

  it("rejects malformed or duplicate document-list query controls", async () => {
    const repo = repository();
    const handler = createListKnowledgeDocumentsHandler(deps(repo));

    for (const url of [
      "http://app.local/api/me/knowledge-bases/base-1/documents?page=0",
      "http://app.local/api/me/knowledge-bases/base-1/documents?pageSize=101",
      "http://app.local/api/me/knowledge-bases/base-1/documents?q=one&q=two"
    ]) {
      const response = await handler(new Request(url), { params: { baseId: "base-1" } });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "knowledge_document_query_invalid" });
    }
    expect(repo.listStatus).not.toHaveBeenCalled();
  });

  it("maps retry, archive, and reindex mutations to durable repository operations", async () => {
    const readyStatus: KnowledgeIngestionStatusResponse = {
      ...status(),
      reindex: {
        completedDocuments: 0,
        createdAt: now,
        errorCode: null,
        failedDocuments: 0,
        generationId: "generation-2",
        status: "building",
        targetContentRevision: 0,
        totalDocuments: 1
      }
    };
    const repo = repository({ listStatus: vi.fn(async () => readyStatus) });
    const input = deps(repo);
    const retried = await createRetryKnowledgeDocumentVersionHandler(input)(
      new Request("http://app.local/retry", { method: "POST" }),
      { params: { baseId: "base-1", documentId: "document-1", versionId: "version-1" } }
    );
    const reindexed = await createStartKnowledgeReindexHandler(input)(
      new Request("http://app.local/reindex", {
        body: JSON.stringify({ embeddingDeploymentId: "embedding-2" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }),
      { params: { baseId: "base-1" } }
    );
    const archived = await createArchiveKnowledgeDocumentHandler(input)(
      new Request("http://app.local/document", { method: "DELETE" }),
      { params: { baseId: "base-1", documentId: "document-1" } }
    );

    expect(retried.status).toBe(202);
    expect(reindexed.status).toBe(202);
    expect(archived.status).toBe(204);
    expect(repo.retryVersion).toHaveBeenCalledWith(expect.objectContaining({ versionId: "version-1" }));
    expect(repo.startReindex).toHaveBeenCalledWith(expect.objectContaining({
      embeddingDeploymentId: "embedding-2"
    }));
    expect(repo.archiveDocument).toHaveBeenCalledWith(expect.objectContaining({ documentId: "document-1" }));
  });
});
