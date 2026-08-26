import { describe, expect, it, vi } from "vitest";
import { KnowledgeIngestionCoordinator } from "./ingestionCoordinator";
import { KnowledgeIngestionError, type KnowledgeSourceWorkClaim } from "./ingestionTypes";

function claim(id: string, attemptCount: number): KnowledgeSourceWorkClaim {
  return {
    attemptCount,
    byteSize: 4,
    checksum: "a".repeat(64),
    claimToken: `claim-${id}`,
    sourceId: `document-${id}`,
    sourceVersionId: `version-${id}`,
    fileName: `${id}.txt`,
    artifact: {
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
      id: "artifact-1",
      pdfParserProfileVersion: 1,
      pdfProcessingMode: "local",
      pdfSystemModelPolicyVersion: null,
      pdfSystemModelSnapshot: null,
      profileExecutionAuthority: "legacy_user",
      profileRevisionId: null,
      targetDimension: 1024,
      vectorSpaceFingerprint: "b".repeat(64)
    },
    ingestChunkCount: null,
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
        processed.push(work.sourceVersionId);
        if (work.sourceVersionId === "version-retry") {
          throw new KnowledgeIngestionError("parser_unavailable", true);
        }
        if (work.sourceVersionId === "version-terminal") {
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
      sourceVersionId: "version-retry",
      errorCode: "parser_unavailable"
    }));
    expect(settleFailed).toHaveBeenCalledWith(expect.objectContaining({
      sourceVersionId: "version-terminal",
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

  it("persists the full retry window before exhausting one stage", async () => {
    const baseNow = new Date("2026-08-26T00:00:00.000Z");
    const queued = Array.from({ length: 6 }, (_, index) => claim(`retry-${index + 1}`, index + 1));
    const retryLater = vi.fn(async (_input: { nextAttemptAt: Date }) => true);
    const settleFailed = vi.fn(async () => true);
    const coordinator = new KnowledgeIngestionCoordinator({
      maxParallel: 1,
      now: () => baseNow,
      process: async () => {
        throw new KnowledgeIngestionError("embedding_unavailable", true);
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

    expect(retryLater.mock.calls.map(([input]) =>
      input.nextAttemptAt.getTime() - baseNow.getTime()
    )).toEqual([2_000, 10_000, 30_000, 120_000, 300_000]);
    expect(settleFailed).toHaveBeenCalledOnce();
    expect(settleFailed).toHaveBeenCalledWith(expect.objectContaining({
      sourceVersionId: "version-retry-6"
    }));
  });

  it("honors a valid provider retry delay above the local minimum", async () => {
    const baseNow = new Date("2026-08-26T00:00:00.000Z");
    const failure = new KnowledgeIngestionError(
      "embedding_unavailable",
      true,
      75_000
    );
    const retryLater = vi.fn(async () => true);
    const coordinator = new KnowledgeIngestionCoordinator({
      maxParallel: 1,
      now: () => baseNow,
      process: async () => {
        throw failure;
      },
      repository: {
        claim: vi.fn()
          .mockResolvedValueOnce(claim("rate-limited", 1))
          .mockResolvedValueOnce(null),
        heartbeat: vi.fn(async () => true),
        reconcile: vi.fn(async () => false),
        retryLater,
        settleFailed: vi.fn(async () => true)
      }
    });

    await coordinator.reconcileNow();

    expect(retryLater).toHaveBeenCalledWith(expect.objectContaining({
      nextAttemptAt: new Date(baseNow.getTime() + 75_000)
    }));
  });

  it("bounds an excessive provider retry delay", async () => {
    const baseNow = new Date("2026-08-26T00:00:00.000Z");
    const failure = new KnowledgeIngestionError(
      "embedding_rate_limited",
      true,
      24 * 60 * 60_000
    );
    const retryLater = vi.fn(async () => true);
    const coordinator = new KnowledgeIngestionCoordinator({
      maxParallel: 1,
      now: () => baseNow,
      process: async () => {
        throw failure;
      },
      repository: {
        claim: vi.fn()
          .mockResolvedValueOnce(claim("bounded-rate-limit", 1))
          .mockResolvedValueOnce(null),
        heartbeat: vi.fn(async () => true),
        reconcile: vi.fn(async () => false),
        retryLater,
        settleFailed: vi.fn(async () => true)
      }
    });

    await coordinator.reconcileNow();

    expect(retryLater).toHaveBeenCalledWith(expect.objectContaining({
      nextAttemptAt: new Date(baseNow.getTime() + 15 * 60_000)
    }));
  });
});
