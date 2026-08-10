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
  MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION,
  MEMORY_EPISODE_EXTRACTION_VERSIONS,
  memoryEpisodeExtractionClaimIsValid,
  type MemoryEpisodeExtractionInput
} from "./contract";
import {
  decodeMemoryEpisodeExtraction,
  MemoryEpisodeDecodeError
} from "./decoder";
import {
  createPrismaMemoryEpisodeRepository,
  type MemoryEpisodeRepository
} from "./repository";
import {
  createAcceptedMemoryEpisodeProvider,
  memoryEpisodeProviderEvidence,
  MemoryEpisodeProviderCallError,
  type MemoryEpisodeProvider
} from "./runtime";

export type MemoryEpisodeExtractionHandlerDependencies = Readonly<{
  execution: PrismaMemoryExecutionService;
  now: () => Date;
  probeAuthority: (userId: string) => Promise<void>;
  provider: MemoryEpisodeProvider;
  repository: MemoryEpisodeRepository;
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
  input: MemoryEpisodeExtractionInput | null,
  reason: string,
  acceptedResultHash?: string
): MemoryJobExecutionResult {
  return {
    acceptedResultHash: acceptedResultHash ?? memoryExecutionSha256({
      domain: "aiqsa.memory.episode-local-terminal",
      inputHash: input?.inputHash ?? null,
      jobId: job.id,
      reason,
      version: 1
    }),
    stage: reason
  };
}

function maxOrdinal(
  bindings: Awaited<ReturnType<MemoryEpisodeRepository["bindings"]>>
): number {
  return bindings.reduce((maximum, binding) => Math.max(maximum, binding.ordinal), -1);
}

async function recoverPriorExecution(
  deps: MemoryEpisodeExtractionHandlerDependencies,
  job: MemoryJobDescriptor,
  input: MemoryEpisodeExtractionInput
): Promise<MemoryJobExecutionResult | null> {
  const bindings = await deps.repository.bindings(job.userId, job.id);
  if (bindings.some((binding) => binding.inputHash !== input.inputHash)) {
    throw new MemoryCoordinatorError("memory_episode_binding_stale", false);
  }
  const succeeded = bindings.find((binding) => binding.state === "SUCCEEDED");
  if (succeeded?.acceptedOutputHash) {
    if (await deps.repository.alreadyApplied(job, succeeded.id)) {
      return terminalResult(
        job,
        input,
        "episode_ready",
        succeeded.acceptedOutputHash
      );
    }
    await deps.repository.markDegraded(
      job,
      "memory_episode_result_unavailable",
      deps.now()
    );
    return terminalResult(
      job,
      input,
      "episode_result_unavailable",
      succeeded.acceptedOutputHash
    );
  }
  const uncertain = bindings.find((binding) =>
    binding.state === "RUNNING" || binding.state === "OUTCOME_UNKNOWN");
  if (uncertain) {
    if (uncertain.state === "RUNNING") {
      await deps.execution.lifecycle.settle(job.userId, uncertain.id, {
        acceptedOutputHash: null,
        errorCode: "memory_episode_recovered_uncertain",
        providerResponseId: null,
        state: "OUTCOME_UNKNOWN",
        usage: unavailableUsage
      });
    }
    await deps.repository.markDegraded(
      job,
      "memory_episode_outcome_unknown",
      deps.now()
    );
    return terminalResult(job, input, "episode_outcome_unknown");
  }
  for (const pending of bindings.filter((binding) => binding.state === "PENDING")) {
    await deps.execution.lifecycle.settle(job.userId, pending.id, {
      acceptedOutputHash: null,
      errorCode: "memory_episode_execution_abandoned",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
  }
  return null;
}

export function createMemoryEpisodeExtractionHandler(
  deps: MemoryEpisodeExtractionHandlerDependencies
): MemoryJobHandler {
  return Object.freeze({
    kind: "EXTRACT_EPISODE" as const,

    async preflight(job) {
      if (!memoryEpisodeExtractionClaimIsValid(job)) {
        return { errorCode: "memory_episode_job_invalid", status: "CANCELLED" };
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
      if (!memoryEpisodeExtractionClaimIsValid(job)) {
        return terminalResult(job, null, "episode_job_invalid");
      }
      await context.setStage("source_snapshot");
      const prepared = await deps.repository.prepare(job);
      if ("decision" in prepared) {
        return terminalResult(job, null, prepared.decision.errorCode);
      }
      const input = prepared.input;
      if (input.chunks.length === 0) {
        await deps.repository.markComplete(job, context.now());
        return terminalResult(job, input, "episode_empty_source");
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
        role: "MEMORY_EPISODE_EXTRACT",
        versions: MEMORY_EPISODE_EXTRACTION_VERSIONS
      });
      const started = await deps.execution.admission.start(job.userId, binding.id);
      if (
        started.snapshot.logicalRole !== "MEMORY_EPISODE_EXTRACT" ||
        !started.snapshot.requiresStrictStructuredOutput
      ) {
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: "memory_episode_binding_invalid",
          providerResponseId: null,
          state: "FAILED",
          usage: unavailableUsage
        });
        await deps.repository.markDegraded(
          job,
          "memory_episode_binding_invalid",
          deps.now()
        );
        return terminalResult(job, input, "episode_binding_invalid");
      }

      await context.setStage("provider_call");
      let result: Awaited<ReturnType<MemoryEpisodeProvider["run"]>>;
      try {
        result = await deps.provider.run(
          memoryEpisodeProviderEvidence(started.snapshot),
          input,
          context.signal
        );
      } catch (error) {
        const uncertain = error instanceof MemoryEpisodeProviderCallError;
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: uncertain
            ? "memory_episode_provider_outcome_unknown"
            : "memory_episode_provider_unavailable",
          providerResponseId: null,
          state: uncertain ? "OUTCOME_UNKNOWN" : "FAILED",
          usage: uncertain && error.usage ? reportedUsage(error.usage) : unavailableUsage
        });
        await deps.repository.markDegraded(
          job,
          uncertain
            ? "memory_episode_outcome_unknown"
            : "memory_episode_provider_unavailable",
          deps.now()
        );
        return terminalResult(
          job,
          input,
          uncertain ? "episode_outcome_unknown" : "episode_provider_unavailable"
        );
      }

      let plan;
      try {
        plan = decodeMemoryEpisodeExtraction(result.toolCalls, input);
      } catch (error) {
        const code = error instanceof MemoryEpisodeDecodeError
          ? error.code
          : "memory_episode_output_invalid";
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: code,
          providerResponseId: result.providerResponseId,
          state: "FAILED",
          usage: reportedUsage(result.usage)
        });
        await deps.repository.markDegraded(job, code, deps.now());
        return terminalResult(job, input, "episode_output_rejected");
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
          await deps.repository.markDegraded(
            job,
            "memory_episode_apply_stale",
            deps.now()
          );
          return terminalResult(
            job,
            input,
            "episode_apply_stale",
            plan.outputHash
          );
        }
      } catch {
        await deps.repository.markDegraded(
          job,
          "memory_episode_apply_rejected",
          deps.now()
        );
        return terminalResult(
          job,
          input,
          "episode_apply_rejected",
          plan.outputHash
        );
      }
      return {
        acceptedResultHash: plan.outputHash,
        stage: plan.episodes.length > 0 ? "episode_ready" : "episode_empty"
      };
    }
  });
}

export function createPrismaMemoryEpisodeExtractionHandler(
  authority: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma,
  options: Readonly<{
    provider?: MemoryEpisodeProvider;
    repository?: MemoryEpisodeRepository;
  }> = {}
): MemoryJobHandler {
  const now = () => memoryExecutionNow(authority);
  return createMemoryEpisodeExtractionHandler({
    execution: createPrismaMemoryExecutionService(authority, client),
    now,
    probeAuthority: (userId) => withLockedMemoryTransaction(
      client,
      userId,
      async (tx, settings) => {
        const resolved = await resolveCurrentMemoryExecutionAuthority(tx, settings, {
          dependencies: authority,
          now: now(),
          role: "MEMORY_EPISODE_EXTRACT",
          userId,
          versions: MEMORY_EPISODE_EXTRACTION_VERSIONS
        });
        const model = resolved.target.snapshot.model;
        if (
          model.adapterKind === "fake" || model.modelClass !== "answer" ||
          model.capabilities.toolCalling !== true
        ) throw new MemoryExecutionError("memory_execution_capability_unavailable");
      }
    ),
    provider: options.provider ?? createAcceptedMemoryEpisodeProvider(client),
    repository: options.repository ?? createPrismaMemoryEpisodeRepository(client)
  });
}

export { MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION };
