import { Prisma, type PrismaClient } from "@prisma/client";
import { logEvent } from "../../observability";
import { MemoryJobFencedError } from "../coordinator/errors";
import { executeGovernedMemoryStructuredOutput, MEMORY_STRUCTURED_OUTPUT_VALIDATION_MAX_ATTEMPTS,
  MemoryStructuredOutputDispatchFenced, type MemoryExecutionAuthorityDependencies,
  type MemoryStructuredOutputProvider } from "../execution";
import { memoryExecutionSha256 } from "../execution/canonical";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import { createAcceptedMemoryStructuredOutputProvider } from "../execution/structuredClassifier";
import { buildMemoryMaintenanceRequest, buildMemoryMaintenanceVerificationRequest,
  decodeMemoryMaintenanceReview, decodeMemoryMaintenanceVerification, type MemoryMaintenanceOutput,
  type MemoryMaintenanceReviewDecoding, type MemoryMaintenanceVerification } from "./contract";
import { MEMORY_MAINTENANCE_CALL_ATTEMPTS, MEMORY_MAINTENANCE_FAILURE_CODES, MEMORY_MAINTENANCE_VERSIONS, memoryMaintenanceOrdinal,
  type MemoryMaintenanceCall, type MemoryMaintenancePlan, type MemoryMaintenanceSource } from "./policy";
import { loadMemoryMaintenanceRelatedMemories, loadMemoryMaintenanceRelatedStatements } from "./related";
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
/** A disclosed source changed before dispatch, so nothing more is sent. The
 * re-run gate decides STALE or keeps it terminal after a paid review; this
 * decision settles only when that gate cannot decide. */
export function memoryMaintenanceDispatchStale(): MemoryJobFencedError {
  const code = MEMORY_MAINTENANCE_FAILURE_CODES.dispatchStale;
  return new MemoryJobFencedError(code, { errorCode: code, status: "STALE" });
}
type MemoryMaintenanceReviewRepairs = Pick<MemoryMaintenanceReviewDecoding, "normalized" | "conservative">;
/** Content-free counts of the accepted review's repaired decisions; both codes
 * are registered in observability/failureCodes.json. */
function logMemoryMaintenanceReviewRepairs(jobId: string, repairs: MemoryMaintenanceReviewRepairs): void {
  if (repairs.normalized > 0) {
    logEvent("service_operation", { subsystem: "memory", stage: "validate", outcome: "completed",
      code: "memory_maintenance_labels_normalized", count: repairs.normalized, job_id: jobId });
  }
  if (repairs.conservative > 0) {
    logEvent("service_operation", { subsystem: "memory", stage: "validate", outcome: "degraded",
      code: "memory_maintenance_contradictions_kept", count: repairs.conservative, job_id: jobId });
  }
}
export function createPrismaMemoryMaintenanceProvider(client: PrismaClient, options: Readonly<{
  authority?: MemoryExecutionAuthorityDependencies; provider?: MemoryStructuredOutputProvider;
  sources?: typeof loadMemoryMaintenanceSources; related?: typeof loadMemoryMaintenanceRelatedMemories;
  relatedStatements?: typeof loadMemoryMaintenanceRelatedStatements;
}> = {}) {
  const authority = options.authority ?? defaultMemoryExecutionAuthority;
  const provider = options.provider ?? createAcceptedMemoryStructuredOutputProvider(client);
  const loadSources = options.sources ?? loadMemoryMaintenanceSources;
  const loadRelated = options.related ?? loadMemoryMaintenanceRelatedMemories;
  const loadRelatedStatements = options.relatedStatements ?? loadMemoryMaintenanceRelatedStatements;
  async function current(userId: string, disclosed: readonly MemoryMaintenanceSource[]): Promise<boolean> {
    const loaded = await loadSources(client, userId, { versionIds: disclosed.map(({ versionId }) => versionId), now: new Date() });
    if (!disclosed.every((source) => loaded.sources.get(source.versionId)?.sourceSnapshotHash === source.sourceSnapshotHash)) return false;
    const related = disclosed.flatMap((source) => source.related ?? []);
    if (related.length === 0) return true;
    const statements = await loadRelatedStatements(client, userId, related.map(({ versionId }) => versionId));
    return related.every((memory) => {
      const shown = statements.get(memory.versionId);
      return shown?.factId === memory.factId && shown.statement === memory.statement;
    });
  }
  /** Every disclosed source, and every related memory shown with it, is
   * revalidated before a call binds (the first call and each validation
   * retry), so a changed one costs no binding or paid call, and again inside
   * the bound call just before dispatch, where a fence settles that binding
   * CANCELLED without usage. Each attempt has its own ordinal of the call's
   * parity. */
  async function run<T>(owner: Owner, call: MemoryMaintenanceCall, disclosed: readonly MemoryMaintenanceSource[], signal: AbortSignal,
    inputHash: string, request: ReturnType<typeof buildMemoryMaintenanceRequest>, decode: (value: unknown) => T): Promise<MemoryMaintenanceResult<T>> {
    const revalidate = async () => { if (!await current(owner.userId, disclosed)) throw memoryMaintenanceDispatchStale(); };
    await revalidate();
    try {
      const result = await executeGovernedMemoryStructuredOutput({
        authority, client, decode, inputHash, ordinal: memoryMaintenanceOrdinal(call, 0), owner: { memoryJobId: owner.jobId, type: "JOB" },
        provider: { async run(snapshot, request, signal) {
          if (!await current(owner.userId, disclosed)) throw new MemoryStructuredOutputDispatchFenced(MEMORY_MAINTENANCE_FAILURE_CODES.dispatchStale);
          return provider.run(snapshot, request, signal);
        } }, request,
        role: "MEMORY_SYNTHESIZE", signal, userId: owner.userId, versions: MEMORY_MAINTENANCE_VERSIONS,
        // The receipt check admits only the maintenance attempts' ordinals.
        validationRetry: { maxAttempts: Math.min(MEMORY_STRUCTURED_OUTPUT_VALIDATION_MAX_ATTEMPTS, MEMORY_MAINTENANCE_CALL_ATTEMPTS),
          beforeRetry: revalidate, allocateOrdinal: (attempt) => memoryMaintenanceOrdinal(call, attempt) },
        persistResult: async (tx, durable) => {
          await tx.memoryMaintenanceExecution.create({ data: {
            userId: owner.userId, memoryJobId: owner.jobId, executionBindingId: durable.bindingId,
            ordinal: durable.ordinal, inputHash, acceptedOutputHash: durable.acceptedOutputHash,
            acceptedOutput: durable.value as unknown as Prisma.InputJsonValue
          } });
        }
      });
      return { acceptedOutputHash: result.acceptedOutputHash, executionId: result.bindingId, inputHash: result.inputHash,
        modelId: result.modelId, output: result.value, policyVersion: result.policyVersion, providerId: result.providerId };
    } catch (error) {
      // The executor settled the fenced binding CANCELLED; the job ends as staleness before dispatch.
      if (error instanceof MemoryStructuredOutputDispatchFenced) throw memoryMaintenanceDispatchStale();
      throw error;
    }
  }
  return Object.freeze({
    /** The review shows each source with its related memories, which stay
     * outside the reviewed plan's identity: a contradiction carries the exact
     * identity of the one it names. Counts the repairs of the accepted answer
     * only, once it settled. */
    async review(plan: MemoryMaintenancePlan, signal: AbortSignal, owner: Owner) {
      const related = await loadRelated(client, owner.userId, plan.sources, { jobId: owner.jobId, signal });
      const shown: MemoryMaintenancePlan = { ...plan, sources: plan.sources.map((source) => {
        const memories = related.get(source.ref);
        return memories ? { ...source, related: memories } : source;
      }) };
      let repairs: MemoryMaintenanceReviewRepairs = { normalized: 0, conservative: 0 };
      const result = await run(owner, "review", shown.sources, signal, memoryMaintenanceInputHash(plan), buildMemoryMaintenanceRequest(shown),
        (value) => {
          const decoded = decodeMemoryMaintenanceReview(value, shown);
          repairs = decoded;
          return decoded.output;
        });
      logMemoryMaintenanceReviewRepairs(owner.jobId, repairs);
      return result;
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
