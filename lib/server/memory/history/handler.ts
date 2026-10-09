import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { logEvent } from "../../observability";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type {
  MemoryJobExecutionResult,
  MemoryJobHandler
} from "../coordinator/types";
import { memorySha256 } from "../persistence/lexical";
import type { MemoryOperationalCounters } from "../operational/counters";
import { MEMORY_SAFETY_LITE_POLICY_VERSION } from "../safetyLite";
import {
  memoryHistoryIndexClaimIsValid,
  memoryHistoryIndexPlanIsPartial,
  memoryHistoryIndexResultHash,
  type MemoryHistoryIndexPlan
} from "./contract";
import {
  createPrismaMemoryHistoryIndexRepository,
  MEMORY_HISTORY_MESSAGE_TRUNCATED_CODE,
  type MemoryHistoryIndexRepository
} from "./repository";

export type MemoryHistoryIndexHandlerDependencies = Readonly<{
  repository: MemoryHistoryIndexRepository;
}>;

/** History indexing makes no model calls. Safety Lite already redacted every
 * recognized secret span when the plan was projected, so every rebuilt chunk
 * publishes as NORMAL; a round follows its parent chunk, which keeps a
 * SUPPRESSED state recorded by an earlier classifier. */
export function applyMemoryHistorySafetyLite(
  plan: MemoryHistoryIndexPlan
): MemoryHistoryIndexPlan {
  const rebuilt = new Set(plan.rebuiltChunkIds);
  if (plan.chunks.filter((chunk) => rebuilt.has(chunk.id)).length !== rebuilt.size) {
    throw new MemoryCoordinatorError("memory_history_classification_invalid", true);
  }
  const chunks = plan.chunks.map((chunk) => rebuilt.has(chunk.id)
    ? { ...chunk, publicationState: "ACTIVE" as const, safetyClass: "NORMAL" as const }
    : chunk);
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk] as const));
  const rounds = plan.rounds.map((round) => {
    const parent = chunksById.get(round.parentChunkId);
    if (!parent) {
      throw new MemoryCoordinatorError("memory_history_classification_invalid", true);
    }
    return parent.publicationState === "SUPPRESSED"
      ? {
          ...round,
          publicationState: "SUPPRESSED" as const,
          redactionReasonCodes: parent.redactionReasonCodes,
          redactionState: "EXCLUDED" as const,
          safetyClass: "SECRET_TAINTED" as const
        }
      : {
          ...round,
          publicationState: "ACTIVE" as const,
          safetyClass: "NORMAL" as const
        };
  });
  return {
    ...plan,
    classificationPolicyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION,
    chunks,
    rounds,
    preparedResultHash: plan.resultHash,
    resultHash: memoryHistoryIndexResultHash(
      plan.source,
      chunks,
      plan.suppressionIdentitySnapshot,
      MEMORY_SAFETY_LITE_POLICY_VERSION,
      plan.timeZone,
      {
        checkpointMessages: plan.checkpointMessages,
        incremental: plan.incremental,
        rebuiltChunkIds: plan.rebuiltChunkIds,
        rebuiltRoundIds: plan.rebuiltRoundIds,
        reusedChunkIds: plan.reusedChunkIds,
        reusedRoundIds: plan.reusedRoundIds,
        rounds,
        toolEvents: plan.toolEvents,
        work: plan.work
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
  return Object.freeze({
    historyChunksBuilt: plan.work.chunksBuilt,
    historyChunksReplaced: plan.work.chunksReplaced,
    historyChunksReused: plan.work.chunksReused,
    historyMessageContentRowsLoaded: plan.work.messageContentRowsLoaded,
    historyMessagesProjected: plan.work.messagesProjected,
    historyModelRunRowsLoaded: plan.work.modelRunRowsLoaded,
    historyPathMetadataRowsRead: plan.work.pathMetadataRowsRead,
    historyRoundSegmentsBuilt: plan.work.roundSegmentsBuilt,
    historyRoundSegmentsReplaced: plan.work.roundSegmentsReplaced,
    historyRoundSegmentsReused: plan.work.roundSegmentsReused,
    historyRoundsBuilt: plan.work.roundsBuilt,
    historyRoundsReplaced: plan.work.roundsReplaced,
    historyRoundsReused: plan.work.roundsReused
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
      return dependencies.repository.preflight(job);
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
      try {
        const plan = applyMemoryHistorySafetyLite(prepared.plan);
        await context.setStage("lexical_apply");
        const truncated = (plan.incremental.truncatedMessageIds?.length ?? 0) > 0;
        if (truncated) {
          logEvent("service_operation", { subsystem: "memory", stage: "validate", outcome: "degraded",
            job_id: claim.id, code: MEMORY_HISTORY_MESSAGE_TRUNCATED_CODE, action: "degrade",
            count: plan.incremental.truncatedMessageIds?.length ?? 0 });
        }
        return {
          acceptedResultHash: plan.resultHash,
          // A partial page returns its job to the queue for the next page.
          apply: (tx, acceptedClaim) => dependencies.repository.apply(
            tx,
            acceptedClaim,
            plan,
            context.now()
          ),
          operationalCounters: historyOperationalCounters(plan),
          stage: truncated
            ? "lexical_ready:history_message_truncated"
            : memoryHistoryIndexPlanIsPartial(plan)
              ? "lexical_ready:history_page_partial"
              : "lexical_ready"
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
  client: PrismaClient = prisma
): MemoryJobHandler {
  return createMemoryHistoryIndexHandler({
    repository: createPrismaMemoryHistoryIndexRepository(client)
  });
}
