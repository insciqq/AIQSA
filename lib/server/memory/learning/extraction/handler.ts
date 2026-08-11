import type { PrismaClient } from "@prisma/client";
import { normalizeTokenUsage } from "../../../../domain/usage";
import { prisma } from "../../../prisma";
import { MemoryCoordinatorError } from "../../coordinator/errors";
import type {
  MemoryJobDescriptor,
  MemoryJobExecutionResult,
  MemoryJobHandler
} from "../../coordinator/types";
import {
  createPrismaMemoryExecutionService,
  memoryExecutionNow,
  MemoryExecutionError,
  resolveCurrentMemoryExecutionAuthority,
  type MemoryExecutionAuthorityDependencies,
  type MemoryReportedUsage,
  type PrismaMemoryExecutionService
} from "../../execution";
import { memoryExecutionSha256 } from "../../execution/canonical";
import { withLockedMemoryTransaction } from "../../persistence/transaction";
import {
  MEMORY_FACT_EXTRACTION_VERSIONS,
  memoryFactExtractionClaimIsValid,
  type MemoryFactExtractionInput
} from "./contract";
import {
  decodeMemoryFactExtraction,
  MemoryFactDecodeError
} from "./decoder";
import {
  createPrismaMemoryFactExtractionRepository,
  type MemoryFactExtractionRepository
} from "./repository";
import {
  createAcceptedMemoryFactProvider,
  memoryFactProviderEvidence,
  MemoryFactProviderCallError,
  type MemoryFactProvider
} from "./runtime";

export type MemoryFactExtractionHandlerDependencies = Readonly<{
  execution: PrismaMemoryExecutionService;
  now: () => Date;
  probeAuthority: (userId: string) => Promise<void>;
  provider: MemoryFactProvider;
  repository: MemoryFactExtractionRepository;
}>;

const unavailableUsage: MemoryReportedUsage = Object.freeze({
  cachedInputTokens: null,
  completeness: "UNAVAILABLE",
  estimatedCostMicros: null,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  totalTokens: null
});

function reportedUsage(value: Parameters<typeof normalizeTokenUsage>[0]): MemoryReportedUsage {
  const usage = normalizeTokenUsage(value);
  const estimated = "estimatedCostMicros" in value
    ? value.estimatedCostMicros
    : null;
  return {
    cachedInputTokens: usage.cachedInputTokens,
    completeness: "COMPLETE",
    estimatedCostMicros: typeof estimated === "number" &&
      Number.isSafeInteger(estimated) && estimated >= 0 ? estimated : null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens
  };
}

function authorityGate(error: unknown) {
  if (error instanceof MemoryExecutionError) {
    if (
      error.code === "memory_execution_egress_consent_required" ||
      error.code === "memory_execution_qualification_required" ||
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

function terminalResult(
  job: MemoryJobDescriptor,
  input: MemoryFactExtractionInput | null,
  reason: string,
  acceptedResultHash?: string
): MemoryJobExecutionResult {
  return {
    acceptedResultHash: acceptedResultHash ?? memoryExecutionSha256({
      domain: "aiqsa.memory.fact-local-terminal",
      inputHash: input?.inputHash ?? null,
      jobId: job.id,
      reason,
      version: 1
    }),
    stage: reason
  };
}

function maxOrdinal(
  bindings: Awaited<ReturnType<MemoryFactExtractionRepository["bindings"]>>
): number {
  return bindings.reduce((maximum, binding) => Math.max(maximum, binding.ordinal), -1);
}

async function recoverPriorExecution(
  deps: MemoryFactExtractionHandlerDependencies,
  job: MemoryJobDescriptor,
  input: MemoryFactExtractionInput
): Promise<MemoryJobExecutionResult | null> {
  const bindings = await deps.repository.bindings(job.userId, job.id);
  if (bindings.some((binding) => binding.inputHash !== input.inputHash)) {
    throw new MemoryCoordinatorError("memory_fact_binding_stale", false);
  }
  const succeeded = bindings.find((binding) => binding.state === "SUCCEEDED");
  if (succeeded?.acceptedOutputHash) {
    return terminalResult(
      job,
      input,
      await deps.repository.applied(job, succeeded.id)
        ? "fact_candidates_ready"
        : "fact_result_unavailable",
      succeeded.acceptedOutputHash
    );
  }
  const uncertain = bindings.find((binding) =>
    binding.state === "RUNNING" || binding.state === "OUTCOME_UNKNOWN");
  if (uncertain) {
    if (uncertain.state === "RUNNING") {
      await deps.execution.lifecycle.settle(job.userId, uncertain.id, {
        acceptedOutputHash: null,
        errorCode: "memory_fact_recovered_uncertain",
        providerResponseId: null,
        state: "OUTCOME_UNKNOWN",
        usage: unavailableUsage
      });
    }
    return terminalResult(job, input, "fact_outcome_unknown");
  }
  for (const pending of bindings.filter((binding) => binding.state === "PENDING")) {
    await deps.execution.lifecycle.settle(job.userId, pending.id, {
      acceptedOutputHash: null,
      errorCode: "memory_fact_execution_abandoned",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
  }
  return null;
}

export function createMemoryFactExtractionHandler(
  deps: MemoryFactExtractionHandlerDependencies
): MemoryJobHandler {
  return Object.freeze({
    kind: "EXTRACT_FACTS" as const,

    async preflight(job) {
      if (!memoryFactExtractionClaimIsValid(job)) {
        return { errorCode: "memory_fact_job_invalid", status: "CANCELLED" };
      }
      const sourceDecision = await deps.repository.preflight(job);
      if (sourceDecision.status !== "READY") return sourceDecision;
      try {
        await deps.probeAuthority(job.userId);
        return { status: "READY" };
      } catch (error) {
        return authorityGate(error);
      }
    },

    async execute(job, context) {
      if (!memoryFactExtractionClaimIsValid(job)) {
        return terminalResult(job, null, "fact_job_invalid");
      }
      await context.setStage("source_snapshot");
      const prepared = await deps.repository.prepare(job);
      if ("decision" in prepared) {
        return terminalResult(job, null, prepared.decision.errorCode);
      }
      const input = prepared.input;
      if (input.messages.length === 0) {
        return terminalResult(job, input, "fact_empty_safe_source");
      }
      const recovered = await recoverPriorExecution(deps, job, input);
      if (recovered) return recovered;
      await deps.probeAuthority(job.userId).catch((error: unknown) => {
        const decision = authorityGate(error);
        throw new MemoryCoordinatorError(decision.errorCode, true);
      });
      const priorBindings = await deps.repository.bindings(job.userId, job.id);

      await context.setStage("binding");
      const binding = await deps.execution.admission.bind(job.userId, {
        inputHash: input.inputHash,
        ordinal: maxOrdinal(priorBindings) + 1,
        owner: { memoryJobId: job.id, type: "JOB" },
        role: "MEMORY_FACT_EXTRACT",
        versions: MEMORY_FACT_EXTRACTION_VERSIONS
      });
      const started = await deps.execution.admission.start(job.userId, binding.id);
      if (
        started.snapshot.logicalRole !== "MEMORY_FACT_EXTRACT" ||
        !started.snapshot.requiresStrictStructuredOutput
      ) {
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: "memory_fact_binding_invalid",
          providerResponseId: null,
          state: "FAILED",
          usage: unavailableUsage
        });
        return terminalResult(job, input, "fact_binding_invalid");
      }

      await context.setStage("provider_call");
      let result: Awaited<ReturnType<MemoryFactProvider["run"]>>;
      try {
        result = await deps.provider.run(
          memoryFactProviderEvidence(started.snapshot),
          input,
          context.signal
        );
      } catch (error) {
        const uncertain = error instanceof MemoryFactProviderCallError;
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: uncertain
            ? "memory_fact_provider_outcome_unknown"
            : "memory_fact_provider_unavailable",
          providerResponseId: null,
          state: uncertain ? "OUTCOME_UNKNOWN" : "FAILED",
          usage: uncertain && error.usage ? reportedUsage(error.usage) : unavailableUsage
        });
        return terminalResult(
          job,
          input,
          uncertain ? "fact_outcome_unknown" : "fact_provider_unavailable"
        );
      }

      let plan;
      try {
        plan = decodeMemoryFactExtraction(result.toolCalls, input);
      } catch (error) {
        const code = error instanceof MemoryFactDecodeError
          ? error.code
          : "memory_fact_output_invalid";
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: code,
          providerResponseId: result.providerResponseId,
          state: "FAILED",
          usage: reportedUsage(result.usage)
        });
        return terminalResult(job, input, "fact_output_rejected");
      }

      await deps.execution.lifecycle.settle(job.userId, binding.id, {
        acceptedOutputHash: plan.outputHash,
        errorCode: null,
        providerResponseId: result.providerResponseId,
        state: "SUCCEEDED",
        usage: reportedUsage(result.usage)
      });
      await context.setStage("authorized_apply");
      try {
        const applied = await deps.execution.lifecycle.withAuthorizedResultCommit(
          job.userId,
          { acceptedOutputHash: plan.outputHash, bindingId: binding.id },
          (tx, evidence) => deps.repository.apply(
            tx,
            evidence.settings,
            job,
            plan,
            binding.id,
            context.now()
          )
        );
        if (applied === "STALE") {
          return terminalResult(job, input, "fact_apply_stale", plan.outputHash);
        }
      } catch {
        return terminalResult(job, input, "fact_apply_rejected", plan.outputHash);
      }
      return {
        acceptedResultHash: plan.outputHash,
        stage: plan.candidates.length > 0
          ? "fact_candidates_ready"
          : "fact_candidates_empty"
      };
    }
  });
}

export function createPrismaMemoryFactExtractionHandler(
  authority: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma,
  options: Readonly<{
    provider?: MemoryFactProvider;
    repository?: MemoryFactExtractionRepository;
  }> = {}
): MemoryJobHandler {
  const now = () => memoryExecutionNow(authority);
  return createMemoryFactExtractionHandler({
    execution: createPrismaMemoryExecutionService(authority, client),
    now,
    probeAuthority: (userId) => withLockedMemoryTransaction(
      client,
      userId,
      async (tx, settings) => {
        const resolved = await resolveCurrentMemoryExecutionAuthority(tx, settings, {
          dependencies: authority,
          now: now(),
          role: "MEMORY_FACT_EXTRACT",
          userId,
          versions: MEMORY_FACT_EXTRACTION_VERSIONS
        });
        const model = resolved.target.snapshot.model;
        if (
          model.adapterKind === "fake" || model.modelClass !== "answer" ||
          model.capabilities.toolCalling !== true
        ) throw new MemoryExecutionError("memory_execution_capability_unavailable");
      }
    ),
    provider: options.provider ?? createAcceptedMemoryFactProvider(client),
    repository: options.repository ?? createPrismaMemoryFactExtractionRepository(client)
  });
}
