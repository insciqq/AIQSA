// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { AttachmentProcessingError, type AttachmentProcessingRecord } from "./processing";
import {
  AttachmentProcessingCoordinator,
  type AttachmentProcessingRepository
} from "./processingCoordinator";

const now = new Date("2026-08-08T00:00:00.000Z");

function claim(attemptCount: number): AttachmentProcessingRecord {
  return {
    attemptCount,
    byteSize: 4,
    checksum: null,
    claimToken: "claim-1",
    fileName: "report.docx",
    id: "attachment-1",
    jobId: "job-1",
    kind: "document",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    storageKey: "private/object"
  };
}

function repository(record: AttachmentProcessingRecord): AttachmentProcessingRepository & {
  heartbeat: ReturnType<typeof vi.fn>;
  retryLater: ReturnType<typeof vi.fn>;
  settleFailed: ReturnType<typeof vi.fn>;
  settleReady: ReturnType<typeof vi.fn>;
} {
  let returned = false;
  return {
    claim: vi.fn(async () => returned ? null : (returned = true, record)),
    heartbeat: vi.fn(async () => true),
    retryLater: vi.fn(async () => true),
    settleFailed: vi.fn(async () => true),
    settleReady: vi.fn(async () => true)
  };
}

describe("attachment processing coordinator", () => {
  it("releases transient failures for a bounded durable retry", async () => {
    const repo = repository(claim(1));
    const coordinator = new AttachmentProcessingCoordinator({
      maxParallel: 1,
      now: () => now,
      process: async () => { throw new AttachmentProcessingError("parser_unavailable", true); },
      repository: repo
    });

    await coordinator.reconcileNow();

    expect(repo.retryLater).toHaveBeenCalledWith({
      claimToken: "claim-1",
      errorCode: "parser_unavailable",
      jobId: "job-1",
      nextAttemptAt: new Date("2026-08-08T00:00:01.000Z"),
      now
    });
    expect(repo.settleFailed).not.toHaveBeenCalled();
  });

  it("settles a stopped-sidecar DOCX as failed after the bounded attempt count", async () => {
    const repo = repository(claim(3));
    const coordinator = new AttachmentProcessingCoordinator({
      maxParallel: 1,
      now: () => now,
      process: async () => { throw new AttachmentProcessingError("parser_unavailable", true); },
      repository: repo
    });

    await coordinator.reconcileNow();

    expect(repo.settleFailed).toHaveBeenCalledWith({
      attachmentId: "attachment-1",
      claimToken: "claim-1",
      errorCode: "parser_unavailable",
      jobId: "job-1",
      now
    });
    expect(repo.retryLater).not.toHaveBeenCalled();
  });

  it("publishes parsed output only through the active lease", async () => {
    const repo = repository(claim(1));
    const result = { extractedText: "ready", metadata: { document: { engine: "docling" } } };
    const coordinator = new AttachmentProcessingCoordinator({
      maxParallel: 1,
      now: () => now,
      process: vi.fn(async () => result),
      repository: repo
    });

    await coordinator.reconcileNow();

    expect(repo.settleReady).toHaveBeenCalledWith({
      attachmentId: "attachment-1",
      claimToken: "claim-1",
      jobId: "job-1",
      now,
      result
    });
  });

  it.each([1, 3])(
    "retries a transient ready-write without reprocessing or failing attempt %i",
    async (attemptCount) => {
      const repo = repository(claim(attemptCount));
      const result = { extractedText: "ready", metadata: { document: { engine: "docling" } } };
      const process = vi.fn(async () => result);
      repo.settleReady
        .mockRejectedValueOnce(new Error("transient_database_failure"))
        .mockResolvedValueOnce(true);
      const coordinator = new AttachmentProcessingCoordinator({
        maxParallel: 1,
        now: () => now,
        process,
        repository: repo,
        settleRetryDelaysMs: [0]
      });

      await coordinator.reconcileNow();

      expect(process).toHaveBeenCalledOnce();
      expect(repo.settleReady).toHaveBeenCalledTimes(2);
      expect(repo.settleReady).toHaveBeenLastCalledWith({
        attachmentId: "attachment-1",
        claimToken: "claim-1",
        jobId: "job-1",
        now,
        result
      });
      expect(repo.retryLater).not.toHaveBeenCalled();
      expect(repo.settleFailed).not.toHaveBeenCalled();
    }
  );

  it("leaves the claimed job recoverable after bounded ready-write retries are exhausted", async () => {
    const repo = repository(claim(3));
    const process = vi.fn(async () => ({ extractedText: "ready", metadata: {} }));
    repo.settleReady.mockRejectedValue(new Error("database_unavailable"));
    const coordinator = new AttachmentProcessingCoordinator({
      maxParallel: 1,
      now: () => now,
      process,
      repository: repo,
      settleRetryDelaysMs: [0, 0]
    });

    await coordinator.reconcileNow();

    expect(process).toHaveBeenCalledOnce();
    expect(repo.settleReady).toHaveBeenCalledTimes(3);
    expect(repo.retryLater).not.toHaveBeenCalled();
    expect(repo.settleFailed).not.toHaveBeenCalled();
  });

  it("stops ready-write retries when the heartbeat loses the claim", async () => {
    vi.useFakeTimers();
    try {
      const repo = repository(claim(1));
      repo.heartbeat.mockResolvedValue(false);
      repo.settleReady.mockRejectedValue(new Error("database_unavailable"));
      const coordinator = new AttachmentProcessingCoordinator({
        heartbeatMs: 10,
        maxParallel: 1,
        now: () => now,
        process: async () => ({ extractedText: "ready", metadata: {} }),
        repository: repo,
        settleRetryDelaysMs: [100]
      });

      const reconciliation = coordinator.reconcileNow();
      await vi.advanceTimersByTimeAsync(10);
      await reconciliation;

      expect(repo.heartbeat).toHaveBeenCalledOnce();
      expect(repo.settleReady).toHaveBeenCalledOnce();
      expect(repo.retryLater).not.toHaveBeenCalled();
      expect(repo.settleFailed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
