import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { MemoryJobClaim } from "../coordinator/types";
import { createPrismaMemoryMaintenanceHandler } from "./handler";
import { memoryMaintenancePlan, MEMORY_MAINTENANCE_POLICY_VERSION } from "./policy";
import type { MemoryMaintenanceProvider } from "./provider";
import type { MemoryMaintenanceRepository } from "./repository";

const plan = memoryMaintenancePlan([]);
const claim = { id: "job", userId: "owner", kind: "SYNTHESIZE_MEMORIES", pipelineVersion: "memory-maintenance-v1",
  chatId: null, sourceMessageId: null, targetFactVersionId: null, activeLeafMessageId: null, branchGeneration: null,
  sourceRevision: null, sourceHash: null, recoveredLease: false } as MemoryJobClaim;
const result = { output: { decisions: [{ sourceRef: "S1", scopeBasis: "transient_update", action: "REMOVE_TRANSIENT", usefulness: null, reason: "transient_episode_update" }] },
  acceptedOutputHash: "a".repeat(64), executionId: "execution", inputHash: "b".repeat(64), modelId: "model", providerId: "provider", policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION };
const context = { now: () => new Date(), setStage: vi.fn(async () => {}), signal: new AbortController().signal };
function setup(options: { staged?: boolean; verified?: boolean; existing?: boolean; client?: unknown } = {}) {
  const repository = { snapshot: vi.fn(async () => plan), stagedReview: vi.fn(async () => options.staged ? result : null),
    stagedVerification: vi.fn(async () => options.verified ? { ...result, output: { decisions: [{ sourceRef: "S1", approve: true }] } } : null),
    bindingExists: vi.fn(async () => options.existing ?? false), apply: vi.fn() };
  const provider = { review: vi.fn(async () => result), verify: vi.fn(async () => ({ ...result, output: { decisions: [{ sourceRef: "S1", approve: true }] } })) };
  const handler = createPrismaMemoryMaintenanceHandler((options.client ?? {}) as PrismaClient, {
    repository: repository as unknown as MemoryMaintenanceRepository, provider: provider as unknown as MemoryMaintenanceProvider
  });
  return { repository, provider, handler };
}
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
  it("never adopts or replays a retained v1 review under the v2 policy", async () => {
    const { handler, repository, provider } = setup({ staged: true });
    repository.stagedReview.mockResolvedValue({ ...result, policyVersion: "memory-maintenance-policy-v1" });
    await expect(handler.execute({ ...claim, recoveredLease: true }, context)).rejects.toThrow("memory_maintenance_policy_stale");
    expect(provider.review).not.toHaveBeenCalled();
    expect(provider.verify).not.toHaveBeenCalled();
    expect(repository.apply).not.toHaveBeenCalled();
  });
});
