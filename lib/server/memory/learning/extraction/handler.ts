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
import { memoryExplicitStatementContainsSecret } from "../../explicit/safety";
import { withLockedMemoryTransaction } from "../../persistence/transaction";
import {
  MEMORY_FACT_EXTRACTION_VERSIONS,
  memoryFactExtractionClaimIsValid,
  type MemoryFactExtractionInput,
  type MemoryFactExtractionPlan
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
import {
  decodeMemorySemanticAdjudication,
  decodeStoredMemorySemanticAdjudication,
  memorySemanticAdjudicationInput,
  MEMORY_SEMANTIC_ADJUDICATION_VERSIONS,
  type MemorySemanticAdjudicationPacket
} from "./adjudication";
import {
  createAcceptedMemorySemanticAdjudicationProvider,
  type MemorySemanticAdjudicationProvider
} from "./adjudicationRuntime";

export type MemoryFactExtractionHandlerDependencies = Readonly<{
  adjudicator?: MemorySemanticAdjudicationProvider;
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

function bindingUsesVersions(
  binding: Awaited<ReturnType<MemoryFactExtractionRepository["bindings"]>>[number],
  versions: typeof MEMORY_FACT_EXTRACTION_VERSIONS
): boolean {
  return binding.pipelineVersion === versions.pipelineVersion &&
    binding.policyVersion === versions.policyVersion &&
    binding.promptVersion === versions.promptVersion &&
    binding.schemaVersion === versions.schemaVersion;
}

async function recoverPriorExecution(
  deps: MemoryFactExtractionHandlerDependencies,
  job: MemoryJobDescriptor,
  input: MemoryFactExtractionInput
): Promise<
  | Readonly<{ kind: "APPLY"; bindingId: string; plan: MemoryFactExtractionPlan }>
  | Readonly<{ kind: "TERMINAL"; result: MemoryJobExecutionResult }>
  | null
> {
  const bindings = await deps.repository.bindings(job.userId, job.id);
  const extractionBindings = bindings.filter((binding) =>
    bindingUsesVersions(binding, MEMORY_FACT_EXTRACTION_VERSIONS));
  const compatibleBindings = bindings.filter((binding) =>
    bindingUsesVersions(binding, MEMORY_FACT_EXTRACTION_VERSIONS) ||
    bindingUsesVersions(binding, MEMORY_SEMANTIC_ADJUDICATION_VERSIONS));
  if (compatibleBindings.length !== bindings.length ||
    extractionBindings.some((binding) => binding.inputHash !== input.inputHash)) {
    await deps.repository.discardStale(job, "source_stale");
    throw new MemoryCoordinatorError("memory_fact_binding_stale", false);
  }
  const succeeded = extractionBindings.find((binding) => binding.state === "SUCCEEDED");
  if (succeeded?.acceptedOutputHash) {
    const applied = await deps.repository.applied(job, succeeded.id);
    if (applied !== null) {
      return {
        kind: "TERMINAL",
        result: terminalResult(
          job,
          input,
          applied === "APPLIED"
            ? "fact_observations_committed"
            : "fact_observations_empty",
          succeeded.acceptedOutputHash
        )
      };
    }
    const plan = await deps.repository.staged(job, succeeded.id, input, deps.now());
    if (!plan || plan.outputHash !== succeeded.acceptedOutputHash) {
      throw new MemoryCoordinatorError("memory_fact_staged_result_missing", true);
    }
    return { bindingId: succeeded.id, kind: "APPLY", plan };
  }
  const uncertain = extractionBindings.find((binding) =>
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
    return {
      kind: "TERMINAL",
      result: terminalResult(job, input, "fact_outcome_unknown")
    };
  }
  for (const pending of extractionBindings.filter(
    (binding) => binding.state === "PENDING")) {
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

function providerFailureState(error: unknown): Readonly<{
  classification: "UNKNOWN" | "REPLAY_SAFE_TRANSIENT" | "PERMANENT";
  errorCode: string;
  state: "FAILED" | "OUTCOME_UNKNOWN";
  usage: MemoryReportedUsage;
}> {
  const classification = error instanceof MemoryFactProviderCallError
    ? error.classification
    : "PERMANENT";
  return {
    classification,
    errorCode: classification === "UNKNOWN"
      ? "memory_fact_provider_outcome_unknown"
      : classification === "REPLAY_SAFE_TRANSIENT"
        ? "memory_fact_provider_transient"
        : "memory_fact_provider_unavailable",
    state: classification === "UNKNOWN" ? "OUTCOME_UNKNOWN" : "FAILED",
    usage: classification === "UNKNOWN" &&
      error instanceof MemoryFactProviderCallError && error.usage
      ? reportedUsage(error.usage)
      : unavailableUsage
  };
}

type AdjudicationAuthority = Readonly<{
  authorityBindingId: string;
  authorityOutputHash: string;
  packet: MemorySemanticAdjudicationPacket | null;
}>;

function extractionAuthority(
  bindingId: string,
  plan: MemoryFactExtractionPlan
): AdjudicationAuthority {
  return {
    authorityBindingId: bindingId,
    authorityOutputHash: plan.outputHash,
    packet: null
  };
}

async function adjudicatePlan(
  deps: MemoryFactExtractionHandlerDependencies,
  job: MemoryJobDescriptor,
  plan: MemoryFactExtractionPlan,
  extractionBindingId: string,
  context: Readonly<{
    setStage(stage: string): Promise<void>;
    signal: AbortSignal;
  }>
): Promise<AdjudicationAuthority> {
  const adjudicationInput = memorySemanticAdjudicationInput(plan);
  if (!adjudicationInput) return extractionAuthority(extractionBindingId, plan);
  if (!deps.adjudicator) return extractionAuthority(extractionBindingId, plan);

  const recover = async (): Promise<AdjudicationAuthority | null> => {
    const auxiliary = await deps.repository.auxiliary(job);
    if (!auxiliary) return null;
    if (auxiliary.ownerJobId !== job.id ||
      auxiliary.purpose !== "FACT_EXTRACTION_ADJUDICATION") {
      return extractionAuthority(extractionBindingId, plan);
    }
    if (auxiliary.completedAt === null) return null;
    if (!auxiliary.executionId || !auxiliary.inputHash ||
      !auxiliary.acceptedOutputHash || auxiliary.inputHash !== adjudicationInput.inputHash) {
      throw new MemoryCoordinatorError("memory_semantic_adjudication_result_invalid", false);
    }
    const packet = decodeStoredMemorySemanticAdjudication(auxiliary.result);
    if (packet.inputHash !== auxiliary.inputHash ||
      packet.outputHash !== auxiliary.acceptedOutputHash) {
      throw new MemoryCoordinatorError("memory_semantic_adjudication_result_invalid", false);
    }
    const binding = (await deps.repository.bindings(job.userId, job.id)).find(
      ({ id }) => id === auxiliary.executionId
    );
    if (!binding || binding.state !== "SUCCEEDED" ||
      binding.acceptedOutputHash !== packet.outputHash) {
      throw new MemoryCoordinatorError("memory_semantic_adjudication_result_invalid", false);
    }
    return {
      authorityBindingId: binding.id,
      authorityOutputHash: packet.outputHash,
      packet
    };
  };

  const recovered = await recover();
  if (recovered) return recovered;
  const reservation = await deps.repository.reserveAdjudication(job);
  if (reservation === "UNAVAILABLE") {
    return extractionAuthority(extractionBindingId, plan);
  }
  if (reservation === "RECOVERED") {
    return await recover() ?? extractionAuthority(extractionBindingId, plan);
  }

  const prior = await deps.repository.bindings(job.userId, job.id);
  const attempts = prior.filter((binding) =>
    bindingUsesVersions(binding, MEMORY_SEMANTIC_ADJUDICATION_VERSIONS));
  const pending = attempts.find(({ state }) => state === "PENDING");
  if (attempts.some(({ state }) => state !== "PENDING")) {
    const running = attempts.find(({ state }) => state === "RUNNING");
    if (running) {
      await deps.execution.lifecycle.settle(job.userId, running.id, {
        acceptedOutputHash: null,
        errorCode: "memory_semantic_adjudication_outcome_unknown",
        providerResponseId: null,
        state: "OUTCOME_UNKNOWN",
        usage: unavailableUsage
      });
    }
    return extractionAuthority(extractionBindingId, plan);
  }

  let bindingId = pending?.id;
  if (!bindingId) {
    await context.setStage("semantic_adjudication_binding");
    try {
      const binding = await deps.execution.admission.bind(job.userId, {
        inputHash: adjudicationInput.inputHash,
        ordinal: maxOrdinal(prior) + 1,
        owner: { memoryJobId: job.id, type: "JOB" },
        role: "MEMORY_FACT_EXTRACT",
        versions: MEMORY_SEMANTIC_ADJUDICATION_VERSIONS
      });
      bindingId = binding.id;
    } catch {
      return extractionAuthority(extractionBindingId, plan);
    }
  }

  let started: Awaited<ReturnType<
    MemoryFactExtractionHandlerDependencies["execution"]["admission"]["start"]
  >>;
  try {
    started = await deps.execution.admission.start(job.userId, bindingId);
  } catch {
    return extractionAuthority(extractionBindingId, plan);
  }
  if (started.snapshot.logicalRole !== "MEMORY_FACT_EXTRACT" ||
    !started.snapshot.requiresStrictStructuredOutput) {
    await deps.execution.lifecycle.settle(job.userId, bindingId, {
      acceptedOutputHash: null,
      errorCode: "memory_semantic_adjudication_binding_invalid",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
    return extractionAuthority(extractionBindingId, plan);
  }

  await context.setStage("semantic_adjudication_provider_call");
  let result: Awaited<ReturnType<MemorySemanticAdjudicationProvider["run"]>>;
  try {
    result = await deps.adjudicator.run(
      memoryFactProviderEvidence(started.snapshot),
      adjudicationInput,
      context.signal
    );
  } catch (error) {
    const failure = providerFailureState(error);
    await deps.execution.lifecycle.settle(job.userId, bindingId, {
      acceptedOutputHash: null,
      errorCode: failure.errorCode,
      providerResponseId: null,
      state: failure.state,
      usage: failure.usage
    });
    return extractionAuthority(extractionBindingId, plan);
  }

  let packet: MemorySemanticAdjudicationPacket;
  try {
    packet = decodeMemorySemanticAdjudication(result.toolCalls, adjudicationInput);
  } catch {
    await deps.execution.lifecycle.settle(job.userId, bindingId, {
      acceptedOutputHash: null,
      errorCode: "memory_semantic_adjudication_output_invalid",
      providerResponseId: result.providerResponseId,
      state: "FAILED",
      usage: reportedUsage(result.usage)
    });
    return extractionAuthority(extractionBindingId, plan);
  }

  await deps.execution.lifecycle.settleSucceededWithDurableResult(
    job.userId,
    bindingId,
    {
      acceptedOutputHash: packet.outputHash,
      errorCode: null,
      providerResponseId: result.providerResponseId,
      state: "SUCCEEDED",
      usage: reportedUsage(result.usage)
    },
    (tx) => deps.repository.completeAdjudication(
      tx,
      job,
      bindingId!,
      packet,
      deps.now()
    )
  );
  return {
    authorityBindingId: bindingId,
    authorityOutputHash: packet.outputHash,
    packet
  };
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
        await deps.repository.discardStale(job, "source_stale");
        return terminalResult(job, null, prepared.decision.errorCode);
      }
      const input = prepared.input;
      if (input.messages.length === 0) {
        return terminalResult(job, input, "fact_empty_safe_source");
      }
      // This fence deliberately precedes binding recovery and provider
      // authority work: recognizable raw credentials must never be included
      // in a model request merely to ask whether they are credentials.
      if (input.messages.some((message) =>
        message.evidenceEligible &&
        memoryExplicitStatementContainsSecret(message.text)) ||
        input.contextRefs.some((context) =>
          memoryExplicitStatementContainsSecret(context.text) ||
          context.aliases.some(memoryExplicitStatementContainsSecret))) {
        await deps.repository.discardStale(job, "secret_source_fenced");
        return terminalResult(job, input, "fact_secret_source_fenced");
      }
      const recovered = await recoverPriorExecution(deps, job, input);
      if (recovered?.kind === "TERMINAL") return recovered.result;

      let bindingId: string;
      let plan: MemoryFactExtractionPlan;
      if (recovered?.kind === "APPLY") {
        bindingId = recovered.bindingId;
        plan = recovered.plan;
      } else {
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
        bindingId = binding.id;
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
          const failure = providerFailureState(error);
          await deps.execution.lifecycle.settle(job.userId, binding.id, {
            acceptedOutputHash: null,
            errorCode: failure.errorCode,
            providerResponseId: null,
            state: failure.state,
            usage: failure.usage
          });
          if (failure.classification === "REPLAY_SAFE_TRANSIENT") {
            throw new MemoryCoordinatorError(failure.errorCode, true);
          }
          return terminalResult(
            job,
            input,
            failure.classification === "UNKNOWN"
              ? "fact_outcome_unknown"
              : "fact_provider_unavailable"
          );
        }

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

        await deps.execution.lifecycle.settleSucceededWithDurableResult(
          job.userId,
          binding.id,
          {
            acceptedOutputHash: plan.outputHash,
            errorCode: null,
            providerResponseId: result.providerResponseId,
            state: "SUCCEEDED",
            usage: reportedUsage(result.usage)
          },
          (tx, evidence) => deps.repository.stage(
            tx,
            job,
            plan,
            binding.id,
            evidence.recoverableUntil
          )
        );
      }
      const semanticAuthority = await adjudicatePlan(
        deps,
        job,
        plan,
        bindingId,
        context
      );
      await context.setStage("authorized_apply");
      try {
        const applied = await deps.execution.lifecycle.withAuthorizedResultCommit(
          job.userId,
          {
            acceptedOutputHash: semanticAuthority.authorityOutputHash,
            bindingId: semanticAuthority.authorityBindingId
          },
          (tx, evidence) => deps.repository.apply(
            tx,
            evidence.settings,
            job,
            plan,
            bindingId,
            context.now(),
            semanticAuthority.packet,
            semanticAuthority.authorityBindingId
          )
        );
        if (applied === "STALE") {
          return terminalResult(job, input, "fact_apply_stale", plan.outputHash);
        }
        return {
          acceptedResultHash: plan.outputHash,
          stage: applied === "APPLIED"
            ? "fact_observations_committed"
            : "fact_observations_empty"
        };
      } catch (error) {
        if (error instanceof MemoryCoordinatorError) throw error;
        throw new MemoryCoordinatorError("memory_fact_apply_retryable", true);
      }
    }
  });
}

export function createPrismaMemoryFactExtractionHandler(
  authority: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma,
  options: Readonly<{
    adjudicator?: MemorySemanticAdjudicationProvider;
    provider?: MemoryFactProvider;
    repository?: MemoryFactExtractionRepository;
  }> = {}
): MemoryJobHandler {
  const now = () => memoryExecutionNow(authority);
  return createMemoryFactExtractionHandler({
    adjudicator: options.adjudicator ??
      createAcceptedMemorySemanticAdjudicationProvider(client),
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
