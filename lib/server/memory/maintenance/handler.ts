import type { PrismaClient } from "@prisma/client";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type { MemoryJobDescriptor, MemoryJobHandler } from "../coordinator/types";
import { authorizeMemoryExecutionResultsForCommit, probeMemoryStructuredOutputAuthority,
  type MemoryExecutionAuthorityDependencies, type MemoryStructuredOutputProvider } from "../execution";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import { memoryExecutionSha256 } from "../execution/canonical";
import { lockMemorySettings } from "../persistence/transaction";
import type { MemoryMaintenanceOutput } from "./contract";
import { MEMORY_MAINTENANCE_PIPELINE_VERSION, MEMORY_MAINTENANCE_POLICY_VERSION, MEMORY_MAINTENANCE_VERSIONS } from "./policy";
import { createPrismaMemoryMaintenanceProvider, memoryMaintenanceInputHash, type MemoryMaintenanceProvider,
  type MemoryMaintenanceVerificationResult } from "./provider";
import { createPrismaMemoryMaintenanceRepository, type MemoryMaintenanceRepository } from "./repository";

export function isMemoryMaintenanceJob(job: MemoryJobDescriptor): boolean {
  return job.kind === "SYNTHESIZE_MEMORIES" && job.pipelineVersion === MEMORY_MAINTENANCE_PIPELINE_VERSION &&
    job.chatId === null && job.sourceMessageId === null && job.targetFactVersionId === null &&
    job.activeLeafMessageId === null && job.branchGeneration === null && job.sourceRevision === null && job.sourceHash === null;
}
/** Before the paid review a changed source stales the whole plan; afterwards
 * the verifier receives only still-matching removals and apply settles each
 * changed source on its own. */
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
      if (settings.memoryGeneration !== job.memoryGenerationSnapshot) return { status: "STALE", errorCode: "memory_maintenance_source_stale" };
      const snapshot = await repository.snapshot(job);
      if (!snapshot || (!snapshot.plan && !await repository.bindingExists(job, 0))) {
        return { status: "STALE", errorCode: "memory_maintenance_source_stale" };
      }
      try {
        await probeMemoryStructuredOutputAuthority({ authority, client, role: "MEMORY_SYNTHESIZE", userId: job.userId, versions: MEMORY_MAINTENANCE_VERSIONS });
      } catch { return { status: "WAITING_FOR_CONFIGURATION", errorCode: "memory_maintenance_authority_unavailable" }; }
      return { status: "READY" };
    },
    async execute(job, context) {
      if (!isMemoryMaintenanceJob(job)) throw new MemoryCoordinatorError("memory_maintenance_job_invalid", false);
      const reviewed = await repository.snapshot(job);
      if (!reviewed) throw new MemoryCoordinatorError("memory_maintenance_source_stale", false);
      const owner = { userId: job.userId, jobId: job.id };
      await context.setStage("maintenance_review");
      let review = await repository.stagedReview(job, reviewed, memoryMaintenanceInputHash(reviewed));
      if (!review) {
        if (await repository.bindingExists(job, 0)) {
          throw new MemoryCoordinatorError("memory_maintenance_outcome_unknown", false);
        }
        if (!reviewed.plan) throw new MemoryCoordinatorError("memory_maintenance_source_stale", false);
        review = await provider.review(reviewed.plan, context.signal, owner);
      }
      if (review.policyVersion !== MEMORY_MAINTENANCE_POLICY_VERSION) {
        throw new MemoryCoordinatorError("memory_maintenance_policy_stale", false);
      }
      let verification: MemoryMaintenanceVerificationResult | null = null;
      if (review.output.decisions.some(({ action }) => action === "REMOVE_TRANSIENT")) {
        await context.setStage("maintenance_verify");
        verification = await repository.stagedVerification(job, reviewed, review.output);
        if (!verification) {
          if (await repository.bindingExists(job, 1)) throw new MemoryCoordinatorError("memory_maintenance_outcome_unknown", false);
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
          if (disclosed.length) verification = await provider.verify(reviewed, disclosed, proposal, context.signal, owner);
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
  });
}
