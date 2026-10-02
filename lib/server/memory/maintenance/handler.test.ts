import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { MemoryJobClaim } from "../coordinator/types";
import { createPrismaMemoryMaintenanceHandler } from "./handler";
import { memoryMaintenancePlanHash, MEMORY_MAINTENANCE_POLICY_VERSION, type MemoryMaintenanceSource } from "./policy";
import type { MemoryMaintenanceProvider } from "./provider";
import type { MemoryMaintenanceRepository, MemoryMaintenanceSnapshot } from "./repository";

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
function setup(options: { staged?: boolean; verified?: boolean; existing?: boolean | ((ordinal: number) => boolean);
  client?: unknown; snapshots?: readonly MemoryMaintenanceSnapshot[] } = {}) {
  const snapshots = [...(options.snapshots ?? [snapshotOf()])];
  const repository = { snapshot: vi.fn(async () => snapshots.length > 1 ? snapshots.shift()! : snapshots[0]!),
    stagedReview: vi.fn(async () => options.staged ? result : null),
    stagedVerification: vi.fn(async () => options.verified ? approvals : null),
    bindingExists: vi.fn(async (_job: unknown, ordinal: number) =>
      typeof options.existing === "function" ? options.existing(ordinal) : options.existing ?? false), apply: vi.fn() };
  const provider = { review: vi.fn(async () => result), verify: vi.fn(async () => approvals) };
  const handler = createPrismaMemoryMaintenanceHandler((options.client ?? {}) as PrismaClient, {
    repository: repository as unknown as MemoryMaintenanceRepository, provider: provider as unknown as MemoryMaintenanceProvider
  });
  return { repository, provider, handler };
}
const enabled = (generation = 0) => ({ userMemorySettings: { findUnique: vi.fn(async () => ({
  useMemoryFacts: true, learnAutomatically: true, memoryGeneration: generation, memoryRevision: 0 })) } });

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
    const { handler, provider } = setup({ staged: true, verified: true, existing: true });
    const completed = await handler.execute({ ...claim, recoveredLease: true }, context);
    expect(completed.stage).toBe("maintenance_authorized_apply");
    expect(provider.review).not.toHaveBeenCalled();
    expect(provider.verify).not.toHaveBeenCalled();
  });
  it("never replays a dispatched review or verifier without its settled output", async () => {
    for (const staged of [false, true]) {
      const { handler, provider } = setup({ staged, existing: true });
      await expect(handler.execute({ ...claim, recoveredLease: true }, context)).rejects.toThrow("memory_maintenance_outcome_unknown");
      expect(provider.review).not.toHaveBeenCalled();
      expect(provider.verify).not.toHaveBeenCalled();
    }
  });
  it("can finish the never-admitted verification after safely recovering the settled review", async () => {
    const { handler, provider } = setup({ staged: true });
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

describe("maintenance staleness after the paid review", () => {
  it("keeps the job past the staleness gate once a review was dispatched, even if a source changed since", async () => {
    const { handler } = setup({ client: enabled(), existing: (ordinal) => ordinal === 0, snapshots: [snapshotOf(["S1"])] });
    // This unit fixture has no execution authority: reaching that probe
    // proves the changed source did not stale the already paid plan.
    await expect(handler.preflight({ ...claim, memoryGenerationSnapshot: 0 }))
      .resolves.toEqual({ status: "WAITING_FOR_CONFIGURATION", errorCode: "memory_maintenance_authority_unavailable" });
    const fenced = setup({ client: enabled(1), existing: true, snapshots: [snapshotOf(["S1"])] });
    await expect(fenced.handler.preflight({ ...claim, memoryGenerationSnapshot: 0 }))
      .resolves.toEqual({ status: "STALE", errorCode: "memory_maintenance_source_stale" });
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
