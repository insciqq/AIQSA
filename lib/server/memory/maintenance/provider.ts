import { Prisma, type PrismaClient } from "@prisma/client";
import { executeGovernedMemoryStructuredOutput, type MemoryExecutionAuthorityDependencies,
  type MemoryStructuredOutputProvider } from "../execution";
import { memoryExecutionSha256 } from "../execution/canonical";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import { createAcceptedMemoryStructuredOutputProvider } from "../execution/structuredClassifier";
import { buildMemoryMaintenanceRequest, buildMemoryMaintenanceVerificationRequest,
  decodeMemoryMaintenanceOutput, decodeMemoryMaintenanceVerification,
  type MemoryMaintenanceOutput, type MemoryMaintenanceVerification } from "./contract";
import { MEMORY_MAINTENANCE_VERSIONS, type MemoryMaintenancePlan } from "./policy";
import { loadMemoryMaintenanceSources } from "./source";

export type MemoryMaintenanceResult<T> = Readonly<{
  acceptedOutputHash: string; executionId: string; inputHash: string;
  modelId: string; output: T; policyVersion: string; providerId: string;
}>;
export type MemoryMaintenanceReviewResult = MemoryMaintenanceResult<MemoryMaintenanceOutput>;
export type MemoryMaintenanceVerificationResult = MemoryMaintenanceResult<MemoryMaintenanceVerification>;
type Owner = Readonly<{ jobId: string; userId: string }>;
export function memoryMaintenanceInputHash(plan: MemoryMaintenancePlan, review?: MemoryMaintenanceOutput): string {
  return memoryExecutionSha256({ versions: MEMORY_MAINTENANCE_VERSIONS, sourceSnapshotHash: plan.sourceSnapshotHash,
    stage: review ? "VERIFY" : "REVIEW", ...(review ? { review } : {}) });
}
export function memoryMaintenanceOutputHash(inputHash: string, output: unknown): string {
  return memoryExecutionSha256({ inputHash, output, role: "MEMORY_SYNTHESIZE", version: 1 });
}
export function createPrismaMemoryMaintenanceProvider(client: PrismaClient, options: Readonly<{
  authority?: MemoryExecutionAuthorityDependencies; provider?: MemoryStructuredOutputProvider;
}> = {}) {
  const authority = options.authority ?? defaultMemoryExecutionAuthority;
  const provider = options.provider ?? createAcceptedMemoryStructuredOutputProvider(client);
  async function run<T>(owner: Owner, plan: MemoryMaintenancePlan, signal: AbortSignal, ordinal: number, inputHash: string,
    request: ReturnType<typeof buildMemoryMaintenanceRequest>, decode: (value: unknown) => T): Promise<MemoryMaintenanceResult<T>> {
    const result = await executeGovernedMemoryStructuredOutput({
      authority, client, decode, inputHash, ordinal, owner: { memoryJobId: owner.jobId, type: "JOB" },
      provider: { async run(snapshot, request, signal) {
        const current = await loadMemoryMaintenanceSources(client, owner.userId, {
          versionIds: plan.sources.map(({ versionId }) => versionId), now: new Date()
        });
        if (current?.sourceSnapshotHash !== plan.sourceSnapshotHash) throw new Error("memory_maintenance_source_stale");
        return provider.run(snapshot, request, signal);
      } }, request,
      role: "MEMORY_SYNTHESIZE", signal, userId: owner.userId, versions: MEMORY_MAINTENANCE_VERSIONS,
      persistResult: async (tx, durable) => {
        await tx.memoryMaintenanceExecution.create({ data: {
          userId: owner.userId, memoryJobId: owner.jobId, executionBindingId: durable.bindingId,
          ordinal, inputHash, acceptedOutputHash: durable.acceptedOutputHash,
          acceptedOutput: durable.value as unknown as Prisma.InputJsonValue
        } });
      }
    });
    return { acceptedOutputHash: result.acceptedOutputHash, executionId: result.bindingId, inputHash: result.inputHash,
      modelId: result.modelId, output: result.value, policyVersion: result.policyVersion, providerId: result.providerId };
  }
  return Object.freeze({
    review(plan: MemoryMaintenancePlan, signal: AbortSignal, owner: Owner) {
      return run(owner, plan, signal, 0, memoryMaintenanceInputHash(plan), buildMemoryMaintenanceRequest(plan),
        (value) => decodeMemoryMaintenanceOutput(value, plan));
    },
    verify(plan: MemoryMaintenancePlan, review: MemoryMaintenanceOutput, signal: AbortSignal, owner: Owner) {
      return run(owner, plan, signal, 1, memoryMaintenanceInputHash(plan, review), buildMemoryMaintenanceVerificationRequest(plan, review),
        (value) => decodeMemoryMaintenanceVerification(value, review));
    }
  });
}
export type MemoryMaintenanceProvider = ReturnType<typeof createPrismaMemoryMaintenanceProvider>;
