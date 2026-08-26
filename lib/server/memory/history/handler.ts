import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type {
  MemoryJobExecutionResult,
  MemoryJobHandler
} from "../coordinator/types";
import { memorySha256 } from "../persistence/lexical";
import type { MemoryOperationalCounters } from "../operational/counters";
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
  createPrismaMemoryChatDigestGenerator,
  MEMORY_CHAT_DIGEST_VERSIONS,
  type MemoryChatDigestGenerator
} from "./digest";
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
  digestGenerator?: MemoryChatDigestGenerator;
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
  const rebuilt = new Set(plan.rebuiltChunkIds);
  if (
    !classification.policyVersion ||
    classification.policyVersion.length > 256 ||
    classification.decisions.length !== rebuilt.size
  ) {
    throw new MemoryCoordinatorError("memory_history_classification_invalid", true);
  }
  const decisions = new Map(classification.decisions.map((decision) =>
    [decision.chunkId, decision.sensitivity] as const));
  if (
    decisions.size !== classification.decisions.length ||
    plan.chunks.some((chunk) => rebuilt.has(chunk.id) && !decisions.has(chunk.id)) ||
    classification.decisions.some((decision) => !rebuilt.has(decision.chunkId))
  ) {
    throw new MemoryCoordinatorError("memory_history_classification_invalid", true);
  }
  const chunks = plan.chunks.map((chunk) => {
    if (!rebuilt.has(chunk.id)) return chunk;
    const sensitivity = decisions.get(chunk.id);
    if (sensitivity === "SECRET" || sensitivity === "UNCERTAIN") {
      return {
        ...chunk,
        publicationState: "SUPPRESSED" as const,
        redactionReasonCodes: [
          ...new Set([
            ...chunk.redactionReasonCodes,
            sensitivity === "SECRET"
              ? "semantic_secret"
              : "semantic_safety_uncertain"
          ])
        ].sort(),
        redactionState: "EXCLUDED" as const,
        safetyClass: "SECRET_TAINTED" as const
      };
    }
    if (sensitivity !== "NORMAL" && sensitivity !== "SENSITIVE") {
      throw new MemoryCoordinatorError("memory_history_classification_invalid", true);
    }
    return {
      ...chunk,
      publicationState: "ACTIVE" as const,
      safetyClass: "NORMAL" as const
    };
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
      classification.policyVersion,
      {
        checkpointMessages: plan.checkpointMessages,
        digest: null,
        digestPolicyVersion: null,
        incremental: plan.incremental,
        rebuiltChunkIds: plan.rebuiltChunkIds,
        reusedChunkIds: plan.reusedChunkIds,
        work: plan.work
      }
    )
  };
}

function attachMemoryChatDigest(
  plan: MemoryHistoryIndexPlan,
  generated: Awaited<ReturnType<MemoryChatDigestGenerator["generate"]>>,
  safety: MemoryHistoryClassificationResult | null
): MemoryHistoryIndexPlan {
  if (!generated.policyVersion || generated.policyVersion.length > 256) {
    throw new MemoryCoordinatorError("memory_chat_digest_invalid", true);
  }
  let digest = generated.digest;
  let digestPolicyVersion = generated.policyVersion;
  const work = {
    ...plan.work,
    digestSegmentsProcessed: generated.work.digestSegmentsProcessed,
    digestSourceChunksProcessed: generated.work.digestSourceChunksProcessed
  };
  if (digest) {
    if (generated.classificationRequired) {
      if (!safety || safety.decisions.length !== 1 ||
        safety.decisions[0]?.chunkId !== digest.id) {
        throw new MemoryCoordinatorError("memory_chat_digest_invalid", true);
      }
      digestPolicyVersion = `${generated.policyVersion}:${safety.policyVersion}`;
      if (safety.decisions[0].sensitivity === "SECRET" ||
        safety.decisions[0].sensitivity === "UNCERTAIN") digest = null;
    } else if (safety !== null) {
      throw new MemoryCoordinatorError("memory_chat_digest_invalid", true);
    }
  } else if (safety !== null) {
    throw new MemoryCoordinatorError("memory_chat_digest_invalid", true);
  }
  return {
    ...plan,
    digest,
    digestPolicyVersion,
    work,
    resultHash: memoryHistoryIndexResultHash(
      plan.source,
      plan.chunks,
      plan.suppressionIdentitySnapshot,
      plan.classificationPolicyVersion,
      {
        checkpointMessages: plan.checkpointMessages,
        digest,
        digestPolicyVersion,
        incremental: plan.incremental,
        rebuiltChunkIds: plan.rebuiltChunkIds,
        reusedChunkIds: plan.reusedChunkIds,
        work
      }
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

function historyOperationalCounters(
  plan: MemoryHistoryIndexPlan
): MemoryOperationalCounters {
  const digestNoop = plan.digest && plan.work.digestSegmentsProcessed === 0
    ? 1
    : 0;
  return Object.freeze({
    digestFullRebuild: plan.digest?.updateMode === "FULL_REBUILD" ? 1 : 0,
    digestIncremental: plan.digest?.updateMode === "INCREMENTAL" ? 1 : 0,
    digestNoop,
    digestSegmentsProcessed: plan.work.digestSegmentsProcessed,
    digestSourceChunksProcessed: plan.work.digestSourceChunksProcessed,
    historyChunksBuilt: plan.work.chunksBuilt,
    historyChunksReplaced: plan.work.chunksReplaced,
    historyChunksReused: plan.work.chunksReused,
    historyMessageContentRowsLoaded: plan.work.messageContentRowsLoaded,
    historyMessagesProjected: plan.work.messagesProjected,
    historyModelRunRowsLoaded: plan.work.modelRunRowsLoaded,
    historyPathMetadataRowsRead: plan.work.pathMetadataRowsRead
  });
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
          prepared.plan.chunks.filter((chunk) =>
            prepared.plan.rebuiltChunkIds.includes(chunk.id)),
          {
            execution: { jobId: claim.id, userId: claim.userId },
            signal: context.signal
          }
        );
        plan = applyMemoryHistoryClassifications(prepared.plan, classification);
        let executionResults = [...(classification.executions ?? [])];
        if (dependencies.digestGenerator) {
          await context.setStage("digest_generation");
          const generated = await dependencies.digestGenerator.generate(
            plan.source,
            plan.chunks,
            { jobId: claim.id, signal: context.signal, userId: claim.userId }
          );
          executionResults.push(...generated.executions);
          const digestSafety = generated.digest && generated.classificationRequired
            ? await dependencies.classifier.classify([{
                id: generated.digest.id,
                safeProjectedText: generated.digest.safeDigestText
              }], {
                execution: { jobId: claim.id, userId: claim.userId },
                signal: context.signal
              })
            : null;
          if (digestSafety) executionResults.push(...(digestSafety.executions ?? []));
          plan = attachMemoryChatDigest(plan, generated, digestSafety);
        } else {
          plan = attachMemoryChatDigest(plan, {
            classificationRequired: false,
            digest: null,
            executions: [],
            policyVersion: "memory-chat-digest-disabled",
            work: {
              digestSegmentsProcessed: 0,
              digestSourceChunksProcessed: 0
            }
          }, null);
        }
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
          operationalCounters: historyOperationalCounters(plan),
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
    digestGenerator?: MemoryChatDigestGenerator;
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
      probeAuthority: async (userId: string) => {
        await probeMemoryStructuredOutputAuthority({
          authority,
          client,
          role: "MEMORY_HISTORY_CLASSIFY",
          userId,
          versions: MEMORY_HISTORY_CLASSIFICATION_VERSIONS
        });
        await probeMemoryStructuredOutputAuthority({
          authority,
          client,
          role: "MEMORY_HISTORY_CLASSIFY",
          userId,
          versions: MEMORY_CHAT_DIGEST_VERSIONS
        });
      }
    } : {}),
    classifier: classifier ?? createPrismaMemoryHistorySafetyClassifier(client, {
      authority,
      provider: options.structuredProvider
    }),
    ...(options.digestGenerator
      ? { digestGenerator: options.digestGenerator }
      : governed
        ? {
            digestGenerator: createPrismaMemoryChatDigestGenerator(client, {
              authority,
              provider: options.structuredProvider
            })
          }
        : {}),
    repository: createPrismaMemoryHistoryIndexRepository(client)
  });
}
