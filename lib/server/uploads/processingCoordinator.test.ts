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
});
