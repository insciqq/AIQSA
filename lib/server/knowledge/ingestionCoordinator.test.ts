import { rememberDatabaseFailure } from "../observability/databaseFailure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampKnowledgeIngestionParallelism,
  KnowledgeIngestionCoordinator
} from "./ingestionCoordinator";
import { KnowledgeIngestionError, type KnowledgeSourceWorkClaim } from "./ingestionTypes";
import { getContext, reportSubsystemHealthy, runWithContext, type ObservabilityContext } from "../observability";

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
      processingGeneration: 0,
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
  it("gives parallel owners separate work contexts while shared drains and heartbeat retain their scope", async () => {
    const request = { trace_id: "c".repeat(32), run_id: "request-run", job_id: "request-job" };
    const queued = ["first", "second"].map((id) => {
      const work = claim(id, 1);
      return { ...work, ownerUserId: `owner-${id}`, artifact: { ...work.artifact, id: `work-${id}` } };
    });
    const processed = new Map<string, ObservabilityContext | undefined>();
    const resumed = new Map<string, ObservabilityContext | undefined>();
    const beats = new Map<string, ObservabilityContext | undefined>();
    const shared: Array<ObservabilityContext | undefined> = [];
    let failedContext: ObservabilityContext | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let heartbeatsSeen!: () => void;
    const heartbeats = new Promise<void>((resolve) => { heartbeatsSeen = resolve; });
    const coordinator = new KnowledgeIngestionCoordinator({
      heartbeatMs: 1,
      intervalMs: 60_000,
      maxParallel: 2,
      async process(work) {
        processed.set(work.artifact.id, getContext());
        await gate;
        resumed.set(work.artifact.id, getContext());
        if (work.ownerUserId === "owner-first") throw new KnowledgeIngestionError("parser_rejected", false);
      },
      repository: {
        async claim() {
          shared.push(getContext());
          return queued.shift() ?? null;
        },
        async heartbeat({ artifactId }) {
          beats.set(artifactId, getContext());
          if (beats.size === 2) heartbeatsSeen();
          return true;
        },
        async reconcile() { shared.push(getContext()); return false; },
        retryLater: vi.fn(async () => true),
        async settleFailed() { failedContext = getContext(); return true; }
      }
    });
    try {
      runWithContext(request, () => coordinator.start());
      const drain = runWithContext({ trace_id: "d".repeat(32), run_id: "next-request" }, () => coordinator.reconcileNow());
      await heartbeats;
      release();
      await drain;

      expect(processed.size).toBe(2);
      expect(resumed).toEqual(processed);
      expect(processed.get("work-first")?.trace_id).not.toBe(processed.get("work-second")?.trace_id);
      for (const [jobId, context] of processed) {
        expect(context).toEqual({ trace_id: expect.stringMatching(/^[0-9a-f]{32}$/u), job_id: jobId });
        expect(context?.trace_id).not.toBe(request.trace_id);
        expect(beats.get(jobId)).toEqual(context);
      }
      expect(failedContext).toEqual(processed.get("work-first"));
      for (const context of shared) {
        expect(context).toEqual({ trace_id: expect.stringMatching(/^[0-9a-f]{32}$/u) });
        expect(context?.trace_id).not.toBe(request.trace_id);
      }
    } finally {
      release();
      coordinator.stop();
    }
  });

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

  it("applies the configured parallelism width at each drain cycle", async () => {
    const widths = [1, 3];
    const parallelism = vi.fn(async () => widths.shift() ?? 3);
    const queue = [claim("first-1", 1), claim("first-2", 1)];
    const peaks = [0, 0];
    let active = 0;
    let cycle = 0;
    const reconcile = vi.fn(async () => {
      if (cycle > 0) return false;
      cycle = 1;
      queue.push(claim("second-1", 1), claim("second-2", 1), claim("second-3", 1));
      return true;
    });
    const coordinator = new KnowledgeIngestionCoordinator({
      maxParallel: parallelism,
      process: async () => {
        active += 1;
        peaks[cycle] = Math.max(peaks[cycle] ?? 0, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      },
      repository: {
        claim: vi.fn(async () => queue.shift() ?? null),
        heartbeat: vi.fn(async () => true),
        reconcile,
        retryLater: vi.fn(async () => true),
        settleFailed: vi.fn(async () => true)
      }
    });

    await coordinator.reconcileNow();

    expect(parallelism).toHaveBeenCalledTimes(2);
    expect(peaks[0]).toBe(1);
    expect(peaks[1]).toBe(3);
  });

  it("keeps draining with the default width when the parallelism read fails", async () => {
    const queue = [claim("fallback-1", 1), claim("fallback-2", 1)];
    const processed: string[] = [];
    const coordinator = new KnowledgeIngestionCoordinator({
      maxParallel: () => {
        throw new Error("parallelism_read_failed");
      },
      process: async (work) => {
        processed.push(work.sourceVersionId);
      },
      repository: {
        claim: vi.fn(async () => queue.shift() ?? null),
        heartbeat: vi.fn(async () => true),
        reconcile: vi.fn(async () => false),
        retryLater: vi.fn(async () => true),
        settleFailed: vi.fn(async () => true)
      }
    });

    await coordinator.reconcileNow();

    expect(processed.sort()).toEqual(["version-fallback-1", "version-fallback-2"]);
  });

  it("clamps an out-of-range configured width instead of stopping work", async () => {
    const queue = [claim("clamped", 1)];
    const processed: string[] = [];
    const coordinator = new KnowledgeIngestionCoordinator({
      maxParallel: async () => 0,
      process: async (work) => {
        processed.push(work.sourceVersionId);
      },
      repository: {
        claim: vi.fn(async () => queue.shift() ?? null),
        heartbeat: vi.fn(async () => true),
        reconcile: vi.fn(async () => false),
        retryLater: vi.fn(async () => true),
        settleFailed: vi.fn(async () => true)
      }
    });

    await coordinator.reconcileNow();

    expect(processed).toEqual(["version-clamped"]);
  });

  it("keeps polling new work while an unchanged recovery sweep waits for its next interval", async () => {
    vi.useFakeTimers();
    const queue: KnowledgeSourceWorkClaim[] = [];
    const reconcile = vi.fn(async () => false);
    const process = vi.fn(async (_work: KnowledgeSourceWorkClaim) => undefined);
    const coordinator = new KnowledgeIngestionCoordinator({
      maxParallel: 1,
      process,
      repository: {
        claim: vi.fn(async () => queue.shift() ?? null),
        heartbeat: vi.fn(async () => true),
        reconcile,
        retryLater: vi.fn(async () => true),
        settleFailed: vi.fn(async () => true)
      }
    });
    try {
      coordinator.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reconcile).toHaveBeenCalledTimes(1);
      queue.push(claim("new-arrival", 1));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(process).toHaveBeenCalledWith(expect.objectContaining({
        sourceVersionId: "version-new-arrival"
      }), expect.any(AbortSignal));
      // Processing can unblock publication/migration and requires an immediate
      // sweep even before the idle sweep interval has elapsed.
      expect(reconcile).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(reconcile).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reconcile).toHaveBeenCalledTimes(3);
      await coordinator.reconcileNow();
      expect(reconcile).toHaveBeenCalledTimes(4);
      reconcile.mockRejectedValueOnce(new Error("reconciliation_unavailable"));
      await coordinator.reconcileNow();
      expect(reconcile).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reconcile).toHaveBeenCalledTimes(6);
    } finally {
      coordinator.stop();
      vi.useRealTimers();
    }
  });

  it("coalesces periodic ticks during a slow idle sweep and retains explicit kicks", async () => {
    vi.useFakeTimers();
    let finish: (changed: boolean) => void = () => undefined;
    const reconcile = vi.fn(async () => false).mockImplementationOnce(() =>
      new Promise<boolean>(resolve => { finish = resolve; }));
    const claimWork = vi.fn(async () => null);
    const coordinator = new KnowledgeIngestionCoordinator({
      maxParallel: 1,
      process: async () => undefined,
      repository: {
        claim: claimWork,
        heartbeat: vi.fn(async () => true),
        reconcile,
        retryLater: vi.fn(async () => true),
        settleFailed: vi.fn(async () => true)
      }
    });
    try {
      coordinator.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reconcile).toHaveBeenCalledTimes(1);
      finish(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(claimWork).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(1);

      reconcile.mockImplementationOnce(() =>
        new Promise<boolean>(resolve => { finish = resolve; }));
      coordinator.kick();
      await vi.advanceTimersByTimeAsync(0);
      coordinator.kick();
      await vi.advanceTimersByTimeAsync(5_000);
      finish(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(reconcile).toHaveBeenCalledTimes(3);
    } finally {
      finish(false);
      coordinator.stop();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });
});

describe("Knowledge ingestion parallelism clamp", () => {
  it("clamps invalid, missing, and out-of-range widths to safe bounds", () => {
    expect(clampKnowledgeIngestionParallelism(undefined)).toBe(8);
    expect(clampKnowledgeIngestionParallelism(null)).toBe(8);
    expect(clampKnowledgeIngestionParallelism("4")).toBe(8);
    expect(clampKnowledgeIngestionParallelism(Number.NaN)).toBe(8);
    expect(clampKnowledgeIngestionParallelism(2.5)).toBe(8);
    expect(clampKnowledgeIngestionParallelism(0)).toBe(1);
    expect(clampKnowledgeIngestionParallelism(-3)).toBe(1);
    expect(clampKnowledgeIngestionParallelism(99)).toBe(64);
    expect(clampKnowledgeIngestionParallelism(1)).toBe(1);
    expect(clampKnowledgeIngestionParallelism(8)).toBe(8);
    expect(clampKnowledgeIngestionParallelism(64)).toBe(64);
  });
});


describe("Knowledge job diagnostics", () => {
  beforeEach(() => {
    for (const stage of ["claim", "reconcile", "preflight", "heartbeat"] as const) reportSubsystemHealthy("knowledge", stage);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  function capture() {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    return () => writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
  }

  it("reports original processing failure before true, false, and rejected retry writes with confirmed dates only", async () => {
    const records = capture();
    const now = new Date("2026-09-13T12:00:00.000Z");
    const queued = ["confirmed", "stale", "rejected"].map((id) => {
      const work = claim(id, 1);
      return { ...work, artifact: { ...work.artifact, id } };
    });
    const persistenceFailure = new Error("PRIVATE_PRISMA_PAYLOAD");
    rememberDatabaseFailure(persistenceFailure, "P1001");
    const service = new KnowledgeIngestionCoordinator({
      now: () => now, maxParallel: 1,
      process: async () => { throw new KnowledgeIngestionError("embedding_rate_limited", true, 90_000); },
      repository: {
        claim: async () => queued.shift() ?? null,
        heartbeat: async () => true, reconcile: async () => false,
        settleFailed: vi.fn(async () => true),
        retryLater: async ({ artifactId, nextAttemptAt, errorCode }) => {
          expect(records().at(-1)).toMatchObject({ event: "job_attempt", job_id: artifactId,
            outcome: "failed", action: "retry", code: "embedding_rate_limited" });
          expect(errorCode).toBe("embedding_rate_limited");
          expect(nextAttemptAt).toEqual(new Date(now.getTime() + 90_000));
          if (artifactId === "rejected") throw persistenceFailure;
          return artifactId === "confirmed";
        }
      }
    });
    await runWithContext({ trace_id: "f".repeat(32), run_id: "PRIVATE_RUN" }, () => service.reconcileNow());
    expect(records()).toHaveLength(9);
    const writes = records().filter((record) => record.event === "job_persistence");
    expect(writes).toEqual([
      expect.objectContaining({ job_id: "confirmed", outcome: "confirmed", retry_at: "2026-09-13T12:01:30.000Z", delay_ms: 90_000 }),
      expect.objectContaining({ job_id: "stale", outcome: "not_applied" }),
      expect.objectContaining({ job_id: "rejected", outcome: "unconfirmed", prisma_code: "P1001" })
    ]);
    for (const write of writes.slice(1)) {
      expect(write).not.toHaveProperty("retry_at");
      expect(write).not.toHaveProperty("delay_ms");
    }
    expect(new Set(writes.map((record) => record.trace_id)).size).toBe(3);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("bounds failing heartbeats and reports recovery once while preserving the job's live signal", async () => {
    vi.useFakeTimers();
    const records = capture();
    const queued = [claim("heartbeat", 1)];
    let release!: () => void;
    let workSignal: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const heartbeat = vi.fn().mockRejectedValueOnce(new Error("PRIVATE_HEARTBEAT"))
      .mockRejectedValueOnce(new Error("PRIVATE_HEARTBEAT")).mockResolvedValue(true);
    const service = new KnowledgeIngestionCoordinator({ heartbeatMs: 10, maxParallel: 1,
      process: async (_claim, signal) => { workSignal = signal; await gate; },
      repository: { claim: async () => queued.shift() ?? null, heartbeat, reconcile: async () => false,
        retryLater: async () => true, settleFailed: async () => true } });
    const pending = service.reconcileNow();
    try {
      await vi.advanceTimersByTimeAsync(30);
      expect(workSignal?.aborted).toBe(false);
      expect(heartbeat).toHaveBeenCalledTimes(3);
      expect(records()).toHaveLength(4);
      expect(records()).toContainEqual(expect.objectContaining({ event: "job_attempt", job_id: "artifact-1",
        stage: "heartbeat", outcome: "degraded" }));
      expect(records().at(-1)).toMatchObject({ event: "subsystem.recovered", stage: "heartbeat", repeat_count: 1 });
      await vi.advanceTimersByTimeAsync(30);
      expect(records()).toHaveLength(4);
      expect(JSON.stringify(records())).not.toContain("PRIVATE_");
    } finally { release(); await pending; }
  });

  it("does not claim a successful callback confirmed any durable settlement", async () => {
    const records = capture();
    const queued = [claim("void", 1)];
    const service = new KnowledgeIngestionCoordinator({ maxParallel: 1, process: async () => undefined,
      repository: { claim: async () => queued.shift() ?? null, heartbeat: async () => true,
        reconcile: async () => false, retryLater: async () => true, settleFailed: async () => true } });
    await service.reconcileNow();
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ event: "job_attempt", stage: "claim", outcome: "started" });
  });

  it("does not report a healthy parallel claimant as recovery from a continuing claim failure", async () => {
    const records = capture();
    let unavailable = true;
    let calls = 0;
    const service = new KnowledgeIngestionCoordinator({ maxParallel: 2, process: async () => undefined,
      repository: {
        claim: async () => { calls += 1; if (unavailable && calls % 2 === 1) throw new Error("PRIVATE_CLAIM"); return null; },
        heartbeat: async () => true, reconcile: async () => false,
        retryLater: async () => true, settleFailed: async () => true
      }
    });
    for (let pass = 0; pass < 10; pass += 1) await service.reconcileNow();
    expect(records()).toHaveLength(1);
    unavailable = false;
    await service.reconcileNow();
    expect(records()).toHaveLength(2);
    expect(records()[1]).toMatchObject({ event: "subsystem.recovered", stage: "claim", repeat_count: 9 });
  });

  it("keeps idle polls silent and observes bounded claim failures followed by one recovery", async () => {
    const records = capture();
    let unavailable = false;
    const service = new KnowledgeIngestionCoordinator({ maxParallel: 1, process: async () => undefined,
      repository: {
        claim: async () => { if (unavailable) throw new Error("PRIVATE_CLAIM"); return null; },
        heartbeat: async () => true, reconcile: async () => false,
        retryLater: async () => true, settleFailed: async () => true
      }
    });
    for (let pass = 0; pass < 20; pass += 1) await service.reconcileNow();
    expect(records()).toHaveLength(0);
    unavailable = true;
    for (let pass = 0; pass < 20; pass += 1) await service.reconcileNow();
    expect(records()).toHaveLength(1);
    unavailable = false;
    await service.reconcileNow();
    await service.reconcileNow();
    expect(records()).toHaveLength(2);
    expect(records()[1]).toMatchObject({ event: "subsystem.recovered", stage: "claim", repeat_count: 19 });
    expect(records().every((record) => !Object.hasOwn(record, "job_id") && !Object.hasOwn(record, "trace_id"))).toBe(true);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });
});
