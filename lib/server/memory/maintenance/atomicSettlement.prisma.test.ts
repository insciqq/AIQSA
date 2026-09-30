import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { createTestProviderExecutionAuthority, deleteTestProviderExecutionAuthority } from "@/tests/support/providerExecutionAuthority";
import { prisma } from "../../prisma";
import { createPrismaMemoryExecutionLifecycle } from "../execution/lifecycle";
import { resolveMemoryExecutionCompatibility } from "../execution/compatibility";
import { createMemoryExecutionSnapshot } from "../execution/snapshot";
import type { ResolvedMemoryExecutionTarget } from "../execution/policy";
import { MEMORY_MAINTENANCE_VERSIONS } from "./policy";

afterAll(async () => { await prisma.$disconnect(); });

describe("maintenance atomic execution settlement", () => {
  it("commits staged output, RUNNING-to-SUCCEEDED receipt and usage atomically; rejects incomplete or mismatched receipts", async () => {
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
      const inputHash = "a".repeat(64), acceptedOutputHash = "b".repeat(64);
      const binding = await prisma.memoryExecutionBinding.create({ data: { ...authority, userId, ownerType: "JOB", memoryJobId: job.id,
        logicalRole: "MEMORY_SYNTHESIZE", ordinal: 0, state: "RUNNING", createdAt: now, startedAt: now,
        providerId: "openai_compatible", destinationFingerprint: target.destinationFingerprint, inputHash,
        pipelineVersion: MEMORY_MAINTENANCE_VERSIONS.pipelineVersion, policyVersion: MEMORY_MAINTENANCE_VERSIONS.policyVersion,
        promptVersion: MEMORY_MAINTENANCE_VERSIONS.promptVersion, schemaVersion: MEMORY_MAINTENANCE_VERSIONS.schemaVersion,
        secretFreeExecutionSnapshot: snapshot as unknown as Prisma.InputJsonValue } });
      const staged = { userId, memoryJobId: job.id, executionBindingId: binding.id, ordinal: 0, inputHash,
        acceptedOutputHash, acceptedOutput: { decisions: [] } };
      await expect(prisma.memoryMaintenanceExecution.create({ data: staged })).rejects.toThrow();
      expect(await prisma.memoryMaintenanceExecution.count({ where: { userId } })).toBe(0);
      const lifecycle = createPrismaMemoryExecutionLifecycle({}, prisma);
      const settlement = { state: "SUCCEEDED" as const, acceptedOutputHash, errorCode: null, providerResponseId: null,
        usage: { completeness: "COMPLETE" as const, inputTokens: 12, outputTokens: 5, totalTokens: 17,
          cachedInputTokens: 0, reasoningTokens: 0, estimatedCostMicros: null } };
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
    } finally {
      await prisma.memoryMaintenanceExecution.deleteMany({ where: { userId } });
      await prisma.usageEvent.deleteMany({ where: { userId } });
      await prisma.memoryExecutionBinding.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await deleteTestProviderExecutionAuthority(prisma, authority);
    }
  });
});
