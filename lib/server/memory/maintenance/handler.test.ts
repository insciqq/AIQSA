import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { databaseFailureCode } from "../../observability/databaseFailure";
import { StructuredOutputDecodeError } from "../../providers/structuredOutput";
import { MemoryJobFencedError } from "../coordinator/errors";
import type { MemoryJobClaim } from "../coordinator/types";
import { MemoryExecutionError, MemoryStructuredOutputProviderError } from "../execution";
import { createPrismaMemoryMaintenanceHandler } from "./handler";
import { memoryMaintenancePlanHash, MEMORY_MAINTENANCE_POLICY_VERSION, type MemoryMaintenanceCall,
  type MemoryMaintenanceSource } from "./policy";
import type { MemoryMaintenanceProvider } from "./provider";
import type { MemoryMaintenanceCallState, MemoryMaintenanceRepository, MemoryMaintenanceSnapshot } from "./repository";

function source(ref: string): MemoryMaintenanceSource {
  return { ref, factId: `fact-${ref}`, versionId: `version-${ref}`, statement: `Synthetic ${ref}.`, category: "other",
    modality: "STATE", confidence: 0.6, usefulness: null, observedAt: new Date("2026-09-01"), evidence: [],
    evidenceThrough: new Date("2026-09-01"), sourceSnapshotHash: ref === "S1" ? "1".repeat(64) : "2".repeat(64) };
}
/** The job's reviewed sources; `changed` refs no longer match their hash. */
function snapshotOf(changed: readonly string[] = []): MemoryMaintenanceSnapshot {
  const sources = [source("S1"), source("S2")].map((item) => ({ ref: item.ref, versionId: item.versionId,
    sourceSnapshotHash: item.sourceSnapshotHash, reviewId: `review-${item.ref}`,
    current: changed.includes(item.ref) ? null : item, blockedReason: changed.includes(item.ref) ? "source_changed" as const : null }));
  const sourceSnapshotHash = memoryMaintenancePlanHash(sources);
  return { sourceSnapshotHash, sources,
    plan: changed.length ? null : { sources: sources.map(({ current }) => current!), sourceSnapshotHash } };
}
const claim = { id: "job", userId: "owner", kind: "SYNTHESIZE_MEMORIES", pipelineVersion: "memory-maintenance-v1",
  chatId: null, sourceMessageId: null, targetFactVersionId: null, activeLeafMessageId: null, branchGeneration: null,
  sourceRevision: null, sourceHash: null, recoveredLease: false } as MemoryJobClaim;
const decision = (sourceRef: string) => ({ sourceRef, scopeBasis: "single_episode", action: "REMOVE_TRANSIENT", usefulness: null, reason: "episode" });
const result = { output: { decisions: [decision("S1"), decision("S2")] },
  acceptedOutputHash: "a".repeat(64), executionId: "execution", inputHash: "b".repeat(64), modelId: "model", providerId: "provider", policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION };
const approvals = { ...result, output: { decisions: [{ sourceRef: "S1", approve: true }, { sourceRef: "S2", approve: true }] } };
const context = { now: () => new Date(), setStage: vi.fn(async () => {}), signal: new AbortController().signal };
const unknown = { status: "UNKNOWN", ambiguous: true } as const;
const consumed = (errorCode: string) => ({ status: "CONSUMED", errorCode }) as const;
function setup(options: { staged?: boolean; verified?: boolean; calls?: Partial<Record<MemoryMaintenanceCall, MemoryMaintenanceCallState>>;
  client?: unknown; snapshots?: readonly MemoryMaintenanceSnapshot[] } = {}) {
  const snapshots = [...(options.snapshots ?? [snapshotOf()])];
  /** Durable call states; a failing fake provider settles its own here. */
  const calls: Partial<Record<MemoryMaintenanceCall, MemoryMaintenanceCallState>> = { ...options.calls };
  const repository = { snapshot: vi.fn(async () => snapshots.length > 1 ? snapshots.shift()! : snapshots[0]!),
    stagedReview: vi.fn(async () => options.staged ? result : null),
    stagedVerification: vi.fn(async () => options.verified ? approvals : null),
    callState: vi.fn(async (_job: unknown, call: MemoryMaintenanceCall): Promise<MemoryMaintenanceCallState> =>
      calls[call] ?? { status: "UNUSED" }), apply: vi.fn() };
  const provider = { review: vi.fn(async () => result), verify: vi.fn(async () => approvals) };
  const handler = createPrismaMemoryMaintenanceHandler((options.client ?? {}) as PrismaClient, {
    repository: repository as unknown as MemoryMaintenanceRepository, provider: provider as unknown as MemoryMaintenanceProvider
  });
  return { repository, provider, handler, calls };
}
const enabled = (generation = 0) => ({ userMemorySettings: { findUnique: vi.fn(async () => ({
  useMemoryFacts: true, learnAutomatically: true, memoryGeneration: generation, memoryRevision: 0 })) } });
const failure = (code: string) => expect.objectContaining({ name: "MemoryCoordinatorError", code, retryable: false });
const dispatchStale = expect.objectContaining({ name: "MemoryJobFencedError", code: "memory_maintenance_dispatch_stale",
  retryable: false, decision: { errorCode: "memory_maintenance_dispatch_stale", status: "STALE" } });

describe("maintenance gate", () => {
  it("follows Memory and automatic learning without reading the retired Dream setting", async () => {
    const findUnique = vi.fn(async () => ({ useMemoryFacts: true, learnAutomatically: false, memoryGeneration: 1, memoryRevision: 0 }));
    const { handler } = setup({ client: { userMemorySettings: { findUnique } } });
    const job = { ...claim, memoryGenerationSnapshot: 0 };
    await expect(handler.preflight(job)).resolves.toEqual({ status: "CANCELLED", errorCode: "memory_maintenance_disabled" });
    expect(findUnique).toHaveBeenCalledWith({ where: { userId: "owner" },
      select: { useMemoryFacts: true, learnAutomatically: true, memoryGeneration: true, memoryRevision: true } });
    findUnique.mockResolvedValue({ useMemoryFacts: true, learnAutomatically: true, memoryGeneration: 1, memoryRevision: 0 });
    // Past the settings gate, a changed generation still stales the job.
    await expect(handler.preflight(job)).resolves.toEqual({ status: "STALE", errorCode: "memory_maintenance_source_stale" });
  });
  it("stales the whole plan before any paid review when one source changed", async () => {
    const { handler, provider, repository } = setup({ client: enabled(), snapshots: [snapshotOf(["S2"])] });
    const job = { ...claim, memoryGenerationSnapshot: 0 };
    await expect(handler.preflight(job)).resolves.toEqual({ status: "STALE", errorCode: "memory_maintenance_source_stale" });
    await expect(handler.execute(job, context)).rejects.toThrow("memory_maintenance_source_stale");
    expect(provider.review).not.toHaveBeenCalled();
    expect(repository.apply).not.toHaveBeenCalled();
  });
});

describe("maintenance recovery", () => {
  it("consumes durably settled review and verification after a lost lease without another paid call", async () => {
    const { handler, provider, repository } = setup({ staged: true, verified: true,
      calls: { review: { status: "SUCCEEDED" }, verify: { status: "SUCCEEDED" } } });
    const completed = await handler.execute({ ...claim, recoveredLease: true }, context);
    expect(completed.stage).toBe("maintenance_authorized_apply");
    expect(provider.review).not.toHaveBeenCalled();
    expect(provider.verify).not.toHaveBeenCalled();
    expect(repository.callState).not.toHaveBeenCalled();
  });
  it("never replays a dispatched review or verifier without its settled output", async () => {
    for (const staged of [false, true]) {
      const { handler, provider, repository } = setup({ staged, calls: { review: unknown, verify: unknown } });
      await expect(handler.execute({ ...claim, recoveredLease: true }, context)).rejects.toThrow(failure("memory_maintenance_outcome_unknown"));
      expect(repository.callState).toHaveBeenCalledWith(expect.anything(), staged ? "verify" : "review");
      expect(provider.review).not.toHaveBeenCalled();
      expect(provider.verify).not.toHaveBeenCalled();
    }
  });
  it("ends with the cause of a consumed attempt instead of an unknown outcome, without another paid call", async () => {
    for (const staged of [false, true]) {
      const { handler, provider } = setup({ staged, calls: { review: consumed("memory_classifier_output_invalid"),
        verify: consumed("memory_classifier_cancelled") } });
      await expect(handler.execute({ ...claim, recoveredLease: true }, context))
        .rejects.toThrow(failure(staged ? "memory_classifier_cancelled" : "memory_classifier_output_invalid"));
      expect(provider.review).not.toHaveBeenCalled();
      expect(provider.verify).not.toHaveBeenCalled();
    }
  });
  it("ends a re-claimed call fenced before dispatch as staleness before dispatch, never a replay or unknown outcome", async () => {
    for (const staged of [false, true]) {
      const { handler, provider } = setup({ staged, calls: { review: consumed("memory_classifier_dispatch_fenced"),
        verify: consumed("memory_classifier_dispatch_fenced") } });
      await expect(handler.execute({ ...claim, recoveredLease: true }, context)).rejects.toThrow(dispatchStale);
      expect(provider.review).not.toHaveBeenCalled();
      expect(provider.verify).not.toHaveBeenCalled();
    }
  });
  it("can finish the never-admitted verification after safely recovering the settled review", async () => {
    const { handler, provider } = setup({ staged: true, calls: { review: { status: "SUCCEEDED" } } });
    await handler.execute({ ...claim, recoveredLease: true }, context);
    expect(provider.review).not.toHaveBeenCalled();
    expect(provider.verify).toHaveBeenCalledTimes(1);
  });
  it("can recover a lost lease before any execution was admitted", async () => {
    const { handler, provider } = setup();
    await handler.execute({ ...claim, recoveredLease: true }, context);
    expect(provider.review).toHaveBeenCalledTimes(1);
    expect(provider.verify).toHaveBeenCalledTimes(1);
  });
  it("never adopts or replays a retained v2 review under the v3 policy", async () => {
    const { handler, repository, provider } = setup({ staged: true });
    repository.stagedReview.mockResolvedValue({ ...result, policyVersion: "memory-maintenance-policy-v2" });
    await expect(handler.execute({ ...claim, recoveredLease: true }, context)).rejects.toThrow("memory_maintenance_policy_stale");
    expect(provider.review).not.toHaveBeenCalled();
    expect(provider.verify).not.toHaveBeenCalled();
    expect(repository.apply).not.toHaveBeenCalled();
  });
});

describe("maintenance failure causes", () => {
  it("ends a failed review or verification with its settled binding's stable cause, never memory_job_failed", async () => {
    for (const [call, code] of [["review", "memory_classifier_output_invalid"], ["verify", "memory_classifier_provider_unavailable"]] as const) {
      const { handler, provider, calls } = setup();
      provider[call].mockImplementation(async () => {
        calls[call] = consumed(code);
        throw new Error("memory_maintenance_output_invalid");
      });
      await expect(handler.execute(claim, context)).rejects.toThrow(failure(code));
      expect(provider.verify).toHaveBeenCalledTimes(call === "verify" ? 1 : 0);
    }
  });
  it("ends a call whose last attempt was fenced before dispatch as staleness before dispatch", async () => {
    const { handler, provider, calls } = setup();
    provider.review.mockImplementation(async () => {
      calls.review = consumed("memory_classifier_dispatch_fenced");
      throw new Error("synthetic_fenced_dispatch");
    });
    await expect(handler.execute(claim, context)).rejects.toThrow(dispatchStale);
  });
  it("keeps a dispatch without a settled outcome unknown", async () => {
    const { handler, provider, calls } = setup();
    provider.review.mockImplementation(async () => {
      calls.review = unknown;
      throw new Error("synthetic_settlement_failure");
    });
    await expect(handler.execute(claim, context)).rejects.toThrow(failure("memory_maintenance_outcome_unknown"));
  });
  it("maps a call whose binding never settled like the structured executor", async () => {
    const limit = Object.assign(new Error("synthetic"), { code: "structured_output_output_limit_exceeded" });
    for (const [error, code] of [
      [new MemoryExecutionError("memory_execution_policy_drift"), "memory_execution_policy_drift"],
      [new MemoryStructuredOutputProviderError(null, null, { cause: new StructuredOutputDecodeError("invalid_json") }), "memory_classifier_output_invalid"],
      [new MemoryStructuredOutputProviderError(null, null, { cause: limit }), "memory_classifier_output_limit_exceeded"],
      [new Error("synthetic_transport_failure"), "memory_classifier_provider_unavailable"]
    ] as const) {
      for (const state of [{ status: "UNUSED" }, { status: "UNKNOWN", ambiguous: false }] as const) {
        const { handler, provider, calls } = setup();
        provider.review.mockImplementation(async () => {
          calls.review = state;
          throw error;
        });
        await expect(handler.execute(claim, context)).rejects.toThrow(failure(code));
      }
    }
  });
  it("rethrows aborts and coordinator errors, including a source changed before dispatch, unchanged", async () => {
    const stale = new MemoryJobFencedError("memory_maintenance_dispatch_stale",
      { errorCode: "memory_maintenance_dispatch_stale", status: "STALE" });
    const { handler, provider, repository } = setup();
    provider.review.mockRejectedValue(stale);
    await expect(handler.execute(claim, context)).rejects.toBe(stale);
    expect(repository.callState).toHaveBeenCalledTimes(1);
    const aborted = new AbortController();
    aborted.abort();
    const cancelled = new Error("synthetic_abort");
    const second = setup();
    second.provider.review.mockRejectedValue(cancelled);
    await expect(second.handler.execute(claim, { ...context, signal: aborted.signal })).rejects.toBe(cancelled);
  });
  it("records a stable code with its database cause for an unexpected failure outside the calls", async () => {
    const { handler, repository, provider } = setup();
    repository.snapshot.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("synthetic", { code: "P1001", clientVersion: "test" }));
    const thrown = await handler.execute(claim, context).catch((error: unknown) => error);
    expect(thrown).toEqual(failure("memory_maintenance_failed"));
    expect(databaseFailureCode(thrown)).toBe("P1001");
    expect(provider.review).not.toHaveBeenCalled();
  });
});

describe("maintenance staleness after the paid review", () => {
  it("keeps the job past the staleness gate once a review succeeded, even if a source changed since", async () => {
    const { handler } = setup({ client: enabled(), calls: { review: { status: "SUCCEEDED" } }, snapshots: [snapshotOf(["S1"])] });
    // This unit fixture has no execution authority: reaching that probe
    // proves the changed source did not stale the already paid plan.
    await expect(handler.preflight({ ...claim, memoryGenerationSnapshot: 0 }))
      .resolves.toEqual({ status: "WAITING_FOR_CONFIGURATION", errorCode: "memory_maintenance_authority_unavailable" });
    const fenced = setup({ client: enabled(1), calls: { review: { status: "SUCCEEDED" } }, snapshots: [snapshotOf(["S1"])] });
    await expect(fenced.handler.preflight({ ...claim, memoryGenerationSnapshot: 0 }))
      .resolves.toEqual({ status: "STALE", errorCode: "memory_maintenance_source_stale" });
  });
  it("stales a changed plan whose review failed, was cancelled or has an unknown outcome", async () => {
    for (const review of [consumed("memory_classifier_output_invalid"), consumed("memory_classifier_cancelled"), unknown,
      { status: "UNKNOWN", ambiguous: false } as const]) {
      const { handler } = setup({ client: enabled(), calls: { review }, snapshots: [snapshotOf(["S1"])] });
      await expect(handler.preflight({ ...claim, memoryGenerationSnapshot: 0 }))
        .resolves.toEqual({ status: "STALE", errorCode: "memory_maintenance_source_stale" });
    }
  });
  it("discloses to the verifier only removals whose source still matches", async () => {
    const { handler, provider, repository } = setup({ snapshots: [snapshotOf(), snapshotOf(["S2"])] });
    const completed = await handler.execute(claim, context);
    expect(provider.review).toHaveBeenCalledTimes(1);
    expect(provider.verify).toHaveBeenCalledTimes(1);
    const [reviewed, disclosed, proposal] = provider.verify.mock.calls[0] as unknown as [
      { sourceSnapshotHash: string }, MemoryMaintenanceSource[], { decisions: Array<{ sourceRef: string }> }];
    expect(reviewed.sourceSnapshotHash).toBe(snapshotOf().sourceSnapshotHash);
    expect(disclosed.map(({ ref }) => ref)).toEqual(["S1"]);
    expect(proposal.decisions.map(({ sourceRef }) => sourceRef)).toEqual(["S1"]);
    expect(completed.stage).toBe("maintenance_authorized_apply");
    expect(repository.apply).not.toHaveBeenCalled();
  });
  it("settles without a verifier call when every proposed removal changed after the review", async () => {
    const { handler, provider } = setup({ snapshots: [snapshotOf(), snapshotOf(["S1", "S2"])] });
    const completed = await handler.execute(claim, context);
    expect(provider.verify).not.toHaveBeenCalled();
    expect(completed.stage).toBe("maintenance_authorized_apply");
  });
});
