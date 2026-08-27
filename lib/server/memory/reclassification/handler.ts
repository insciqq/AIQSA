import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type {
  MemoryJobDescriptor,
  MemoryJobExecutionResult,
  MemoryJobHandler
} from "../coordinator/types";
import type {
  MemoryExecutionAuthorityDependencies,
  MemoryStructuredOutputProvider
} from "../execution";
import { memoryExecutionSha256 } from "../execution/canonical";
import {
  memoryRedactionHasMeaningfulRemainder,
  memoryValueContainsRecognizedSecret,
  redactMemorySecrets
} from "../explicit/safety";
import {
  MEMORY_V1_CATEGORY_ALLOWLIST,
  type MemoryV1Category
} from "../learning/extraction/contract";
import type { LockedMemorySettings } from "../persistence/transaction";
import { MEMORY_SAFETY_LITE_POLICY_VERSION } from "../safetyLite";
import {
  MEMORY_RECLASSIFICATION_PIPELINE_VERSION,
  type MemoryReclassificationProvider,
  type MemoryReclassificationResult
} from "./classifier";
import {
  createPrismaMemoryReclassificationRepository,
  MEMORY_RECLASSIFICATION_BATCH_SIZE,
  type MemoryReclassificationCandidate,
  type MemoryReclassificationRepository
} from "./repository";

/** Legacy dependency fields remain accepted so in-process composition does
 * not need an atomic rollout. Safety Lite deliberately never invokes them. */
export type MemoryReclassificationHandlerDependencies = Readonly<{
  authorizeResults?: (
    tx: Prisma.TransactionClient,
    settings: LockedMemorySettings,
    userId: string,
    jobId: string,
    results: readonly Readonly<{
      acceptedOutputHash: string;
      bindingId: string;
      inputHash: string;
      modelId: string;
      policyVersion: string;
      providerId: string;
    }>[]
  ) => Promise<void>;
  probeAuthority?: (userId: string) => Promise<void>;
  provider?: MemoryReclassificationProvider;
  repository: MemoryReclassificationRepository;
}>;

const durableCategories = new Set<string>(MEMORY_V1_CATEGORY_ALLOWLIST);

function validClaim(job: MemoryJobDescriptor): boolean {
  return job.kind === "RECLASSIFY_FACTS" &&
    job.chatId === null &&
    job.activeLeafMessageId === null &&
    job.branchGeneration === null &&
    job.sourceRevision === null &&
    job.sourceHash === null &&
    job.pipelineVersion === MEMORY_RECLASSIFICATION_PIPELINE_VERSION &&
    Number.isSafeInteger(job.memoryGenerationSnapshot) &&
    job.memoryGenerationSnapshot >= 0 &&
    Number.isSafeInteger(job.memoryRevisionSnapshot) &&
    job.memoryRevisionSnapshot >= 0;
}

function terminalResult(
  job: MemoryJobDescriptor,
  reason: string,
  inputHash: string | null = null
): MemoryJobExecutionResult {
  return {
    acceptedResultHash: memoryExecutionSha256({
      domain: "aiqsa.memory.reclassification-terminal",
      inputHash,
      jobId: job.id,
      reason,
      version: 2
    }),
    stage: reason
  };
}

function categoryFor(candidate: MemoryReclassificationCandidate): MemoryV1Category {
  return durableCategories.has(candidate.category)
    ? candidate.category as MemoryV1Category
    : "other";
}

function localResult(
  candidate: MemoryReclassificationCandidate,
  classifiedAt: Date
): MemoryReclassificationResult {
  const redaction = redactMemorySecrets(candidate.displayText);
  const secretOnly = redaction.containsSecret &&
    !memoryRedactionHasMeaningfulRemainder(candidate.displayText, redaction);
  return {
    classifiedAt,
    decision: {
      category: categoryFor(candidate),
      reasonCode: secretOnly ? "secret_material" : "ordinary_personal",
      responsePreference: candidate.modality === "PREFERENCE",
      sensitivity: secretOnly ? "SECRET" : "NORMAL",
      storageDecision: secretOnly ? "REJECT_SECRET" : "ALLOW",
      subjectScope: "USER"
    },
    executionId: null,
    modelId: MEMORY_SAFETY_LITE_POLICY_VERSION,
    policyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION,
    providerId: "aiqsa-local-policy"
  };
}

export function createMemoryReclassificationHandler(
  deps: MemoryReclassificationHandlerDependencies
): MemoryJobHandler {
  return Object.freeze({
    kind: "RECLASSIFY_FACTS" as const,

    async preflight(job) {
      if (!validClaim(job)) {
        return { errorCode: "memory_reclassification_job_invalid", status: "CANCELLED" };
      }
      return deps.repository.preflight(job);
    },

    async execute(job, context) {
      if (!validClaim(job)) return terminalResult(job, "reclassification_job_invalid");
      await context.setStage("source_snapshot");
      const candidates = await deps.repository.pending(
        job.userId,
        MEMORY_RECLASSIFICATION_BATCH_SIZE
      );
      if (candidates.length === 0) {
        return terminalResult(job, "reclassification_empty");
      }

      await context.setStage("local_safety_projection");
      const classifiedAt = context.now();
      const plans = candidates.map((candidate) => {
        if (context.signal.aborted) {
          throw new MemoryCoordinatorError("memory_reclassification_cancelled", false);
        }
        return { candidate, result: localResult(candidate, classifiedAt) };
      });
      const acceptedResultHash = memoryExecutionSha256({
        decisions: plans.map(({ candidate, result }) => {
          const projection = redactMemorySecrets(candidate.displayText);
          return {
            id: candidate.id,
            policyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION,
            projectedTextHash: projection.containsSecret &&
              memoryRedactionHasMeaningfulRemainder(candidate.displayText, projection)
              ? memoryExecutionSha256(projection.redactedText)
              : null,
            reasonCode: result.decision.sensitivity === "SECRET"
              ? "lite_secret_only"
              : projection.containsSecret ||
                  memoryValueContainsRecognizedSecret(candidate.structuredValue)
                ? "lite_span_redacted"
                : "lite_non_secret_default",
            sourceMode: candidate.sourceMode
          };
        }),
        domain: "aiqsa.memory.reclassification",
        jobId: job.id,
        pipelineVersion: MEMORY_RECLASSIFICATION_PIPELINE_VERSION
      });
      await context.setStage("local_apply");
      return {
        acceptedResultHash,
        apply: (tx, claim) =>
          deps.repository.apply(tx, claim.userId, plans, classifiedAt),
        stage: "reclassification_applied"
      };
    }
  });
}

export function createPrismaMemoryReclassificationHandler(
  client: PrismaClient = prisma,
  options: Readonly<{
    authority?: MemoryExecutionAuthorityDependencies;
    structuredProvider?: MemoryStructuredOutputProvider;
    provider?: MemoryReclassificationProvider;
    repository?: MemoryReclassificationRepository;
  }> = {}
): MemoryJobHandler {
  return createMemoryReclassificationHandler({
    repository: options.repository ?? createPrismaMemoryReclassificationRepository(client)
  });
}
