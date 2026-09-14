// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentProcessingError, type AttachmentProcessingRecord } from "./processing";
import { getContext, runWithContext, type ObservabilityContext } from "../observability";
import { rememberDatabaseFailure } from "../observability/databaseFailure";
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
  afterEach(() => vi.restoreAllMocks());

  it.each(["retry", "fail"] as const)("observes the original failure before each %s write outcome", async (stage) => {
    for (const outcome of [true, false, "reject"] as const) {
      const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const records = () => writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
      const repo = repository(claim(stage === "retry" ? 1 : 3));
      const writeError = new Error("PRIVATE_DATABASE_CANARY");
      rememberDatabaseFailure(writeError, "P1001");
      const write = stage === "retry" ? repo.retryLater : repo.settleFailed;
      write.mockImplementation(async () => {
        expect(records()).toContainEqual(expect.objectContaining({ event: "job_attempt", stage: "process", outcome: "failed", code: "parser_unavailable" }));
        if (outcome === "reject") throw writeError;
        return outcome;
      });
      await new AttachmentProcessingCoordinator({ maxParallel: 1, now: () => now, repository: repo,
        process: async () => { throw new AttachmentProcessingError("parser_unavailable", true); }
      }).reconcileNow();
      const persisted = records().find((record) => record.event === "job_persistence");
      expect(persisted).toMatchObject({ subsystem: "attachments", job_id: "job-1", stage,
        outcome: outcome === "reject" ? "unconfirmed" : outcome ? "confirmed" : "not_applied" });
      expect(persisted?.retry_at).toBe(stage === "retry" && outcome === true ? "2026-08-08T00:00:01.000Z" : undefined);
      if (outcome === "reject") expect(persisted?.prisma_code).toBe("P1001");
      expect(JSON.stringify(records())).not.toContain("PRIVATE_");
      expect(records()).toHaveLength(3);
      writer.mockRestore();
    }
  });

  it("keeps healthy idle quiet and bounds repeated claim failures with one recovery", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const repo = repository(claim(1));
    vi.mocked(repo.claim).mockResolvedValue(null);
    const coordinator = new AttachmentProcessingCoordinator({ maxParallel: 1, repository: repo,
      process: async () => ({ extractedText: null, metadata: {} }) });
    await coordinator.reconcileNow(); await coordinator.reconcileNow();
    expect(writer).not.toHaveBeenCalled();
    vi.mocked(repo.claim).mockRejectedValue(new Error("PRIVATE_CLAIM_CANARY"));
    for (let index = 0; index < 5; index += 1) await coordinator.reconcileNow();
    vi.mocked(repo.claim).mockResolvedValue(null);
    await coordinator.reconcileNow(); await coordinator.reconcileNow();
    const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
    expect(records).toMatchObject([
      { event: "runtime_lifecycle", subsystem: "attachments", stage: "claim", outcome: "failed" },
      { event: "subsystem.recovered", subsystem: "attachments", stage: "claim", repeat_count: 4 }
    ]);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
  });

  it.each([true, false])("observes parsed output separately from accepted=%s ready persistence", async (accepted) => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const repo = repository(claim(1)); repo.settleReady.mockResolvedValue(accepted);
    await new AttachmentProcessingCoordinator({ maxParallel: 1, repository: repo,
      process: async () => ({ extractedText: "PRIVATE_DOCUMENT_CANARY", metadata: {} }) }).reconcileNow();
    const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
    expect(records).toMatchObject([
      { event: "job_attempt", stage: "claim", outcome: "started" },
      { event: "job_attempt", stage: "process", outcome: "completed" },
      { event: "job_persistence", stage: "complete", outcome: accepted ? "confirmed" : "not_applied" }
    ]);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_DOCUMENT_CANARY");
  });

  it("isolates upload-triggered drains, queued jobs, and their heartbeat from repeated request kicks", async () => {
    const firstRequest = { trace_id: "a".repeat(32), run_id: "upload-run", job_id: "request-job" };
    const secondRequest = { trace_id: "b".repeat(32), run_id: "other-run" };
    const queued = [
      { ...claim(1), id: "other-owner-attachment", jobId: "other-owner-job" },
      { ...claim(1), id: "next-attachment", jobId: "next-job" }
    ];
    const claims: Array<ObservabilityContext | undefined> = [];
    const processed = new Map<string, ObservabilityContext | undefined>();
    const resumed = new Map<string, ObservabilityContext | undefined>();
    const settled = new Map<string, ObservabilityContext | undefined>();
    let heartbeatContext: ObservabilityContext | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let heartbeatSeen!: () => void;
    const heartbeat = new Promise<void>((resolve) => { heartbeatSeen = resolve; });
    const repo: AttachmentProcessingRepository = {
      ...repository(claim(1)),
      async claim() {
        claims.push(getContext());
        return queued.shift() ?? null;
      },
      async heartbeat() {
        heartbeatContext = getContext();
        heartbeatSeen();
        return true;
      },
      async settleReady({ jobId }) {
        settled.set(jobId, getContext());
        return true;
      }
    };
    const coordinator = new AttachmentProcessingCoordinator({
      heartbeatMs: 1,
      intervalMs: 60_000,
      maxParallel: 1,
      async process(record) {
        processed.set(record.jobId, getContext());
        if (record.jobId === "other-owner-job") await gate;
        resumed.set(record.jobId, getContext());
        return { extractedText: "ready", metadata: {} };
      },
      repository: repo
    });
    try {
      runWithContext(firstRequest, () => {
        coordinator.start();
        expect(getContext()).toEqual(firstRequest);
      });
      const drain = runWithContext(secondRequest, () => coordinator.reconcileNow());
      await heartbeat;
      release();
      await drain;
      const firstDrainTrace = claims[0]?.trace_id;
      await runWithContext(secondRequest, () => coordinator.reconcileNow());

      for (const [jobId, context] of processed) {
        expect(context).toEqual({ trace_id: expect.stringMatching(/^[0-9a-f]{32}$/u), job_id: jobId });
        expect(context?.trace_id).not.toBe(firstRequest.trace_id);
        expect(context?.trace_id).not.toBe(secondRequest.trace_id);
        expect(settled.get(jobId)).toEqual(context);
      }
      expect(processed.size).toBe(2);
      expect(resumed).toEqual(processed);
      expect(processed.get("other-owner-job")?.trace_id).not.toBe(processed.get("next-job")?.trace_id);
      expect(heartbeatContext).toEqual(processed.get("other-owner-job"));
      for (const context of claims) {
        expect(context).toEqual({ trace_id: expect.stringMatching(/^[0-9a-f]{32}$/u) });
        expect(context?.trace_id).not.toBe(firstRequest.trace_id);
        expect(context?.trace_id).not.toBe(secondRequest.trace_id);
      }
      expect(claims.at(-1)?.trace_id).not.toBe(firstDrainTrace);
    } finally {
      release();
      coordinator.stop();
    }
  });

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
      const writer = vi.spyOn(globalThis.process.stdout, "write").mockImplementation(() => true);
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
      const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
      const start = records.find((record) => record.event === "job_attempt" && record.stage === "claim");
      expect(records).toContainEqual(expect.objectContaining({ event: "job_attempt", stage: "heartbeat", outcome: "lost_lease",
        level: "info", job_id: "job-1", trace_id: start.trace_id }));
    } finally {
      vi.useRealTimers();
    }
  });
});
