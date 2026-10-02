import type { PrismaClient } from "@prisma/client";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type { MemoryJobDescriptor, MemoryJobHandler } from "../coordinator/types";
import { authorizeMemoryExecutionResultsForCommit, probeMemoryStructuredOutputAuthority,
  type MemoryExecutionAuthorityDependencies, type MemoryStructuredOutputProvider } from "../execution";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import { memoryExecutionSha256 } from "../execution/canonical";
import { lockMemorySettings } from "../persistence/transaction";
import { MEMORY_MAINTENANCE_PIPELINE_VERSION, MEMORY_MAINTENANCE_POLICY_VERSION, MEMORY_MAINTENANCE_VERSIONS } from "./policy";
import { createPrismaMemoryMaintenanceProvider, memoryMaintenanceInputHash, type MemoryMaintenanceProvider,
  type MemoryMaintenanceVerificationResult } from "./provider";
import { createPrismaMemoryMaintenanceRepository, type MemoryMaintenanceRepository } from "./repository";

export function isMemoryMaintenanceJob(job: MemoryJobDescriptor): boolean {
  return job.kind === "SYNTHESIZE_MEMORIES" && job.pipelineVersion === MEMORY_MAINTENANCE_PIPELINE_VERSION &&
    job.chatId === null && job.sourceMessageId === null && job.targetFactVersionId === null &&
    job.activeLeafMessageId === null && job.branchGeneration === null && job.sourceRevision === null && job.sourceHash === null;
}
export function createPrismaMemoryMaintenanceHandler(client: PrismaClient, options: Readonly<{
  authority?: MemoryExecutionAuthorityDependencies; structuredProvider?: MemoryStructuredOutputProvider;
  provider?: MemoryMaintenanceProvider; repository?: MemoryMaintenanceRepository;
}> = {}): MemoryJobHandler {
  const authority = options.authority ?? defaultMemoryExecutionAuthority;
  const provider = options.provider ?? createPrismaMemoryMaintenanceProvider(client, { authority, provider: options.structuredProvider });
  const repository = options.repository ?? createPrismaMemoryMaintenanceRepository(client);
  return Object.freeze({
    kind: "SYNTHESIZE_MEMORIES" as const,
    async preflight(job) {
      if (!isMemoryMaintenanceJob(job)) return { status: "CANCELLED", errorCode: "memory_maintenance_job_invalid" };
      const settings = await client.userMemorySettings.findUnique({ where: { userId: job.userId },
        select: { useMemoryFacts: true, learnAutomatically: true, memoryGeneration: true, memoryRevision: true } });
      if (!settings?.useMemoryFacts || !settings.learnAutomatically) {
        return { status: "CANCELLED", errorCode: "memory_maintenance_disabled" };
      }
      if (settings.memoryGeneration !== job.memoryGenerationSnapshot ||
        !await repository.snapshot(job)) return { status: "STALE", errorCode: "memory_maintenance_source_stale" };
      try {
        await probeMemoryStructuredOutputAuthority({ authority, client, role: "MEMORY_SYNTHESIZE", userId: job.userId, versions: MEMORY_MAINTENANCE_VERSIONS });
      } catch { return { status: "WAITING_FOR_CONFIGURATION", errorCode: "memory_maintenance_authority_unavailable" }; }
      return { status: "READY" };
    },
    async execute(job, context) {
      if (!isMemoryMaintenanceJob(job)) throw new MemoryCoordinatorError("memory_maintenance_job_invalid", false);
      const plan = await repository.snapshot(job);
      if (!plan) throw new MemoryCoordinatorError("memory_maintenance_source_stale", false);
      const inputHash = memoryMaintenanceInputHash(plan);
      await context.setStage("maintenance_review");
      let review = await repository.stagedReview(job, plan, inputHash);
      if (!review) {
        if (await repository.bindingExists(job, 0)) {
          throw new MemoryCoordinatorError("memory_maintenance_outcome_unknown", false);
        }
        review = await provider.review(plan, context.signal, { userId: job.userId, jobId: job.id });
      }
      if (review.policyVersion !== MEMORY_MAINTENANCE_POLICY_VERSION) {
        throw new MemoryCoordinatorError("memory_maintenance_policy_stale", false);
      }
      let verification: MemoryMaintenanceVerificationResult | null = null;
      if (review.output.decisions.some(({ action }) => action === "REMOVE_TRANSIENT")) {
        await context.setStage("maintenance_verify");
        verification = await repository.stagedVerification(job, review.output, memoryMaintenanceInputHash(plan, review.output));
        if (!verification) {
          if (await repository.bindingExists(job, 1)) throw new MemoryCoordinatorError("memory_maintenance_outcome_unknown", false);
          const fresh = await repository.snapshot(job);
          if (fresh?.sourceSnapshotHash !== plan.sourceSnapshotHash) throw new MemoryCoordinatorError("memory_maintenance_source_stale", false);
          verification = await provider.verify(plan, review.output, context.signal, { userId: job.userId, jobId: job.id });
        }
        if (verification.policyVersion !== MEMORY_MAINTENANCE_POLICY_VERSION) {
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
          await repository.apply(tx, claim, plan, reviewResult, verificationResult, context.now());
        }
      };
    }
  });
}
