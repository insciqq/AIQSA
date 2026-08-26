import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../../prisma";
import type {
  MemoryJobDescriptor,
  MemoryJobExecutionResult,
  MemoryJobHandler
} from "../../coordinator/types";
import type {
  MemoryExecutionAuthorityDependencies,
  MemoryStructuredOutputProvider
} from "../../execution";
import { memoryExecutionSha256 } from "../../execution/canonical";
import type { LockedMemorySettings } from "../../persistence/transaction";
import {
  decideMemoryFactRelation,
  MEMORY_FACT_RELATION_PIPELINE_VERSION
} from "./policy";
import {
  createPrismaMemoryRelationRepository,
  type MemoryRelationRepository
} from "./repository";
import type { MemoryRelationProvider } from "./resolver";

type AuthorizedRelationResult = Readonly<{
  acceptedOutputHash: string;
  bindingId: string;
  inputHash: string;
  modelId: string;
  policyVersion: string;
  providerId: string;
}>;

const terminalConflictReasons = new Set([
  "relation_correction_target_stale",
  "relation_current_ineligible",
  "relation_current_missing",
  "relation_current_stale"
]);

export type MemoryRelationHandlerDependencies = Readonly<{
  authorizeResult?: (
    tx: Prisma.TransactionClient,
    settings: LockedMemorySettings,
    userId: string,
    jobId: string,
    result: AuthorizedRelationResult
  ) => Promise<void>;
  clock?: () => Date;
  probeAuthority?: (userId: string) => Promise<void>;
  provider?: MemoryRelationProvider;
  repository: MemoryRelationRepository;
}>;

function terminalResult(
  job: MemoryJobDescriptor,
  reason: string,
  snapshotHash: string | null = null
): MemoryJobExecutionResult {
  return {
    acceptedResultHash: memoryExecutionSha256({
      domain: "aiqsa.memory.fact-relation-terminal",
      jobId: job.id,
      reason,
      snapshotHash,
      version: 2
    }),
    stage: reason
  };
}

export function createMemoryRelationHandler(
  deps: MemoryRelationHandlerDependencies
): MemoryJobHandler {
  return Object.freeze({
    kind: "RESOLVE_FACT_RELATIONS" as const,

    async preflight(job) {
      return deps.repository.preflight(job);
    },

    async execute(job, context) {
      if (job.kind !== "RESOLVE_FACT_RELATIONS" ||
        job.pipelineVersion !== MEMORY_FACT_RELATION_PIPELINE_VERSION ||
        job.targetFactVersionId === null) {
        return terminalResult(job, "relation_job_invalid");
      }
      await context.setStage("relation_snapshot");
      const prepared = await deps.repository.prepare(job, context.now());
      if (prepared.status !== "READY") {
        const result = terminalResult(job, prepared.reason);
        return terminalConflictReasons.has(prepared.reason)
          ? {
              ...result,
              apply: (tx, claim) => deps.repository.settleTerminal(
                tx,
                claim,
                prepared.reason,
                context.now()
              )
            }
          : result;
      }
      const { snapshot, snapshotHash } = prepared.prepared;
      let decision = decideMemoryFactRelation(snapshot, context.now());
      if (decision.operation === "AMBIGUOUS") {
        decision = {
          confidence: 0,
          operation: "CONFLICT",
          reasonCode: "semantic_adjudication_missing",
          targetVersionId: snapshot.current.versionId
        };
      }
      const acceptedResultHash = memoryExecutionSha256({
        decision,
        domain: "aiqsa.memory.fact-relation",
        executionId: null,
        jobId: job.id,
        pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION,
        snapshotHash
      });
      await context.setStage("relation_authorized_apply");
      return {
        acceptedResultHash,
        apply: async (tx, claim) => {
          await deps.repository.apply(tx, claim, {
            decision,
            executionId: null,
            expectedSnapshotHash: snapshotHash
          }, context.now());
        },
        stage: `relation_${decision.operation.toLocaleLowerCase("en-US")}`
      };
    }
  });
}

export function createPrismaMemoryRelationHandler(
  client: PrismaClient = prisma,
  options: Readonly<{
    authority?: MemoryExecutionAuthorityDependencies;
    provider?: MemoryRelationProvider;
    repository?: MemoryRelationRepository;
    structuredProvider?: MemoryStructuredOutputProvider;
  }> = {}
): MemoryJobHandler {
  return createMemoryRelationHandler({
    provider: options.provider,
    repository: options.repository ?? createPrismaMemoryRelationRepository(client)
  });
}
