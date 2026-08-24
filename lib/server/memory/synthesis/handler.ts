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
import { lockMemorySettings } from "../persistence/transaction";
import { MEMORY_SYNTHESIS_PIPELINE_VERSION } from "./policy";
import {
  createPrismaMemorySynthesisProvider,
  memorySynthesisAcceptedOutputHash,
  memorySynthesisInputHash,
  MEMORY_SYNTHESIS_VERSIONS,
  type MemorySynthesisProvider
} from "./provider";
import {
  createPrismaMemorySynthesisRepository,
  type MemorySynthesisRepository
} from "./repository";

export type MemorySynthesisHandlerDependencies = Readonly<{
  authorizeResult?: (
    tx: Prisma.TransactionClient,
    userId: string,
    jobId: string,
    result: Readonly<{
      acceptedOutputHash: string;
      executionId: string;
      inputHash: string;
      modelId: string;
      policyVersion: string;
      providerId: string;
    }>
  ) => Promise<void>;
  probeAuthority?: (userId: string) => Promise<void>;
  provider: MemorySynthesisProvider;
  repository: MemorySynthesisRepository;
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

function validJob(job: MemoryJobDescriptor): boolean {
  return job.kind === "SYNTHESIZE_MEMORIES" &&
    job.pipelineVersion === MEMORY_SYNTHESIS_PIPELINE_VERSION &&
    job.chatId === null && job.sourceMessageId === null &&
    job.targetFactVersionId === null && job.activeLeafMessageId === null &&
    job.branchGeneration === null && job.sourceRevision === null &&
    job.sourceHash === null;
}

function terminalResult(
  job: MemoryJobDescriptor,
  reason: string,
  inputHash: string | null = null
): MemoryJobExecutionResult {
  return {
    acceptedResultHash: memoryExecutionSha256({
      domain: "aiqsa.memory.synthesis-terminal",
      inputHash,
      jobId: job.id,
      reason,
      version: 1
    }),
    stage: reason
  };
}

export function createMemorySynthesisHandler(
  deps: MemorySynthesisHandlerDependencies
): MemoryJobHandler {
  return Object.freeze({
    kind: "SYNTHESIZE_MEMORIES" as const,

    async preflight(job) {
      if (!validJob(job)) {
        return { errorCode: "memory_synthesis_job_invalid", status: "CANCELLED" };
      }
      const decision = await deps.repository.preflight(job);
      if (decision.status !== "READY" || !deps.probeAuthority) return decision;
      try {
        await deps.probeAuthority(job.userId);
        return decision;
      } catch (error) {
        return authorityGate(error);
      }
    },

    async execute(job, context) {
      if (!validJob(job)) return terminalResult(job, "synthesis_job_invalid");
      await context.setStage("source_snapshot");
      const snapshot = await deps.repository.snapshot(job);
      const plan = snapshot?.plan;
      if (!plan) return terminalResult(job, "synthesis_source_stale");
      const inputHash = memorySynthesisInputHash(plan);
      const staged = await deps.repository.staged(job, plan, inputHash);
      if (staged) {
        const applyAt = context.now();
        return {
          acceptedResultHash: staged.acceptedOutputHash,
          apply: async (tx, claim) => {
            await deps.authorizeResult?.(tx, claim.userId, claim.id, staged);
            if (!deps.authorizeResult) {
              throw new Error("memory_synthesis_authority_missing");
            }
            await deps.repository.apply(tx, claim, plan, staged, applyAt);
          },
          stage: "authorized_apply"
        };
      }
      if (job.recoveredLease) {
        return terminalResult(job, "synthesis_outcome_unknown", inputHash);
      }

      await context.setStage("provider_call");
      let result: Awaited<ReturnType<MemorySynthesisProvider["synthesize"]>>;
      try {
        result = await deps.provider.synthesize(plan, context.signal, {
          jobId: job.id,
          userId: job.userId
        });
      } catch (error) {
        if (context.signal.aborted) {
          throw new MemoryCoordinatorError("memory_synthesis_cancelled", false);
        }
        throw new MemoryCoordinatorError(
          error instanceof Error && error.message === "memory_synthesis_output_invalid"
            ? "memory_synthesis_output_invalid"
            : "memory_synthesis_provider_unavailable",
          false
        );
      }
      if (
        result.inputHash !== inputHash ||
        result.acceptedOutputHash !== memorySynthesisAcceptedOutputHash(
          inputHash,
          result.output
        )
      ) {
        throw new MemoryCoordinatorError("memory_synthesis_output_invalid", false);
      }
      await context.setStage("durable_output");
      await deps.repository.stage(job, plan, result);
      const applyAt = context.now();
      return {
        acceptedResultHash: result.acceptedOutputHash,
        apply: async (tx, claim) => {
          if (!deps.authorizeResult) {
            throw new Error("memory_synthesis_authority_missing");
          }
          await deps.authorizeResult(tx, claim.userId, claim.id, result);
          await deps.repository.apply(tx, claim, plan, result, applyAt);
        },
        stage: "authorized_apply"
      };
    }
  });
}

export function createPrismaMemorySynthesisHandler(
  client: PrismaClient = prisma,
  options: Readonly<{
    authority?: MemoryExecutionAuthorityDependencies;
    provider?: MemorySynthesisProvider;
    repository?: MemorySynthesisRepository;
    structuredProvider?: MemoryStructuredOutputProvider;
  }> = {}
): MemoryJobHandler {
  const authority = options.authority ?? defaultMemoryExecutionAuthority;
  return createMemorySynthesisHandler({
    authorizeResult: async (tx, userId, jobId, result) => {
      const settings = await lockMemorySettings(tx, userId, true);
      const evidence = await authorizeMemoryExecutionResultsForCommit(
        authority,
        tx,
        settings,
        userId,
        { memoryJobId: jobId, role: "MEMORY_SYNTHESIZE" },
        [{
          acceptedOutputHash: result.acceptedOutputHash,
          bindingId: result.executionId,
          inputHash: result.inputHash
        }]
      );
      const authorized = evidence[0];
      if (
        evidence.length !== 1 || !authorized ||
        authorized.bindingId !== result.executionId ||
        authorized.modelId !== result.modelId ||
        authorized.policyVersion !== result.policyVersion ||
        authorized.providerId !== result.providerId
      ) {
        throw new Error("memory_synthesis_authority_mismatch");
      }
    },
    probeAuthority: (userId) => probeMemoryStructuredOutputAuthority({
      authority,
      client,
      role: "MEMORY_SYNTHESIZE",
      userId,
      versions: MEMORY_SYNTHESIS_VERSIONS
    }),
    provider: options.provider ?? createPrismaMemorySynthesisProvider(client, {
      authority,
      provider: options.structuredProvider
    }),
    repository: options.repository ?? createPrismaMemorySynthesisRepository(client)
  });
}
