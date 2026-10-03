import { Prisma, type PrismaClient } from "@prisma/client";
import { MemoryJobFencedError } from "../coordinator/errors";
import { executeGovernedMemoryStructuredOutput, type MemoryExecutionAuthorityDependencies,
  type MemoryStructuredOutputProvider } from "../execution";
import { memoryExecutionSha256 } from "../execution/canonical";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import { createAcceptedMemoryStructuredOutputProvider } from "../execution/structuredClassifier";
import { buildMemoryMaintenanceRequest, buildMemoryMaintenanceVerificationRequest,
  decodeMemoryMaintenanceOutput, decodeMemoryMaintenanceVerification,
  type MemoryMaintenanceOutput, type MemoryMaintenanceVerification } from "./contract";
import { MEMORY_MAINTENANCE_FAILURE_CODES, MEMORY_MAINTENANCE_VERSIONS, memoryMaintenanceOrdinal, type MemoryMaintenanceCall,
  type MemoryMaintenancePlan, type MemoryMaintenanceSource } from "./policy";
import { loadMemoryMaintenanceSources } from "./source";

export type MemoryMaintenanceResult<T> = Readonly<{
  acceptedOutputHash: string; executionId: string; inputHash: string;
  modelId: string; output: T; policyVersion: string; providerId: string;
}>;
export type MemoryMaintenanceReviewResult = MemoryMaintenanceResult<MemoryMaintenanceOutput>;
export type MemoryMaintenanceVerificationResult = MemoryMaintenanceResult<MemoryMaintenanceVerification>;
type Owner = Readonly<{ jobId: string; userId: string }>;
/** Identity of a call: the reviewed source set and, for the verifier, the
 * exact removals disclosed to it. */
export function memoryMaintenanceInputHash(reviewed: Readonly<{ sourceSnapshotHash: string }>, proposal?: MemoryMaintenanceOutput): string {
  return memoryExecutionSha256({ versions: MEMORY_MAINTENANCE_VERSIONS, sourceSnapshotHash: reviewed.sourceSnapshotHash,
    stage: proposal ? "VERIFY" : "REVIEW", ...(proposal ? { review: proposal } : {}) });
}
export function memoryMaintenanceOutputHash(inputHash: string, output: unknown): string {
  return memoryExecutionSha256({ inputHash, output, role: "MEMORY_SYNTHESIZE", version: 1 });
}
export function createPrismaMemoryMaintenanceProvider(client: PrismaClient, options: Readonly<{
  authority?: MemoryExecutionAuthorityDependencies; provider?: MemoryStructuredOutputProvider;
}> = {}) {
  const authority = options.authority ?? defaultMemoryExecutionAuthority;
  const provider = options.provider ?? createAcceptedMemoryStructuredOutputProvider(client);
  async function assertDisclosedCurrent(userId: string, disclosed: readonly MemoryMaintenanceSource[]): Promise<void> {
    const current = await loadMemoryMaintenanceSources(client, userId, {
      versionIds: disclosed.map(({ versionId }) => versionId), now: new Date()
    });
    if (disclosed.some((source) => current.sources.get(source.versionId)?.sourceSnapshotHash !== source.sourceSnapshotHash)) {
      // The re-run gate decides STALE or keeps this terminal after a paid review;
      // the proven fence settles STALE only when that gate cannot decide.
      const code = MEMORY_MAINTENANCE_FAILURE_CODES.dispatchStale;
      throw new MemoryJobFencedError(code, { errorCode: code, status: "STALE" });
    }
  }
  /** Revalidates every disclosed source before any binding exists, so a
   * changed one costs no binding or paid call, and again just before dispatch. */
  async function run<T>(owner: Owner, call: MemoryMaintenanceCall, disclosed: readonly MemoryMaintenanceSource[], signal: AbortSignal,
    inputHash: string, request: ReturnType<typeof buildMemoryMaintenanceRequest>, decode: (value: unknown) => T): Promise<MemoryMaintenanceResult<T>> {
    await assertDisclosedCurrent(owner.userId, disclosed);
    const result = await executeGovernedMemoryStructuredOutput({
      authority, client, decode, inputHash, ordinal: memoryMaintenanceOrdinal(call, 0), owner: { memoryJobId: owner.jobId, type: "JOB" },
      provider: { async run(snapshot, request, signal) {
        await assertDisclosedCurrent(owner.userId, disclosed);
        return provider.run(snapshot, request, signal);
      } }, request,
      role: "MEMORY_SYNTHESIZE", signal, userId: owner.userId, versions: MEMORY_MAINTENANCE_VERSIONS,
      persistResult: async (tx, durable) => {
        // The receipt carries the ordinal of the attempt that succeeded.
        const { ordinal } = await tx.memoryExecutionBinding.findFirstOrThrow({ where: { userId: owner.userId, id: durable.bindingId },
          select: { ordinal: true } });
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
      return run(owner, "review", plan.sources, signal, memoryMaintenanceInputHash(plan), buildMemoryMaintenanceRequest(plan),
        (value) => decodeMemoryMaintenanceOutput(value, plan));
    },
    /** `disclosed` holds the still-matching removal sources of `proposal`. */
    verify(reviewed: Readonly<{ sourceSnapshotHash: string }>, disclosed: readonly MemoryMaintenanceSource[],
      proposal: MemoryMaintenanceOutput, signal: AbortSignal, owner: Owner) {
      const plan: MemoryMaintenancePlan = { sources: disclosed, sourceSnapshotHash: reviewed.sourceSnapshotHash };
      return run(owner, "verify", disclosed, signal, memoryMaintenanceInputHash(reviewed, proposal),
        buildMemoryMaintenanceVerificationRequest(plan, proposal), (value) => decodeMemoryMaintenanceVerification(value, proposal));
    }
  });
}
export type MemoryMaintenanceProvider = ReturnType<typeof createPrismaMemoryMaintenanceProvider>;
