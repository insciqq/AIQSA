import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { createTestProviderExecutionAuthority, deleteTestProviderExecutionAuthority } from "@/tests/support/providerExecutionAuthority";
import { prisma } from "../../prisma";
import { createPrismaMemoryExecutionLifecycle } from "../execution/lifecycle";
import { resolveMemoryExecutionCompatibility } from "../execution/compatibility";
import { createMemoryExecutionSnapshot } from "../execution/snapshot";
import type { ResolvedMemoryExecutionTarget } from "../execution/policy";
import { MEMORY_MAINTENANCE_VERSIONS, memoryMaintenanceOrdinal } from "./policy";

afterAll(async () => { await prisma.$disconnect(); });

/** A claimed maintenance job whose RUNNING bindings can settle with receipts. */
async function maintenanceFixture(test: (fixture: Readonly<{
  userId: string;
  jobId: string;
  running: (ordinal: number) => Promise<Readonly<{ id: string }>>;
}>) => Promise<void>): Promise<void> {
  const userId = `maintenance-atomic-${randomUUID()}`;
  const authority = await createTestProviderExecutionAuthority(prisma, "maintenance-atomic");
  try {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, displayName: "Maintenance atomic test", status: "active" } });
    const now = new Date();
    const target: ResolvedMemoryExecutionTarget = {
      authority: { ...authority, connectionVersion: 1, modelVersion: 1 },
      credentialSource: "default", destinationFingerprint: "1".repeat(64), executionTargetFingerprint: "2".repeat(64), policyRevision: 1,
      compatibilityFingerprints: { configFingerprint: "3".repeat(64), deploymentFingerprint: "4".repeat(64),
        modelFingerprint: "5".repeat(64), providerFingerprint: "6".repeat(64) },
      snapshot: { version: 1, connectionId: authority.connectionId, credentialId: authority.credentialId,
        credentialVersionId: authority.credentialVersionId, providerModelId: authority.providerModelId,
        connectionDisplayName: "Atomic provider", modelDisplayName: "Atomic model", providerFamily: "openai_compatible",
        connection: { allowPrivateNetwork: false, apiRoot: "https://provider-authority.example.test/v1", authenticationMode: "bearer", responseTimeoutMs: 30_000 },
        model: { adapterKind: "openai_responses_compatible", answerSelectable: true, modelClass: "answer",
          upstreamModelId: "provider-authority-test-model", defaultParams: {}, capabilities: { nativePdfInput: false,
            nativeSearch: false, pdf: false, reasoning: false, vision: false, structuredOutput: true, toolCalling: true, forcedToolCalling: true } }
      }
    };
    const compatibility = resolveMemoryExecutionCompatibility({ role: "MEMORY_SYNTHESIZE", target, versions: MEMORY_MAINTENANCE_VERSIONS });
    const snapshot = createMemoryExecutionSnapshot({ role: "MEMORY_SYNTHESIZE", target,
      acceptedUtilityEgressFingerprint: "7".repeat(64), compatibilityId: compatibility.compatibilityId,
      compatibilityRequirement: compatibility.requirement, requiresStrictStructuredOutput: true, utilityPolicyVersion: "atomic-test-v1" });
    const job = await prisma.memoryJob.create({ data: { userId, kind: "SYNTHESIZE_MEMORIES",
      pipelineVersion: MEMORY_MAINTENANCE_VERSIONS.pipelineVersion, idempotencyFingerprint: randomUUID(),
      memoryGenerationSnapshot: 0, memoryRevisionSnapshot: 0, state: "CLAIMED", leaseToken: randomUUID(),
      leaseExpiresAt: new Date(now.getTime() + 60_000) } });
    await test({ userId, jobId: job.id, running: (ordinal) => prisma.memoryExecutionBinding.create({ data: { ...authority, userId,
      ownerType: "JOB", memoryJobId: job.id, logicalRole: "MEMORY_SYNTHESIZE", ordinal, state: "RUNNING", createdAt: now, startedAt: now,
      providerId: "openai_compatible", destinationFingerprint: target.destinationFingerprint, inputHash: "a".repeat(64),
      pipelineVersion: MEMORY_MAINTENANCE_VERSIONS.pipelineVersion, policyVersion: MEMORY_MAINTENANCE_VERSIONS.policyVersion,
      promptVersion: MEMORY_MAINTENANCE_VERSIONS.promptVersion, schemaVersion: MEMORY_MAINTENANCE_VERSIONS.schemaVersion,
      secretFreeExecutionSnapshot: snapshot as unknown as Prisma.InputJsonValue }, select: { id: true } }) });
  } finally {
    await prisma.memoryMaintenanceExecution.deleteMany({ where: { userId } });
    await prisma.usageEvent.deleteMany({ where: { userId } });
    await prisma.memoryExecutionBinding.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await deleteTestProviderExecutionAuthority(prisma, authority);
  }
}
const inputHash = "a".repeat(64), acceptedOutputHash = "b".repeat(64);
const settlement = { state: "SUCCEEDED" as const, acceptedOutputHash, errorCode: null, providerResponseId: null,
  usage: { completeness: "COMPLETE" as const, inputTokens: 12, outputTokens: 5, totalTokens: 17,
    cachedInputTokens: 0, reasoningTokens: 0, estimatedCostMicros: null } };

describe("maintenance atomic execution settlement", () => {
  it("commits staged output, RUNNING-to-SUCCEEDED receipt and usage atomically; rejects incomplete or mismatched receipts", async () => {
    await maintenanceFixture(async ({ userId, jobId, running }) => {
      const binding = await running(0);
      const staged = { userId, memoryJobId: jobId, executionBindingId: binding.id, ordinal: 0, inputHash,
        acceptedOutputHash, acceptedOutput: { decisions: [] } };
      await expect(prisma.memoryMaintenanceExecution.create({ data: staged })).rejects.toThrow();
      expect(await prisma.memoryMaintenanceExecution.count({ where: { userId } })).toBe(0);
      const lifecycle = createPrismaMemoryExecutionLifecycle({}, prisma);
      await expect(lifecycle.settleSucceededWithDurableResult(userId, binding.id, settlement, async (tx) => {
        await tx.memoryMaintenanceExecution.create({ data: { ...staged, acceptedOutputHash: "c".repeat(64) } });
      })).rejects.toThrow();
      expect(await prisma.memoryExecutionBinding.findUnique({ where: { id: binding.id } })).toMatchObject({ state: "RUNNING", acceptedOutputHash: null });
      expect(await prisma.usageEvent.count({ where: { userId } })).toBe(0);
      await lifecycle.settleSucceededWithDurableResult(userId, binding.id, settlement, async (tx) => {
        expect(await tx.memoryExecutionBinding.findUnique({ where: { id: binding.id } })).toMatchObject({ state: "RUNNING", acceptedOutputHash: null });
        await tx.memoryMaintenanceExecution.create({ data: staged });
      });
      expect(await prisma.memoryExecutionBinding.findUnique({ where: { id: binding.id } })).toMatchObject({ state: "SUCCEEDED", acceptedOutputHash, totalTokens: 17 });
      expect(await prisma.memoryMaintenanceExecution.findFirst({ where: { userId } })).toMatchObject({ acceptedOutputHash, appliedAt: null });
      expect(await prisma.usageEvent.count({ where: { userId, memoryExecutionBindingId: binding.id } })).toBe(1);
    });
  });
  it("settles a retry attempt's receipt under its own ordinal and never one outside the attempt range", async () => {
    await maintenanceFixture(async ({ userId, jobId, running }) => {
      const lifecycle = createPrismaMemoryExecutionLifecycle({}, prisma);
      const receipt = (bindingId: string, ordinal: number) => async (tx: Prisma.TransactionClient) => {
        await tx.memoryMaintenanceExecution.create({ data: { userId, memoryJobId: jobId, executionBindingId: bindingId, ordinal,
          inputHash, acceptedOutputHash, acceptedOutput: { decisions: [] } } });
      };
      // Reviews use 0, 2, 4 and verifications 1, 3, 5; a seventh attempt has no receipt ordinal.
      const outside = await running(6);
      await expect(lifecycle.settleSucceededWithDurableResult(userId, outside.id, settlement, receipt(outside.id, 6))).rejects.toThrow();
      expect(await prisma.memoryExecutionBinding.findUnique({ where: { id: outside.id } })).toMatchObject({ state: "RUNNING" });
      for (const ordinal of [memoryMaintenanceOrdinal("review", 1), memoryMaintenanceOrdinal("verify", 2)]) {
        const retry = await running(ordinal);
        await lifecycle.settleSucceededWithDurableResult(userId, retry.id, settlement, receipt(retry.id, ordinal));
        expect(await prisma.memoryExecutionBinding.findUnique({ where: { id: retry.id } })).toMatchObject({ state: "SUCCEEDED", ordinal });
      }
      expect((await prisma.memoryMaintenanceExecution.findMany({ where: { userId }, orderBy: { ordinal: "asc" } }))
        .map(({ ordinal }) => ordinal)).toEqual([2, 5]);
      expect(await prisma.usageEvent.count({ where: { userId } })).toBe(2);
    });
  });
});
