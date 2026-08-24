import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type {
  MemoryJobDescriptor,
  MemoryJobExecutionResult,
  MemoryJobHandler
} from "../coordinator/types";
import {
  authorizeMemoryExecutionResultsForCommit,
  MemoryExecutionError,
  probeMemoryStructuredOutputAuthority,
  type MemoryExecutionAuthorityDependencies,
  type MemoryStructuredOutputProvider
} from "../execution";
import { memoryExecutionSha256 } from "../execution/canonical";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import { memoryExplicitStatementContainsSecret } from "../explicit/safety";
import {
  lockMemorySettings,
  type LockedMemorySettings
} from "../persistence/transaction";
import {
  createPrismaMemoryReclassificationProvider,
  memoryReclassificationAcceptedOutputHash,
  memoryReclassificationInputHash,
  MEMORY_RECLASSIFICATION_PIPELINE_VERSION,
  MEMORY_RECLASSIFICATION_VERSIONS,
  type MemoryReclassificationProvider
} from "./classifier";
import {
  createPrismaMemoryReclassificationRepository,
  MEMORY_RECLASSIFICATION_BATCH_SIZE,
  type MemoryReclassificationRepository
} from "./repository";

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
  provider: MemoryReclassificationProvider;
  repository: MemoryReclassificationRepository;
}>;

function authorityGate(error: unknown) {
  if (error instanceof MemoryExecutionError) {
    if (
      error.code === "memory_execution_egress_consent_required" ||
      error.code === "memory_execution_target_unavailable" ||
      error.code === "memory_execution_capability_unavailable" ||
      error.code === "memory_execution_policy_unavailable"
    ) {
      return { errorCode: error.code, status: "WAITING_FOR_EGRESS_CONSENT" as const };
    }
    return { errorCode: error.code, status: "CANCELLED" as const };
  }
  throw error;
}

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
      version: 1
    }),
    stage: reason
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
      const source = await deps.repository.preflight(job);
      if (source.status !== "READY" || !deps.probeAuthority) return source;
      const candidates = await deps.repository.pending(
        job.userId,
        MEMORY_RECLASSIFICATION_BATCH_SIZE
      );
      if (
        candidates.length === 0 ||
        candidates.every(({ displayText }) =>
          memoryExplicitStatementContainsSecret(displayText)
        )
      ) {
        return source;
      }
      try {
        await deps.probeAuthority(job.userId);
        return source;
      } catch (error) {
        return authorityGate(error);
      }
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

      await context.setStage("provider_call");
      const plans = [] as Array<{
        candidate: (typeof candidates)[number];
        result: Awaited<ReturnType<MemoryReclassificationProvider["classify"]>>;
      }>;
      for (const candidate of candidates) {
        if (context.signal.aborted) {
          throw new MemoryCoordinatorError("memory_reclassification_cancelled", false);
        }
        if (memoryExplicitStatementContainsSecret(candidate.displayText)) {
          plans.push({
            candidate,
            result: {
              classifiedAt: context.now(),
              decision: {
                category: "other",
                reasonCode: "secret_material",
                responsePreference: false,
                sensitivity: "SECRET",
                storageDecision: "REJECT_SECRET",
                subjectScope: "USER"
              },
              executionId: null,
              modelId: "format-aware-secret-parser-v1",
              policyVersion: "memory-local-secret-parser-v1",
              providerId: "aiqsa-local-policy"
            }
          });
          continue;
        }
        try {
          plans.push({
            candidate,
            result: await deps.provider.classify(
              candidate.displayText,
              context.signal,
              candidate.sourceMode,
              {
                jobId: job.id,
                ordinal: plans.length,
                userId: job.userId
              }
            )
          });
        } catch (error) {
          if (error instanceof MemoryCoordinatorError) throw error;
          throw new MemoryCoordinatorError(
            error instanceof Error && error.message === "memory_reclassification_invalid"
              ? "memory_reclassification_invalid"
              : "memory_reclassification_provider_unavailable",
            true
          );
        }
      }

      for (const { candidate, result } of plans) {
        if (!result.executionId) continue;
        const inputHash = memoryReclassificationInputHash(
          candidate.displayText,
          candidate.sourceMode
        );
        if (!result.inputHash || !result.acceptedOutputHash ||
          result.inputHash !== inputHash ||
          result.acceptedOutputHash !== memoryReclassificationAcceptedOutputHash(
            inputHash,
            result.decision
          )) {
          throw new MemoryCoordinatorError("memory_reclassification_invalid", false);
        }
      }

      const acceptedResultHash = memoryExecutionSha256({
        decisions: plans.map(({ candidate, result }) => ({
          category: result.decision.category,
          executionId: result.executionId ?? null,
          id: candidate.id,
          inputHash: result.inputHash ?? null,
          modelId: result.modelId,
          outputHash: result.acceptedOutputHash ?? null,
          policyVersion: result.policyVersion,
          providerId: result.providerId,
          reasonCode: result.decision.reasonCode,
          responsePreference: result.decision.responsePreference,
          sourceMode: candidate.sourceMode,
          storageDecision: result.decision.storageDecision,
          subjectScope: result.decision.subjectScope,
          sensitivity: result.decision.sensitivity
        })),
        domain: "aiqsa.memory.reclassification",
        jobId: job.id,
        pipelineVersion: MEMORY_RECLASSIFICATION_PIPELINE_VERSION
      });
      await context.setStage("authorized_apply");
      const executionResults = plans.flatMap(({ result }) =>
        result.executionId && result.acceptedOutputHash
          ? [{
              acceptedOutputHash: result.acceptedOutputHash,
              bindingId: result.executionId,
              inputHash: result.inputHash!,
              modelId: result.modelId,
              policyVersion: result.policyVersion,
              providerId: result.providerId
            }]
          : []);
      return {
        acceptedResultHash,
        apply: async (tx, claim) => {
          if (executionResults.length > 0) {
            if (!deps.authorizeResults) {
              throw new Error("memory_reclassification_authority_missing");
            }
            const settings = await lockMemorySettings(tx, claim.userId, true);
            try {
              await deps.authorizeResults(
                tx,
                settings,
                claim.userId,
                claim.id,
                executionResults
              );
            } catch (error) {
              if (error instanceof MemoryExecutionError) {
                throw new MemoryCoordinatorError(error.code, false);
              }
              throw error;
            }
          }
          await deps.repository.apply(tx, claim.userId, plans, context.now());
        },
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
  const authority = options.authority ?? defaultMemoryExecutionAuthority;
  return createMemoryReclassificationHandler({
    authorizeResults: async (tx, settings, userId, jobId, results) => {
      const evidence = await authorizeMemoryExecutionResultsForCommit(
        authority,
        tx,
        settings,
        userId,
        { memoryJobId: jobId, role: "MEMORY_RECLASSIFY" },
        results.map(({ acceptedOutputHash, bindingId, inputHash }) => ({
          acceptedOutputHash,
          bindingId,
          inputHash
        }))
      );
      if (evidence.length !== results.length || results.some((result) => {
        const authorized = evidence.find(({ bindingId }) =>
          bindingId === result.bindingId);
        return !authorized || authorized.modelId !== result.modelId ||
          authorized.policyVersion !== result.policyVersion ||
          authorized.providerId !== result.providerId;
      })) {
        throw new Error("memory_reclassification_authority_mismatch");
      }
    },
    probeAuthority: (userId) => probeMemoryStructuredOutputAuthority({
      authority,
      client,
      role: "MEMORY_RECLASSIFY",
      userId,
      versions: MEMORY_RECLASSIFICATION_VERSIONS
    }),
    provider: options.provider ?? createPrismaMemoryReclassificationProvider(
      client,
      { authority, provider: options.structuredProvider }
    ),
    repository: options.repository ?? createPrismaMemoryReclassificationRepository(client)
  });
}
