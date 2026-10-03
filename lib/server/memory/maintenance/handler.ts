import { Prisma, type PrismaClient } from "@prisma/client";
import { databaseFailureCode, rememberDatabaseFailure } from "../../observability/databaseFailure";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type { MemoryJobClaim, MemoryJobDescriptor, MemoryJobExecutionContext, MemoryJobExecutionResult,
  MemoryJobHandler } from "../coordinator/types";
import { authorizeMemoryExecutionResultsForCommit, MemoryExecutionError, MemoryStructuredOutputProviderError,
  probeMemoryStructuredOutputAuthority, type MemoryExecutionAuthorityDependencies,
  type MemoryStructuredOutputProvider } from "../execution";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import { memoryExecutionSha256 } from "../execution/canonical";
import { lockMemorySettings } from "../persistence/transaction";
import type { MemoryMaintenanceOutput } from "./contract";
import { MEMORY_MAINTENANCE_PIPELINE_VERSION, MEMORY_MAINTENANCE_POLICY_VERSION, MEMORY_MAINTENANCE_VERSIONS,
  type MemoryMaintenanceCall } from "./policy";
import { createPrismaMemoryMaintenanceProvider, memoryMaintenanceInputHash, type MemoryMaintenanceProvider,
  type MemoryMaintenanceVerificationResult } from "./provider";
import { createPrismaMemoryMaintenanceRepository, type MemoryMaintenanceRepository } from "./repository";

export function isMemoryMaintenanceJob(job: MemoryJobDescriptor): boolean {
  return job.kind === "SYNTHESIZE_MEMORIES" && job.pipelineVersion === MEMORY_MAINTENANCE_PIPELINE_VERSION &&
    job.chatId === null && job.sourceMessageId === null && job.targetFactVersionId === null &&
    job.activeLeafMessageId === null && job.branchGeneration === null && job.sourceRevision === null && job.sourceHash === null;
}
/** A content-free, non-retryable job failure that keeps a database cause for logs. */
function maintenanceFailure(code: string, cause: unknown): MemoryCoordinatorError {
  const failure = new MemoryCoordinatorError(code, false);
  rememberDatabaseFailure(failure, cause instanceof Prisma.PrismaClientKnownRequestError ? cause.code : databaseFailureCode(cause));
  return failure;
}
/** The structured executor's settlement mapping, for a call whose binding never settled. */
function unsettledCallFailureCode(error: unknown): string {
  if (error instanceof MemoryExecutionError) return error.code;
  if (error instanceof MemoryStructuredOutputProviderError && error.outputLimitExceeded) return "memory_classifier_output_limit_exceeded";
  if (error instanceof MemoryStructuredOutputProviderError && error.outputInvalid) return "memory_classifier_output_invalid";
  return "memory_classifier_provider_unavailable";
}
/** Before the paid review a changed source stales the whole plan; afterwards
 * the verifier receives only still-matching removals and apply settles each
 * changed source on its own. A failed call ends the job with its real cause;
 * a new job, never a replay, may review again (see the planner budgets). */
export function createPrismaMemoryMaintenanceHandler(client: PrismaClient, options: Readonly<{
  authority?: MemoryExecutionAuthorityDependencies; structuredProvider?: MemoryStructuredOutputProvider;
  provider?: MemoryMaintenanceProvider; repository?: MemoryMaintenanceRepository;
}> = {}): MemoryJobHandler {
  const authority = options.authority ?? defaultMemoryExecutionAuthority;
  const provider = options.provider ?? createPrismaMemoryMaintenanceProvider(client, { authority, provider: options.structuredProvider });
  const repository = options.repository ?? createPrismaMemoryMaintenanceRepository(client);
  /** Earlier attempts are never replayed: a consumed one ends the job with its cause. */
  async function assertCallUnused(job: MemoryJobDescriptor, call: MemoryMaintenanceCall): Promise<void> {
    const prior = await repository.callState(job, call);
    if (prior.status === "UNUSED") return;
    throw new MemoryCoordinatorError(prior.status === "CONSUMED" ? prior.errorCode : "memory_maintenance_outcome_unknown", false);
  }
  /** The settled binding of a failed call holds its stable cause; a dispatch
   * without a settled outcome stays unknown. */
  async function governed<T>(job: MemoryJobDescriptor, call: MemoryMaintenanceCall, signal: AbortSignal,
    dispatch: () => Promise<T>): Promise<T> {
    try {
      return await dispatch();
    } catch (error) {
      if (signal.aborted || error instanceof MemoryCoordinatorError) throw error;
      const settled = await repository.callState(job, call).catch(() => null);
      throw maintenanceFailure(settled?.status === "CONSUMED" ? settled.errorCode
        : settled?.status === "SUCCEEDED" || (settled?.status === "UNKNOWN" && settled.ambiguous)
          ? "memory_maintenance_outcome_unknown" : unsettledCallFailureCode(error), error);
    }
  }
  async function execute(job: MemoryJobClaim, context: MemoryJobExecutionContext): Promise<MemoryJobExecutionResult> {
    if (!isMemoryMaintenanceJob(job)) throw new MemoryCoordinatorError("memory_maintenance_job_invalid", false);
    const reviewed = await repository.snapshot(job);
    if (!reviewed) throw new MemoryCoordinatorError("memory_maintenance_source_stale", false);
    const owner = { userId: job.userId, jobId: job.id };
    await context.setStage("maintenance_review");
    let review = await repository.stagedReview(job, reviewed, memoryMaintenanceInputHash(reviewed));
    if (!review) {
      await assertCallUnused(job, "review");
      const plan = reviewed.plan;
      if (!plan) throw new MemoryCoordinatorError("memory_maintenance_source_stale", false);
      review = await governed(job, "review", context.signal, () => provider.review(plan, context.signal, owner));
    }
    if (review.policyVersion !== MEMORY_MAINTENANCE_POLICY_VERSION) {
      throw new MemoryCoordinatorError("memory_maintenance_policy_stale", false);
    }
    let verification: MemoryMaintenanceVerificationResult | null = null;
    if (review.output.decisions.some(({ action }) => action === "REMOVE_TRANSIENT")) {
      await context.setStage("maintenance_verify");
      verification = await repository.stagedVerification(job, reviewed, review.output);
      if (!verification) {
        await assertCallUnused(job, "verify");
        // Disclose only removals whose source still matches its reviewed
        // hash; a changed one is BLOCKED in apply instead of staling the batch.
        const current = await repository.snapshot(job);
        if (current?.sourceSnapshotHash !== reviewed.sourceSnapshotHash) {
          throw new MemoryCoordinatorError("memory_maintenance_source_stale", false);
        }
        const removals = new Set(review.output.decisions.filter(({ action }) => action === "REMOVE_TRANSIENT").map(({ sourceRef }) => sourceRef));
        const disclosed = current.sources.flatMap(({ ref, current: content }) => removals.has(ref) && content ? [content] : []);
        const proposal: MemoryMaintenanceOutput = { decisions: review.output.decisions.filter(({ sourceRef }) =>
          disclosed.some(({ ref }) => ref === sourceRef)) };
        if (disclosed.length) {
          verification = await governed(job, "verify", context.signal,
            () => provider.verify(reviewed, disclosed, proposal, context.signal, owner));
        }
      }
      if (verification && verification.policyVersion !== MEMORY_MAINTENANCE_POLICY_VERSION) {
        throw new MemoryCoordinatorError("memory_maintenance_policy_stale", false);
      }
    }
    const accepted = verification ? [review, verification] : [review];
    const reviewResult = review;
    const verificationResult = verification;
    return {
      acceptedResultHash: memoryExecutionSha256({ domain: "memory-maintenance-result", outputs: accepted.map(({ acceptedOutputHash }) => acceptedOutputHash) }),
      stage: "maintenance_authorized_apply",
      apply: async (tx, claim) => {
        const settings = await lockMemorySettings(tx, claim.userId, true);
        const authorized = await authorizeMemoryExecutionResultsForCommit(authority, tx, settings, claim.userId,
          { memoryJobId: claim.id, role: "MEMORY_SYNTHESIZE" }, accepted.map((result) => ({
            bindingId: result.executionId, acceptedOutputHash: result.acceptedOutputHash, inputHash: result.inputHash
          })));
        if (authorized.length !== accepted.length || authorized.some((result, index) => result.bindingId !== accepted[index]!.executionId ||
          result.modelId !== accepted[index]!.modelId || result.providerId !== accepted[index]!.providerId ||
          result.policyVersion !== accepted[index]!.policyVersion)) throw new Error("memory_maintenance_authority_mismatch");
        await repository.apply(tx, claim, reviewed, reviewResult, verificationResult, context.now());
      }
    };
  }
  return Object.freeze({
    kind: "SYNTHESIZE_MEMORIES" as const,
    async preflight(job) {
      if (!isMemoryMaintenanceJob(job)) return { status: "CANCELLED", errorCode: "memory_maintenance_job_invalid" };
      const settings = await client.userMemorySettings.findUnique({ where: { userId: job.userId },
        select: { useMemoryFacts: true, learnAutomatically: true, memoryGeneration: true, memoryRevision: true } });
      if (!settings?.useMemoryFacts || !settings.learnAutomatically) {
        return { status: "CANCELLED", errorCode: "memory_maintenance_disabled" };
      }
      if (settings.memoryGeneration !== job.memoryGenerationSnapshot) return { status: "STALE", errorCode: "memory_maintenance_source_stale" };
      // Only a succeeded review keeps a changed plan alive; a failed,
      // cancelled or unknown one never does.
      const snapshot = await repository.snapshot(job);
      if (!snapshot || (!snapshot.plan && (await repository.callState(job, "review")).status !== "SUCCEEDED")) {
        return { status: "STALE", errorCode: "memory_maintenance_source_stale" };
      }
      try {
        await probeMemoryStructuredOutputAuthority({ authority, client, role: "MEMORY_SYNTHESIZE", userId: job.userId, versions: MEMORY_MAINTENANCE_VERSIONS });
      } catch { return { status: "WAITING_FOR_CONFIGURATION", errorCode: "memory_maintenance_authority_unavailable" }; }
      return { status: "READY" };
    },
    async execute(job, context) {
      try {
        return await execute(job, context);
      } catch (error) {
        // Never the opaque memory_job_failed, which only a previous release recorded.
        if (context.signal.aborted || error instanceof MemoryCoordinatorError) throw error;
        throw maintenanceFailure("memory_maintenance_failed", error);
      }
    }
  });
}
