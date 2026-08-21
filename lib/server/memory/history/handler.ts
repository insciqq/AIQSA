import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type {
  MemoryJobExecutionResult,
  MemoryJobHandler
} from "../coordinator/types";
import { memorySha256 } from "../persistence/lexical";
import {
  authorizeMemoryExecutionResultsForCommit,
  MemoryExecutionError,
  probeMemoryStructuredOutputAuthority,
  type MemoryExecutionAuthorityDependencies,
  type MemoryStructuredOutputProvider
} from "../execution";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import {
  lockMemorySettings,
  type LockedMemorySettings
} from "../persistence/transaction";
import {
  createPrismaMemoryHistorySafetyClassifier,
  MEMORY_HISTORY_CLASSIFICATION_VERSIONS,
  type MemoryHistoryClassificationResult,
  type MemoryHistorySafetyClassifier
} from "./classifier";
import {
  memoryHistoryIndexClaimIsValid,
  memoryHistoryIndexResultHash,
  type MemoryHistoryIndexPlan
} from "./contract";
import {
  createPrismaMemoryHistoryIndexRepository,
  type MemoryHistoryIndexRepository
} from "./repository";

export type MemoryHistoryIndexHandlerDependencies = Readonly<{
  authorizeResults?: (
    tx: Prisma.TransactionClient,
    settings: LockedMemorySettings,
    userId: string,
    jobId: string,
    results: readonly Readonly<{
      acceptedOutputHash: string;
      bindingId: string;
    }>[]
  ) => Promise<void>;
  classifier: MemoryHistorySafetyClassifier;
  probeAuthority?: (userId: string) => Promise<void>;
  repository: MemoryHistoryIndexRepository;
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

export function applyMemoryHistoryClassifications(
  plan: MemoryHistoryIndexPlan,
  classification: MemoryHistoryClassificationResult
): MemoryHistoryIndexPlan {
  if (
    !classification.policyVersion ||
    classification.policyVersion.length > 256 ||
    classification.decisions.length !== plan.chunks.length
  ) {
    throw new MemoryCoordinatorError("memory_history_classification_invalid", true);
  }
  const decisions = new Map(classification.decisions.map((decision) =>
    [decision.chunkId, decision.sensitivity] as const));
  if (
    decisions.size !== classification.decisions.length ||
    plan.chunks.some((chunk) => !decisions.has(chunk.id))
  ) {
    throw new MemoryCoordinatorError("memory_history_classification_invalid", true);
  }
  const chunks = plan.chunks.flatMap((chunk) => {
    const sensitivity = decisions.get(chunk.id);
    if (sensitivity === "SECRET" || sensitivity === "UNCERTAIN") return [];
    if (sensitivity !== "NORMAL" && sensitivity !== "SENSITIVE") {
      throw new MemoryCoordinatorError("memory_history_classification_invalid", true);
    }
    return [{ ...chunk, safetyClass: "NORMAL" as const }];
  });
  return {
    ...plan,
    classificationPolicyVersion: classification.policyVersion,
    chunks,
    preparedResultHash: plan.resultHash,
    resultHash: memoryHistoryIndexResultHash(
      plan.source,
      chunks,
      plan.suppressionIdentitySnapshot,
      classification.policyVersion
    )
  };
}

function staleExecutionResult(
  jobId: string,
  errorCode = "memory_history_job_invalid"
): MemoryJobExecutionResult {
  return {
    acceptedResultHash: memorySha256({ errorCode, jobId }),
    apply: async () => {
      throw new MemoryCoordinatorError(errorCode, false);
    },
    stage: "source_stale"
  };
}

export function createMemoryHistoryIndexHandler(
  dependencies: MemoryHistoryIndexHandlerDependencies
): MemoryJobHandler {
  return Object.freeze({
    kind: "INDEX_HISTORY" as const,

    async preflight(job) {
      if (!memoryHistoryIndexClaimIsValid(job)) {
        return {
          errorCode: "memory_history_job_invalid",
          status: "CANCELLED" as const
        };
      }
      const source = await dependencies.repository.preflight(job);
      if (source.status !== "READY" || !dependencies.probeAuthority) return source;
      try {
        await dependencies.probeAuthority(job.userId);
        return source;
      } catch (error) {
        return authorityGate(error);
      }
    },

    async execute(claim, context) {
      if (!memoryHistoryIndexClaimIsValid(claim)) {
        return staleExecutionResult(claim.id);
      }
      await context.setStage("source_snapshot");
      const prepared = await dependencies.repository.prepare(claim);
      if ("decision" in prepared) {
        return staleExecutionResult(claim.id, prepared.decision.errorCode);
      }
      if (context.signal.aborted) throw context.signal.reason;
      await context.setStage("safety_classification");
      let plan: MemoryHistoryIndexPlan;
      try {
        const classification = await dependencies.classifier.classify(
          prepared.plan.chunks,
          {
            execution: { jobId: claim.id, userId: claim.userId },
            signal: context.signal
          }
        );
        plan = applyMemoryHistoryClassifications(prepared.plan, classification);
        const executionResults = classification.executions ?? [];
        await context.setStage("lexical_apply");
        return {
          acceptedResultHash: plan.resultHash,
          apply: async (tx, acceptedClaim) => {
            if (executionResults.length > 0) {
              if (!dependencies.authorizeResults) {
                throw new Error("memory_history_classification_authority_missing");
              }
              const settings = await lockMemorySettings(
                tx,
                acceptedClaim.userId,
                true
              );
              await dependencies.authorizeResults(
                tx,
                settings,
                acceptedClaim.userId,
                acceptedClaim.id,
                executionResults
              );
            }
            await dependencies.repository.apply(
              tx,
              acceptedClaim,
              plan,
              context.now()
            );
          },
          stage: "lexical_ready"
        };
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason;
        if (error instanceof MemoryCoordinatorError) throw error;
        throw new MemoryCoordinatorError(
          "memory_history_classification_unavailable",
          true
        );
      }
    }
  });
}

export function createPrismaMemoryHistoryIndexHandler(
  client: PrismaClient = prisma,
  classifier?: MemoryHistorySafetyClassifier,
  options: Readonly<{
    authority?: MemoryExecutionAuthorityDependencies;
    structuredProvider?: MemoryStructuredOutputProvider;
  }> = {}
): MemoryJobHandler {
  const authority = options.authority ?? defaultMemoryExecutionAuthority;
  const governed = classifier === undefined;
  return createMemoryHistoryIndexHandler({
    ...(governed ? {
      authorizeResults: async (
        tx: Prisma.TransactionClient,
        settings: LockedMemorySettings,
        userId: string,
        jobId: string,
        results: readonly Readonly<{
          acceptedOutputHash: string;
          bindingId: string;
        }>[]
      ) => {
        await authorizeMemoryExecutionResultsForCommit(
          authority,
          tx,
          settings,
          userId,
          { memoryJobId: jobId, role: "MEMORY_HISTORY_CLASSIFY" },
          results
        );
      },
      probeAuthority: (userId: string) => probeMemoryStructuredOutputAuthority({
        authority,
        client,
        role: "MEMORY_HISTORY_CLASSIFY",
        userId,
        versions: MEMORY_HISTORY_CLASSIFICATION_VERSIONS
      })
    } : {}),
    classifier: classifier ?? createPrismaMemoryHistorySafetyClassifier(client, {
      authority,
      provider: options.structuredProvider
    }),
    repository: createPrismaMemoryHistoryIndexRepository(client)
  });
}
