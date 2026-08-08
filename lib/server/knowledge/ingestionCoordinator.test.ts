import { describe, expect, it, vi } from "vitest";
import { KnowledgeIngestionCoordinator } from "./ingestionCoordinator";
import { KnowledgeIngestionError, type KnowledgeDocumentWorkClaim } from "./ingestionTypes";

function claim(id: string, attemptCount: number): KnowledgeDocumentWorkClaim {
  return {
    attemptCount,
    byteSize: 4,
    checksum: "a".repeat(64),
    claimToken: `claim-${id}`,
    documentId: `document-${id}`,
    documentVersionId: `version-${id}`,
    fileName: `${id}.txt`,
    generation: {
      chunkingProfileVersion: 1,
      embeddingConfiguration: {
        adapterKind: "openai_embeddings_compatible",
        deploymentId: "embedding-1",
        nativeDimension: 1024,
        providerFamily: "openai",
        queryInstructionTemplate: null,
        schemaVersion: 1,
        supportsMrl: false,
        targetDimension: 1024,
        upstreamModelId: "embed-1"
      },
      embeddingProviderModelId: "embedding-1",
      id: "generation-1",
      targetDimension: 1024,
      vectorSpaceFingerprint: "b".repeat(64)
    },
    ingestChunkCount: null,
    kind: "document",
    knowledgeBaseId: "base-1",
    mimeType: "text/plain",
    normalizedTextByteSize: null,
    normalizedTextChecksum: null,
    normalizedTextStorageKey: "normalized.json",
    originalStorageKey: `original-${id}`,
    ownerUserId: "owner-1",
    state: "queued"
  };
}

describe("Knowledge ingestion coordinator", () => {
  it("isolates poisoned work and applies bounded retry policy per claim", async () => {
    const queued = [claim("retry", 1), claim("terminal", 3), claim("healthy", 1)];
    const retryLater = vi.fn(async () => true);
    const settleFailed = vi.fn(async () => true);
    const processed: string[] = [];
    const coordinator = new KnowledgeIngestionCoordinator({
      maxParallel: 1,
      process: async (work) => {
        processed.push(work.documentVersionId);
        if (work.documentVersionId === "version-retry") {
          throw new KnowledgeIngestionError("parser_unavailable", true);
        }
        if (work.documentVersionId === "version-terminal") {
          throw new KnowledgeIngestionError("parser_rejected", false);
        }
      },
      repository: {
        claim: vi.fn(async () => queued.shift() ?? null),
        heartbeat: vi.fn(async () => true),
        reconcile: vi.fn(async () => false),
        retryLater,
        settleFailed
      }
    });

    await coordinator.reconcileNow();

    expect(processed).toEqual(["version-retry", "version-terminal", "version-healthy"]);
    expect(retryLater).toHaveBeenCalledWith(expect.objectContaining({
      documentVersionId: "version-retry",
      errorCode: "parser_unavailable"
    }));
    expect(settleFailed).toHaveBeenCalledWith(expect.objectContaining({
      documentVersionId: "version-terminal",
      errorCode: "parser_rejected"
    }));
  });

  it("abandons settlement when a heartbeat proves that the lease was lost", async () => {
    const queued = [claim("lease", 1)];
    const retryLater = vi.fn(async () => true);
    const settleFailed = vi.fn(async () => true);
    const heartbeat = vi.fn(async () => false);
    const coordinator = new KnowledgeIngestionCoordinator({
      heartbeatMs: 1,
      maxParallel: 1,
      process: async (_work, signal) => new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        setTimeout(resolve, 100).unref?.();
      }),
      repository: {
        claim: vi.fn(async () => queued.shift() ?? null),
        heartbeat,
        reconcile: vi.fn(async () => false),
        retryLater,
        settleFailed
      }
    });

    await coordinator.reconcileNow();

    expect(heartbeat).toHaveBeenCalled();
    expect(retryLater).not.toHaveBeenCalled();
    expect(settleFailed).not.toHaveBeenCalled();
  });
});
