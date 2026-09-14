import type { PrismaClient } from "@prisma/client";
import type { MemoryJobClaim, MemoryJobDescriptor, MemoryJobHandler } from "../../coordinator/types";
import {
  executeGovernedMemoryStructuredOutput,
  MemoryExecutionError,
  probeMemoryStructuredOutputAuthority,
  type MemoryExecutionAuthorityDependencies,
  type MemoryStructuredOutputProvider
} from "../../execution";
import { memoryExecutionSha256 } from "../../execution/canonical";
import { defaultMemoryExecutionAuthority } from "../../execution/defaultAuthority";
import { createAcceptedMemoryStructuredOutputProvider } from "../../execution/structuredClassifier";
import {
  MEMORY_EXPLICIT_RELATION_EXECUTION_ORDINAL,
  type MemoryExplicitRelationRetainedResult
} from "./explicitAuxiliary";
import {
  isMemoryExplicitRelationJob,
  MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
  type MemoryExplicitRelationSnapshot
} from "./explicitPolicy";
import { createMemoryExplicitRelationRecovery } from "./explicitRecovery";
import {
  createPrismaMemoryExplicitRelationRepository,
  type MemoryExplicitRelationRepository
} from "./explicitRepository";
import {
  buildMemoryExplicitRelationRequest,
  decodeMemoryExplicitRelationDecisions,
  MEMORY_EXPLICIT_RELATION_VERSIONS,
  memoryExplicitRelationInputHash
} from "./explicitResolver";

export type MemoryExplicitRelationHandlerDependencies = Readonly<{
  classify(
    job: MemoryJobClaim,
    snapshot: MemoryExplicitRelationSnapshot,
    signal: AbortSignal
  ): Promise<MemoryExplicitRelationRetainedResult>;
  probeAuthority(userId: string): Promise<void>;
  repository: MemoryExplicitRelationRepository;
}>;

function terminal(job: MemoryJobDescriptor, reason: string) {
  return {
    acceptedResultHash: memoryExecutionSha256({
      domain: "aiqsa.memory.explicit-relation-terminal", jobId: job.id,
      pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION, reason
    }),
    stage: reason
  };
}

export function createMemoryExplicitRelationHandler(
  deps: MemoryExplicitRelationHandlerDependencies
): MemoryJobHandler {
  return Object.freeze({
    kind: "RESOLVE_FACT_RELATIONS" as const,
    async preflight(job) {
      if (!isMemoryExplicitRelationJob(job)) {
        return { status: "CANCELLED", errorCode: "memory_explicit_relation_job_invalid" };
      }
      const decision = await deps.repository.preflight(job);
      if (decision.status !== "READY" || await deps.repository.loadResult(job)) return decision;
      try {
        await deps.probeAuthority(job.userId);
        return decision;
      } catch (error) {
        if (!(error instanceof MemoryExecutionError)) throw error;
        return {
          errorCode: error.code,
          status: ["memory_execution_target_unavailable", "memory_execution_capability_unavailable",
            "memory_execution_policy_unavailable"].includes(error.code)
            ? "WAITING_FOR_CONFIGURATION" as const : "CANCELLED" as const
        };
      }
    },
    async execute(job, context) {
      if (!isMemoryExplicitRelationJob(job)) return terminal(job, "explicit_relation_job_invalid");
      context.signal.throwIfAborted();
      let result = await deps.repository.loadResult(job);
      if (!result) {
        await context.setStage("explicit_relation_candidates");
        const snapshot = await deps.repository.prepare(job, context.now(), context.signal);
        if (!snapshot) return terminal(job, "explicit_relation_source_stale");
        if (snapshot.candidates.length === 0) return terminal(job, "explicit_relation_no_candidates");
        const reservation = await deps.repository.reserve(job, memoryExplicitRelationInputHash(snapshot), context.now());
        if (reservation.status === "UNAVAILABLE") return terminal(job, "explicit_relation_call_unavailable");
        if (reservation.status === "RECOVERED") {
          result = reservation.result;
        } else {
          await context.setStage("explicit_relation_compare");
          context.signal.throwIfAborted();
          result = await deps.classify(job, snapshot, context.signal);
        }
      }
      context.signal.throwIfAborted();
      const accepted = result;
      await context.setStage("explicit_relation_apply");
      return {
        acceptedResultHash: memoryExecutionSha256({
          domain: "aiqsa.memory.explicit-relation-result", jobId: job.id,
          result: accepted, pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION
        }),
        apply: (tx, claim) => deps.repository.apply(tx, claim, accepted, context.now()),
        stage: "explicit_relation_compared"
      };
    }
  });
}

export function createPrismaMemoryExplicitRelationHandler(
  client: PrismaClient,
  options: Readonly<{
    authority?: MemoryExecutionAuthorityDependencies;
    structuredProvider?: MemoryStructuredOutputProvider;
  }> = {}
): MemoryJobHandler {
  const authority = options.authority ?? defaultMemoryExecutionAuthority;
  const repository = createPrismaMemoryExplicitRelationRepository(client, authority);
  const provider = options.structuredProvider ?? createAcceptedMemoryStructuredOutputProvider(client);
  return createMemoryExplicitRelationHandler({
    repository,
    probeAuthority: (userId) => probeMemoryStructuredOutputAuthority({
      authority, client, role: "MEMORY_CONSOLIDATE", userId, versions: MEMORY_EXPLICIT_RELATION_VERSIONS
    }),
    async classify(job, snapshot, signal) {
      const result = await executeGovernedMemoryStructuredOutput({
        authority, client,
        decode: (output) => decodeMemoryExplicitRelationDecisions(output, snapshot),
        inputHash: memoryExplicitRelationInputHash(snapshot),
        ordinal: MEMORY_EXPLICIT_RELATION_EXECUTION_ORDINAL,
        owner: { memoryJobId: job.id, type: "JOB" },
        persistResult: (tx, output) => repository.persistResult(tx, job, snapshot, output),
        provider, request: buildMemoryExplicitRelationRequest(snapshot),
        role: "MEMORY_CONSOLIDATE", signal, userId: job.userId,
        versions: MEMORY_EXPLICIT_RELATION_VERSIONS
      });
      return {
        bindingId: result.bindingId,
        packet: createMemoryExplicitRelationRecovery(snapshot, result.value, result.acceptedOutputHash)
      };
    }
  });
}
