import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logEvent } from "../../observability";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type { MemoryJobClaim, MemoryJobHandler } from "../coordinator/types";
import {
  createMemorySynthesizeJobDispatcher,
  reconcileRetiredMemorySynthesis
} from "./retiredSynthesis";

vi.mock("../../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../observability")>(),
  logEvent: vi.fn()
}));

const job = {
  activeLeafMessageId: null, attemptCount: 1, branchGeneration: null, chatId: null, claimToken: "lease",
  id: "job-1", idempotencyFingerprint: "fingerprint", kind: "SYNTHESIZE_MEMORIES",
  leaseExpiresAt: new Date("2026-10-02T10:01:00.000Z"), memoryGenerationSnapshot: 0, memoryRevisionSnapshot: 0,
  pipelineVersion: "memory-maintenance-v1", recoveredLease: false, sourceHash: null, sourceMessageId: null,
  sourceRevision: null, stage: null, targetFactVersionId: null, userId: "owner"
} satisfies MemoryJobClaim;
const context = { now: () => new Date(), setStage: vi.fn(async () => {}), signal: new AbortController().signal };

function maintenance() {
  const preflight = vi.fn(async () => ({ status: "READY" as const }));
  const execute = vi.fn(async () => ({ acceptedResultHash: "a".repeat(64) }));
  return { handler: { kind: "SYNTHESIZE_MEMORIES", preflight, execute } satisfies MemoryJobHandler, preflight, execute };
}

afterEach(() => vi.mocked(logEvent).mockReset());

describe("retired Dream synthesis jobs", () => {
  it("routes only the maintenance pipeline to maintenance", async () => {
    const maintenanceHandler = maintenance();
    const dispatcher = createMemorySynthesizeJobDispatcher(maintenanceHandler.handler);
    expect(dispatcher.kind).toBe("SYNTHESIZE_MEMORIES");
    await expect(dispatcher.preflight(job)).resolves.toEqual({ status: "READY" });
    await expect(dispatcher.execute(job, context)).resolves.toEqual({ acceptedResultHash: "a".repeat(64) });
    // A malformed maintenance job is still maintenance's to reject.
    const malformed = { ...job, chatId: "chat-1" };
    await dispatcher.preflight(malformed);
    expect(maintenanceHandler.preflight).toHaveBeenLastCalledWith(malformed);
  });

  it.each(["memory-synthesis-v2", "memory-synthesis-v1", "unknown-pipeline"])(
    "closes a %s job content-free before any provider work", async (pipelineVersion) => {
      const maintenanceHandler = maintenance();
      const dispatcher = createMemorySynthesizeJobDispatcher(maintenanceHandler.handler);
      const retired = { ...job, pipelineVersion, targetFactVersionId: "pattern-version" };
      await expect(dispatcher.preflight(retired)).resolves.toEqual({
        errorCode: "memory_synthesis_retired", status: "CANCELLED"
      });
      const failure = await dispatcher.execute(retired, context).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MemoryCoordinatorError);
      expect(failure).toMatchObject({ code: "memory_synthesis_retired", retryable: false });
      expect(maintenanceHandler.preflight).not.toHaveBeenCalled();
      expect(maintenanceHandler.execute).not.toHaveBeenCalled();
    });

  it("accepts only a SYNTHESIZE_MEMORIES maintenance handler", () => {
    expect(() => createMemorySynthesizeJobDispatcher({ ...maintenance().handler, kind: "EXTRACT_FACTS" }))
      .toThrow("memory_maintenance_handler_invalid");
  });
});

describe("retired Dream synthesis reconciliation", () => {
  function client(input: Readonly<{
    closeJobs: () => Promise<number>;
    scrub: () => Promise<number>;
    owners: readonly string[];
    lockRows: () => Promise<unknown[]>;
  }>) {
    const executeRaw = vi.fn()
      .mockImplementationOnce(input.closeJobs)
      .mockImplementationOnce(input.scrub);
    const transaction = vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({ $queryRaw: vi.fn(input.lockRows) }));
    return {
      prisma: {
        $executeRaw: executeRaw,
        $queryRaw: vi.fn(async () => input.owners.map((userId) => ({ userId }))),
        $transaction: transaction
      } as unknown as PrismaClient,
      executeRaw,
      transaction
    };
  }

  it("skips an owner that stopped being active and reports content-free counts", async () => {
    const fake = client({
      closeJobs: async () => 2, scrub: async () => 1, owners: ["owner-a"], lockRows: async () => []
    });
    await expect(reconcileRetiredMemorySynthesis(fake.prisma, new Date())).resolves.toEqual({
      closedJobs: 2, forgottenFacts: 0, pinnedFacts: 0, scrubbedExecutions: 1
    });
    expect(fake.transaction).toHaveBeenCalledOnce();
    expect(logEvent).toHaveBeenCalledOnce();
    expect(logEvent).toHaveBeenCalledWith("runtime_lifecycle", {
      subsystem: "memory", stage: "reconcile", outcome: "cancelled", code: "memory_synthesis_retired", count: 2
    });
  });

  it("runs every part before rethrowing the first failure", async () => {
    const jobsFailure = new Error("jobs_failed");
    const fake = client({
      closeJobs: async () => { throw jobsFailure; },
      scrub: async () => 3,
      owners: ["owner-a", "owner-b"],
      lockRows: async () => { throw new Error("owner_failed"); }
    });
    await expect(reconcileRetiredMemorySynthesis(fake.prisma, new Date())).rejects.toBe(jobsFailure);
    expect(fake.executeRaw).toHaveBeenCalledTimes(2);
    expect(fake.transaction).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid clock before any write", async () => {
    const fake = client({ closeJobs: async () => 0, scrub: async () => 0, owners: [], lockRows: async () => [] });
    await expect(reconcileRetiredMemorySynthesis(fake.prisma, new Date(Number.NaN)))
      .rejects.toThrow("memory_synthesis_retirement_clock_invalid");
    expect(fake.executeRaw).not.toHaveBeenCalled();
  });
});
