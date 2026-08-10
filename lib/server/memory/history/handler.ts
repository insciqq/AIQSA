import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type {
  MemoryJobExecutionResult,
  MemoryJobHandler
} from "../coordinator/types";
import { memorySha256 } from "../persistence/lexical";
import {
  memoryHistoryIndexClaimIsValid,
  type MemoryHistoryIndexPlan
} from "./contract";
import {
  createPrismaMemoryHistoryIndexRepository,
  type MemoryHistoryIndexRepository
} from "./repository";

export type MemoryHistoryIndexHandlerDependencies = Readonly<{
  repository: MemoryHistoryIndexRepository;
}>;

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

    preflight(job) {
      if (!memoryHistoryIndexClaimIsValid(job)) {
        return Promise.resolve({
          errorCode: "memory_history_job_invalid",
          status: "CANCELLED" as const
        });
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
      await context.setStage("lexical_apply");
      const plan: MemoryHistoryIndexPlan = prepared.plan;
      return {
        acceptedResultHash: plan.resultHash,
        apply: (tx, acceptedClaim) => dependencies.repository.apply(
          tx,
          acceptedClaim,
          plan,
          context.now()
        ),
        stage: "lexical_ready"
      };
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
