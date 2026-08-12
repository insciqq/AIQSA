import type { PrismaClient } from "@prisma/client";
import { normalizeTokenUsage } from "../../../domain/usage";
import { prisma } from "../../prisma";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type { MemoryJobHandler } from "../coordinator/types";
import {
  createPrismaMemoryExecutionService,
  memoryExecutionNow,
  MemoryExecutionError,
  resolveCurrentMemoryExecutionAuthority,
  type MemoryExecutionAuthorityDependencies,
  type MemoryReportedUsage,
  type PrismaMemoryExecutionService
} from "../execution";
import { memoryExecutionSha256 } from "../execution/canonical";
import { MEMORY_PHASE7_CAPABILITY_POLICY } from "../capabilityPolicy";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import {
  MEMORY_PROFILE_JOB_PREFIX,
  MEMORY_PROFILE_VERSIONS,
  memoryProfileAsOf,
  memoryProfileClaimIsValid,
  memoryWorkingSetSweepClaimIsValid
} from "./contract";
import { decodeMemoryProfile, MemoryProfileDecodeError } from "./decoder";
import {
  createPrismaMemoryProfileRepository,
  type MemoryProfileExecutionBinding,
  type MemoryProfileRepository
} from "./repository";
import {
  createAcceptedMemoryProfileProvider,
  memoryProfileProviderEvidence,
  MemoryProfileProviderCallError,
  type MemoryProfileProvider
} from "./runtime";

export type MemoryWorkingSetProfileHandlerDependencies = Readonly<{
  execution: PrismaMemoryExecutionService;
  now: () => Date;
  profileEnabled?: boolean;
  probeAuthority: (userId: string) => Promise<void>;
  provider: MemoryProfileProvider;
  repository: MemoryProfileRepository;
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
  const estimated = "estimatedCostMicros" in value ? value.estimatedCostMicros : null;
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
    ) return { errorCode: error.code, status: "WAITING_FOR_EGRESS_CONSENT" as const };
    return { errorCode: error.code, status: "CANCELLED" as const };
  }
  throw error;
}

function terminalHash(jobId: string, inputHash: string | null, reason: string): string {
  return memoryExecutionSha256({
    domain: "aiqsa.memory.working-set-profile-terminal",
    inputHash,
    jobId,
    reason,
    version: 1
  });
}

function maxOrdinal(bindings: readonly MemoryProfileExecutionBinding[]): number {
  return bindings.reduce((maximum, binding) => Math.max(maximum, binding.ordinal), -1);
}

async function recoverBinding(
  execution: PrismaMemoryExecutionService,
  userId: string,
  inputHash: string,
  bindings: readonly MemoryProfileExecutionBinding[]
): Promise<"SUCCEEDED" | "UNCERTAIN" | null> {
  if (bindings.some((binding) => binding.inputHash !== inputHash)) {
    throw new MemoryCoordinatorError("memory_profile_binding_stale", false);
  }
  if (bindings.some((binding) => binding.state === "SUCCEEDED")) return "SUCCEEDED";
  const uncertain = bindings.find((binding) =>
    binding.state === "RUNNING" || binding.state === "OUTCOME_UNKNOWN");
  if (uncertain) {
    if (uncertain.state === "RUNNING") {
      await execution.lifecycle.settle(userId, uncertain.id, {
        acceptedOutputHash: null,
        errorCode: "memory_profile_recovered_uncertain",
        providerResponseId: null,
        state: "OUTCOME_UNKNOWN",
        usage: unavailableUsage
      });
    }
    return "UNCERTAIN";
  }
  for (const pending of bindings.filter((binding) => binding.state === "PENDING")) {
    await execution.lifecycle.settle(userId, pending.id, {
      acceptedOutputHash: null,
      errorCode: "memory_profile_execution_abandoned",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
  }
  return null;
}

function providerFailure(error: unknown): Readonly<{
  code: string;
  state: "FAILED" | "OUTCOME_UNKNOWN";
  usage: MemoryReportedUsage;
}> {
  const uncertain = error instanceof MemoryProfileProviderCallError;
  return {
    code: uncertain
      ? "memory_profile_provider_outcome_unknown"
      : "memory_profile_provider_unavailable",
    state: uncertain ? "OUTCOME_UNKNOWN" : "FAILED",
    usage: uncertain && error.usage ? reportedUsage(error.usage) : unavailableUsage
  };
}

export function createMemoryWorkingSetProfileHandler(
  deps: MemoryWorkingSetProfileHandlerDependencies
): MemoryJobHandler {
  return Object.freeze({
    kind: "RECALCULATE_WORKING_SET" as const,

    async preflight(job) {
      if (job.idempotencyFingerprint.startsWith(MEMORY_PROFILE_JOB_PREFIX)) {
        if (!memoryProfileClaimIsValid(job)) {
          return { errorCode: "memory_profile_job_invalid", status: "CANCELLED" };
        }
        if (deps.profileEnabled === false) {
          return {
            errorCode: "memory_profile_capability_disabled",
            status: "CANCELLED"
          };
        }
        const asOf = memoryProfileAsOf(deps.now());
        const decision = await deps.repository.preflightProfile(job, asOf);
        if (decision.status !== "READY") return decision;
        try {
          await deps.probeAuthority(job.userId);
          return { status: "READY" };
        } catch (error) {
          return authorityGate(error);
        }
      }
      if (!memoryWorkingSetSweepClaimIsValid(job)) {
        return { errorCode: "memory_working_set_job_invalid", status: "CANCELLED" };
      }
      return deps.repository.preflightSweep(job);
    },

    async execute(job, context) {
      const asOf = memoryProfileAsOf(context.now());
      if (memoryWorkingSetSweepClaimIsValid(job)) {
        const resultHash = memoryExecutionSha256({
          asOf: asOf.toISOString(),
          domain: "aiqsa.memory.working-set-sweep",
          jobId: job.id,
          version: 1
        });
        await context.setStage("working_set_apply");
        return {
          acceptedResultHash: resultHash,
          apply: (tx, claim) => deps.repository.applySweep(
            tx,
            claim,
            asOf,
            context.now()
          ),
          stage: "working_set_applied"
        };
      }
      if (!memoryProfileClaimIsValid(job)) {
        return {
          acceptedResultHash: terminalHash(job.id, null, "profile_job_invalid"),
          stage: "profile_job_invalid"
        };
      }
      if (deps.profileEnabled === false) {
        return {
          acceptedResultHash: terminalHash(
            job.id,
            null,
            "profile_capability_disabled"
          ),
          stage: "profile_capability_disabled"
        };
      }
      await context.setStage("profile_snapshot");
      const prepared = await deps.repository.prepareProfile(job, asOf);
      if ("decision" in prepared) {
        return {
          acceptedResultHash: terminalHash(job.id, null, prepared.decision.errorCode),
          stage: "profile_omitted"
        };
      }
      const input = prepared.input;
      const prior = await deps.repository.bindings(job.userId, job.id);
      const recovered = await recoverBinding(deps.execution, job.userId, input.inputHash, prior);
      if (recovered) {
        return {
          acceptedResultHash: terminalHash(
            job.id,
            input.inputHash,
            recovered === "SUCCEEDED"
              ? "profile_result_unavailable"
              : "profile_outcome_unknown"
          ),
          stage: "profile_omitted"
        };
      }
      await deps.probeAuthority(job.userId).catch((error) => {
        const decision = authorityGate(error);
        throw new MemoryCoordinatorError(decision.errorCode, true);
      });
      await context.setStage("profile_binding");
      const binding = await deps.execution.admission.bind(job.userId, {
        inputHash: input.inputHash,
        ordinal: maxOrdinal(prior) + 1,
        owner: { memoryJobId: job.id, type: "JOB" },
        role: "MEMORY_PROFILE",
        versions: MEMORY_PROFILE_VERSIONS
      });
      const started = await deps.execution.admission.start(job.userId, binding.id);
      if (
        started.snapshot.logicalRole !== "MEMORY_PROFILE" ||
        !started.snapshot.requiresStrictStructuredOutput
      ) {
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: "memory_profile_binding_invalid",
          providerResponseId: null,
          state: "FAILED",
          usage: unavailableUsage
        });
        return {
          acceptedResultHash: terminalHash(job.id, input.inputHash, "profile_binding_invalid"),
          stage: "profile_omitted"
        };
      }
      await context.setStage("profile_provider_call");
      let result;
      try {
        result = await deps.provider.run(
          memoryProfileProviderEvidence(started.snapshot),
          input,
          context.signal
        );
      } catch (error) {
        const failure = providerFailure(error);
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: failure.code,
          providerResponseId: null,
          state: failure.state,
          usage: failure.usage
        });
        return {
          acceptedResultHash: terminalHash(job.id, input.inputHash, failure.code),
          stage: "profile_omitted"
        };
      }
      let plan;
      try {
        plan = decodeMemoryProfile(result.toolCalls, input);
      } catch (error) {
        const code = error instanceof MemoryProfileDecodeError
          ? error.code
          : "memory_profile_output_invalid";
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: code,
          providerResponseId: result.providerResponseId,
          state: "FAILED",
          usage: reportedUsage(result.usage)
        });
        return {
          acceptedResultHash: terminalHash(job.id, input.inputHash, code),
          stage: "profile_omitted"
        };
      }
      await deps.execution.lifecycle.settle(job.userId, binding.id, {
        acceptedOutputHash: plan.outputHash,
        errorCode: null,
        providerResponseId: result.providerResponseId,
        state: "SUCCEEDED",
        usage: reportedUsage(result.usage)
      });
      await context.setStage("profile_authorized_apply");
      return {
        acceptedResultHash: plan.outputHash,
        apply: (tx, claim) => deps.repository.applyProfile(
          tx,
          claim,
          input,
          plan,
          binding.id,
          context.now()
        ),
        stage: "profile_applied"
      };
    }
  });
}

export function createPrismaMemoryWorkingSetProfileHandler(
  authority: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma,
  options: Readonly<{
    profileEnabled?: boolean;
    provider?: MemoryProfileProvider;
    repository?: MemoryProfileRepository;
  }> = {}
): MemoryJobHandler {
  const now = () => memoryExecutionNow(authority);
  const execution = createPrismaMemoryExecutionService(authority, client);
  const repository = options.repository ?? createPrismaMemoryProfileRepository(authority, client);
  return createMemoryWorkingSetProfileHandler({
    execution,
    now,
    profileEnabled: options.profileEnabled ??
      MEMORY_PHASE7_CAPABILITY_POLICY.profileWorkingSet.enabled,
    probeAuthority: (userId) => withLockedMemoryTransaction(
      client,
      userId,
      async (tx, settings) => {
        const resolved = await resolveCurrentMemoryExecutionAuthority(tx, settings, {
          dependencies: authority,
          now: now(),
          role: "MEMORY_PROFILE",
          userId,
          versions: MEMORY_PROFILE_VERSIONS
        });
        const model = resolved.target.snapshot.model;
        if (
          model.adapterKind === "fake" || model.modelClass !== "answer" ||
          model.capabilities.toolCalling !== true
        ) throw new MemoryExecutionError("memory_execution_capability_unavailable");
      }
    ),
    provider: options.provider ?? createAcceptedMemoryProfileProvider(client),
    repository
  });
}
