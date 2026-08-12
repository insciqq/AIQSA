import type { PrismaClient } from "@prisma/client";
import { normalizeTokenUsage } from "../../../domain/usage";
import { prisma } from "../../prisma";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type {
  MemoryJobDescriptor,
  MemoryJobExecutionContext,
  MemoryJobHandler
} from "../coordinator/types";
import {
  createPrismaMemoryExecutionService,
  memoryExecutionNow,
  MemoryExecutionError,
  resolveCurrentMemoryExecutionAuthority,
  type MemoryExecutionAuthorityDependencies,
  type MemoryExecutionRole,
  type MemoryReportedUsage,
  type PrismaMemoryExecutionService
} from "../execution";
import { memoryExecutionSha256 } from "../execution/canonical";
import {
  MEMORY_FACT_CONSOLIDATION_VERSIONS,
  MEMORY_FACT_VERIFICATION_VERSIONS,
  memoryFactConsolidationOutputHash,
  memoryFactDecisionId,
  memoryFactVerificationInputHash,
  memoryFactVerificationOutputHash,
  type MemoryFactConsolidationOperation,
  type MemoryFactConsolidationPlan,
  type MemoryFactDecisionSnapshot,
  type MemoryFactVerificationInput,
  type MemoryFactVerificationPlan
} from "../learning/consolidation/contract";
import {
  decodeMemoryFactConsolidation,
  decodeMemoryFactVerification,
  MemoryFactConsolidationDecodeError
} from "../learning/consolidation/decoder";
import { evaluateMemoryFactConsolidationPlan } from "../learning/consolidation/policy";
import {
  createAcceptedMemoryFactDecisionProvider,
  memoryFactDecisionProviderEvidence,
  MemoryFactDecisionProviderCallError,
  type MemoryFactDecisionProvider
} from "../learning/consolidation/runtime";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import {
  memoryGlobalDreamPlanStage,
  memoryGlobalDreamResultHash,
  memoryGlobalDreamVerificationStage,
  parseMemoryGlobalDreamJobFingerprint,
  parseMemoryGlobalDreamPlanStage,
  parseMemoryGlobalDreamVerificationStage,
  type MemoryGlobalDreamSemanticSelection,
  type MemoryGlobalDreamSelection
} from "./contract";
import {
  createPrismaMemoryGlobalDreamRepository,
  type MemoryGlobalDreamExecutionBinding,
  type MemoryGlobalDreamRepository
} from "./repository";

type DecisionRole = "MEMORY_CONSOLIDATE" | "MEMORY_VERIFY";

export type MemoryGlobalDreamHandlerDependencies = Readonly<{
  execution: PrismaMemoryExecutionService;
  probeAuthority: (userId: string, role: DecisionRole) => Promise<void>;
  provider: MemoryFactDecisionProvider;
  repository: MemoryGlobalDreamRepository;
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

const consolidationReason = Object.freeze({
  ADD: "new_supported_fact",
  CONFLICT: "simultaneous_contradiction",
  DEFER: "insufficient_support",
  EXPIRE: "direct_end_evidence",
  NOOP: "duplicate_or_explicit",
  REINFORCE: "same_current_value",
  SUPERSEDE: "direct_newer_evidence"
} as const);

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

function terminalHash(
  job: MemoryJobDescriptor,
  inputHash: string | null,
  reason: string
): string {
  return memoryExecutionSha256({
    domain: "aiqsa.memory.global-dream-terminal",
    inputHash,
    jobId: job.id,
    reason,
    version: 1
  });
}

function maxOrdinal(bindings: readonly MemoryGlobalDreamExecutionBinding[]): number {
  return bindings.reduce((maximum, binding) => Math.max(maximum, binding.ordinal), -1);
}

function providerFailureState(error: unknown): Readonly<{
  errorCode: string;
  state: "FAILED" | "OUTCOME_UNKNOWN";
  usage: MemoryReportedUsage;
}> {
  const uncertain = error instanceof MemoryFactDecisionProviderCallError;
  return {
    errorCode: uncertain
      ? "memory_global_dream_provider_outcome_unknown"
      : "memory_global_dream_provider_unavailable",
    state: uncertain ? "OUTCOME_UNKNOWN" : "FAILED",
    usage: uncertain && error.usage ? reportedUsage(error.usage) : unavailableUsage
  };
}

function buildVerificationInput(
  selection: MemoryGlobalDreamSemanticSelection,
  plan: MemoryFactConsolidationPlan
): MemoryFactVerificationInput {
  const decision: MemoryFactDecisionSnapshot = {
    consolidationInputHash: selection.input.inputHash,
    consolidationOutputHash: plan.outputHash,
    id: memoryFactDecisionId(selection.input, plan),
    operation: plan.operation,
    reasonCode: plan.reasonCode,
    relatedSnapshotHash: selection.input.relatedSnapshotHash,
    requiresVerification: true,
    targetFactId: plan.targetFactId,
    targetVersionId: plan.targetVersionId
  };
  const target = plan.targetFactId
    ? selection.input.relatedFacts.find(({ id }) => id === plan.targetFactId) ?? null
    : null;
  const withoutHash: Omit<MemoryFactVerificationInput, "inputHash"> = {
    candidate: selection.input.candidate,
    decision,
    target
  };
  return {
    ...withoutHash,
    inputHash: memoryFactVerificationInputHash(withoutHash)
  };
}

function planFromStageParts(
  selection: MemoryGlobalDreamSemanticSelection,
  operation: MemoryFactConsolidationOperation,
  targetIndex: number | null
): MemoryFactConsolidationPlan | null {
  const target = targetIndex === null
    ? null
    : selection.input.relatedFacts[targetIndex] ?? null;
  const targetRequired = ["CONFLICT", "EXPIRE", "REINFORCE", "SUPERSEDE"]
    .includes(operation);
  if (targetRequired !== Boolean(target)) return null;
  const withoutHash: Omit<MemoryFactConsolidationPlan, "outputHash"> = {
    candidateId: selection.input.candidate.id,
    effectiveFrom: operation === "SUPERSEDE"
      ? selection.input.candidate.validFrom
      : null,
    evidenceIds: selection.input.candidate.evidence.map(({ messageId }) => messageId),
    operation,
    reasonCode: consolidationReason[operation],
    targetFactId: target?.id ?? null,
    targetVersionId: target?.currentVersionId ?? null
  };
  if (target && !target.currentVersionId) return null;
  return {
    ...withoutHash,
    outputHash: memoryFactConsolidationOutputHash(selection.input, withoutHash)
  };
}

function consolidationPlanFromStage(
  selection: MemoryGlobalDreamSemanticSelection,
  stage: string | null
): MemoryFactConsolidationPlan | null {
  const plan = parseMemoryGlobalDreamPlanStage(stage);
  if (plan) return planFromStageParts(selection, plan.operation, plan.targetIndex);
  const verified = parseMemoryGlobalDreamVerificationStage(stage);
  return verified
    ? planFromStageParts(selection, verified.operation, verified.targetIndex)
    : null;
}

function verificationPlanFromStage(
  selection: MemoryGlobalDreamSemanticSelection,
  consolidation: MemoryFactConsolidationPlan,
  stage: string | null
): MemoryFactVerificationPlan | null {
  const parsed = parseMemoryGlobalDreamVerificationStage(stage);
  if (!parsed || parsed.operation !== consolidation.operation) return null;
  const input = buildVerificationInput(selection, consolidation);
  const withoutHash: Omit<MemoryFactVerificationPlan, "outputHash"> = {
    candidateId: selection.input.candidate.id,
    decisionId: input.decision.id,
    reasonCode: parsed.reasonCode,
    verdict: parsed.verdict
  };
  return {
    ...withoutHash,
    outputHash: memoryFactVerificationOutputHash(input, withoutHash)
  };
}

type ConsolidationOutcome =
  | Readonly<{
      bindingId: string;
      kind: "READY";
      plan: MemoryFactConsolidationPlan;
    }>
  | Readonly<{
      acceptedResultHash: string;
      kind: "TERMINAL";
      reason: string;
    }>;

type VerificationOutcome =
  | Readonly<{
      bindingId: string;
      kind: "READY";
      plan: MemoryFactVerificationPlan;
    }>
  | Readonly<{
      acceptedResultHash: string;
      kind: "TERMINAL";
      reason: string;
    }>;

async function uncertainBinding(
  execution: PrismaMemoryExecutionService,
  userId: string,
  binding: MemoryGlobalDreamExecutionBinding
): Promise<void> {
  if (binding.state !== "RUNNING") return;
  await execution.lifecycle.settle(userId, binding.id, {
    acceptedOutputHash: null,
    errorCode: "memory_global_dream_recovered_uncertain",
    providerResponseId: null,
    state: "OUTCOME_UNKNOWN",
    usage: unavailableUsage
  });
}

async function abandonPendingBindings(
  execution: PrismaMemoryExecutionService,
  userId: string,
  bindings: readonly MemoryGlobalDreamExecutionBinding[],
  keepId: string | null
): Promise<void> {
  for (const binding of bindings) {
    if (binding.state !== "PENDING" || binding.id === keepId) continue;
    await execution.lifecycle.settle(userId, binding.id, {
      acceptedOutputHash: null,
      errorCode: "memory_global_dream_execution_abandoned",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
  }
}

async function runConsolidation(
  deps: MemoryGlobalDreamHandlerDependencies,
  job: MemoryJobDescriptor,
  context: MemoryJobExecutionContext,
  selection: MemoryGlobalDreamSemanticSelection
): Promise<ConsolidationOutcome> {
  const input = selection.input;
  const bindings = await deps.repository.consolidationBindings(job.userId, job.id);
  const succeeded = bindings.find((binding) => binding.state === "SUCCEEDED");
  if (succeeded) {
    const plan = consolidationPlanFromStage(selection, job.stage);
    if (plan && succeeded.inputHash === input.inputHash &&
      succeeded.acceptedOutputHash === plan.outputHash) {
      return { bindingId: succeeded.id, kind: "READY", plan };
    }
    return {
      acceptedResultHash: succeeded.acceptedOutputHash ??
        terminalHash(job, input.inputHash, "consolidation_result_unavailable"),
      kind: "TERMINAL",
      reason: "consolidation_result_unavailable"
    };
  }
  const uncertain = bindings.find((binding) =>
    binding.state === "RUNNING" || binding.state === "OUTCOME_UNKNOWN");
  if (uncertain) {
    await uncertainBinding(deps.execution, job.userId, uncertain);
    return {
      acceptedResultHash: terminalHash(
        job,
        input.inputHash,
        "consolidation_outcome_unknown"
      ),
      kind: "TERMINAL",
      reason: "consolidation_outcome_unknown"
    };
  }
  const pending = bindings.find((binding) =>
    binding.state === "PENDING" && binding.inputHash === input.inputHash);
  await abandonPendingBindings(
    deps.execution,
    job.userId,
    bindings,
    pending?.id ?? null
  );
  await deps.probeAuthority(job.userId, "MEMORY_CONSOLIDATE").catch((error) => {
    const decision = authorityGate(error);
    throw new MemoryCoordinatorError(decision.errorCode, true);
  });
  await context.setStage("gd_consolidation_binding");
  const binding = pending ?? await deps.execution.admission.bind(job.userId, {
    inputHash: input.inputHash,
    ordinal: maxOrdinal(bindings) + 1,
    owner: { memoryJobId: job.id, type: "JOB" },
    role: "MEMORY_CONSOLIDATE",
    versions: MEMORY_FACT_CONSOLIDATION_VERSIONS
  });
  const started = await deps.execution.admission.start(job.userId, binding.id);
  if (
    started.snapshot.logicalRole !== "MEMORY_CONSOLIDATE" ||
    !started.snapshot.requiresStrictStructuredOutput
  ) {
    await deps.execution.lifecycle.settle(job.userId, binding.id, {
      acceptedOutputHash: null,
      errorCode: "memory_global_dream_binding_invalid",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
    throw new MemoryCoordinatorError("memory_global_dream_binding_invalid", false);
  }
  await context.setStage("gd_consolidation_call");
  let result;
  try {
    result = await deps.provider.run(
      memoryFactDecisionProviderEvidence(started.snapshot),
      { input, kind: "CONSOLIDATE" },
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
    if (failure.state === "OUTCOME_UNKNOWN") {
      return {
        acceptedResultHash: terminalHash(job, input.inputHash, failure.errorCode),
        kind: "TERMINAL",
        reason: failure.errorCode
      };
    }
    throw new MemoryCoordinatorError(failure.errorCode, true);
  }
  let plan;
  try {
    plan = decodeMemoryFactConsolidation(result.toolCalls, input);
  } catch (error) {
    const code = error instanceof MemoryFactConsolidationDecodeError
      ? error.code
      : "memory_global_dream_consolidation_output_invalid";
    await deps.execution.lifecycle.settle(job.userId, binding.id, {
      acceptedOutputHash: null,
      errorCode: code,
      providerResponseId: result.providerResponseId,
      state: "FAILED",
      usage: reportedUsage(result.usage)
    });
    throw new MemoryCoordinatorError(code, true);
  }
  await context.setStage(memoryGlobalDreamPlanStage(input, plan));
  await deps.execution.lifecycle.settle(job.userId, binding.id, {
    acceptedOutputHash: plan.outputHash,
    errorCode: null,
    providerResponseId: result.providerResponseId,
    state: "SUCCEEDED",
    usage: reportedUsage(result.usage)
  });
  return { bindingId: binding.id, kind: "READY", plan };
}

async function runVerification(
  deps: MemoryGlobalDreamHandlerDependencies,
  job: MemoryJobDescriptor,
  context: MemoryJobExecutionContext,
  selection: MemoryGlobalDreamSemanticSelection,
  consolidation: MemoryFactConsolidationPlan
): Promise<VerificationOutcome> {
  const input = buildVerificationInput(selection, consolidation);
  const bindings = await deps.repository.verificationBindings(job.userId, job.id);
  const succeeded = bindings.find((binding) => binding.state === "SUCCEEDED");
  if (succeeded) {
    const plan = verificationPlanFromStage(selection, consolidation, job.stage);
    if (plan && succeeded.inputHash === input.inputHash &&
      succeeded.acceptedOutputHash === plan.outputHash) {
      return { bindingId: succeeded.id, kind: "READY", plan };
    }
    return {
      acceptedResultHash: succeeded.acceptedOutputHash ??
        terminalHash(job, input.inputHash, "verification_result_unavailable"),
      kind: "TERMINAL",
      reason: "verification_result_unavailable"
    };
  }
  const uncertain = bindings.find((binding) =>
    binding.state === "RUNNING" || binding.state === "OUTCOME_UNKNOWN");
  if (uncertain) {
    await uncertainBinding(deps.execution, job.userId, uncertain);
    return {
      acceptedResultHash: terminalHash(
        job,
        input.inputHash,
        "verification_outcome_unknown"
      ),
      kind: "TERMINAL",
      reason: "verification_outcome_unknown"
    };
  }
  const pending = bindings.find((binding) =>
    binding.state === "PENDING" && binding.inputHash === input.inputHash);
  await abandonPendingBindings(
    deps.execution,
    job.userId,
    bindings,
    pending?.id ?? null
  );
  await deps.probeAuthority(job.userId, "MEMORY_VERIFY").catch((error) => {
    const decision = authorityGate(error);
    throw new MemoryCoordinatorError(decision.errorCode, true);
  });
  const binding = pending ?? await deps.execution.admission.bind(job.userId, {
    inputHash: input.inputHash,
    ordinal: maxOrdinal(bindings) + 1,
    owner: { memoryJobId: job.id, type: "JOB" },
    role: "MEMORY_VERIFY",
    versions: MEMORY_FACT_VERIFICATION_VERSIONS
  });
  const started = await deps.execution.admission.start(job.userId, binding.id);
  if (
    started.snapshot.logicalRole !== "MEMORY_VERIFY" ||
    !started.snapshot.requiresStrictStructuredOutput
  ) {
    await deps.execution.lifecycle.settle(job.userId, binding.id, {
      acceptedOutputHash: null,
      errorCode: "memory_global_dream_binding_invalid",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
    throw new MemoryCoordinatorError("memory_global_dream_binding_invalid", false);
  }
  let result;
  try {
    result = await deps.provider.run(
      memoryFactDecisionProviderEvidence(started.snapshot),
      { input, kind: "VERIFY" },
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
    if (failure.state === "OUTCOME_UNKNOWN") {
      return {
        acceptedResultHash: terminalHash(job, input.inputHash, failure.errorCode),
        kind: "TERMINAL",
        reason: failure.errorCode
      };
    }
    throw new MemoryCoordinatorError(failure.errorCode, true);
  }
  let plan;
  try {
    plan = decodeMemoryFactVerification(result.toolCalls, input);
  } catch (error) {
    const code = error instanceof MemoryFactConsolidationDecodeError
      ? error.code
      : "memory_global_dream_verification_output_invalid";
    await deps.execution.lifecycle.settle(job.userId, binding.id, {
      acceptedOutputHash: null,
      errorCode: code,
      providerResponseId: result.providerResponseId,
      state: "FAILED",
      usage: reportedUsage(result.usage)
    });
    throw new MemoryCoordinatorError(code, true);
  }
  await context.setStage(
    memoryGlobalDreamVerificationStage(selection.input, consolidation, plan)
  );
  await deps.execution.lifecycle.settle(job.userId, binding.id, {
    acceptedOutputHash: plan.outputHash,
    errorCode: null,
    providerResponseId: result.providerResponseId,
    state: "SUCCEEDED",
    usage: reportedUsage(result.usage)
  });
  return { bindingId: binding.id, kind: "READY", plan };
}

function semanticResultHash(
  selection: MemoryGlobalDreamSemanticSelection,
  consolidation: MemoryFactConsolidationPlan,
  verification: MemoryFactVerificationPlan | null
): string {
  return memoryGlobalDreamResultHash({
    consolidationOutputHash: consolidation.outputHash,
    kind: selection.kind,
    selectionResultHash: selection.resultHash,
    snapshotHash: selection.snapshotHash,
    verificationOutputHash: verification?.outputHash ?? null
  });
}

export function createMemoryGlobalDreamHandler(
  deps: MemoryGlobalDreamHandlerDependencies
): MemoryJobHandler {
  return Object.freeze({
    kind: "GLOBAL_DREAM" as const,

    async preflight(job) {
      const identity = parseMemoryGlobalDreamJobFingerprint(
        job.idempotencyFingerprint
      );
      if (!identity) {
        return { errorCode: "memory_global_dream_job_invalid", status: "CANCELLED" };
      }
      const decision = await deps.repository.preflight(job);
      if (decision.status !== "READY") return decision;
      if (identity.kind === "RETRACT_INVALID" || identity.kind === "EXPIRE_TEMPORAL") {
        return { status: "READY" };
      }
      try {
        await deps.probeAuthority(job.userId, "MEMORY_CONSOLIDATE");
        await deps.probeAuthority(job.userId, "MEMORY_VERIFY");
        return { status: "READY" };
      } catch (error) {
        return authorityGate(error);
      }
    },

    async execute(job, context) {
      const prepared = await deps.repository.prepare(job);
      if ("decision" in prepared) {
        return {
          acceptedResultHash: terminalHash(job, null, prepared.decision.errorCode),
          stage: "gd_snapshot_stale"
        };
      }
      const selection: MemoryGlobalDreamSelection = prepared.selection;
      if (selection.kind === "RETRACT_INVALID" || selection.kind === "EXPIRE_TEMPORAL") {
        return {
          acceptedResultHash: selection.resultHash,
          apply: (tx, claim) => deps.repository.apply(
            tx,
            claim,
            selection,
            null,
            null,
            context.now()
          ),
          stage: "gd_local_ready"
        };
      }
      const consolidation = await runConsolidation(
        deps,
        job,
        context,
        selection
      );
      if (consolidation.kind === "TERMINAL") {
        return {
          acceptedResultHash: consolidation.acceptedResultHash,
          stage: "gd_semantic_deferred"
        };
      }
      const policy = evaluateMemoryFactConsolidationPlan(
        selection.input,
        consolidation.plan
      );
      const mutating = consolidation.plan.operation !== "NOOP" &&
        consolidation.plan.operation !== "DEFER";
      const needsVerification = policy.status === "VALID" && mutating &&
        (policy.requiresVerification || selection.scopeChanged);
      let verification: Extract<VerificationOutcome, { kind: "READY" }> | null = null;
      if (needsVerification) {
        const outcome = await runVerification(
          deps,
          job,
          context,
          selection,
          consolidation.plan
        );
        if (outcome.kind === "TERMINAL") {
          return {
            acceptedResultHash: outcome.acceptedResultHash,
            stage: "gd_semantic_deferred"
          };
        }
        verification = outcome;
      }
      return {
        acceptedResultHash: semanticResultHash(
          selection,
          consolidation.plan,
          verification?.plan ?? null
        ),
        apply: (tx, claim) => deps.repository.apply(
          tx,
          claim,
          selection,
          {
            bindingId: consolidation.bindingId,
            plan: consolidation.plan
          },
          verification ? {
            bindingId: verification.bindingId,
            plan: verification.plan
          } : null,
          context.now()
        ),
        stage: "gd_semantic_ready"
      };
    }
  });
}

export function createPrismaMemoryGlobalDreamHandler(
  authority: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma,
  options: Readonly<{
    provider?: MemoryFactDecisionProvider;
    repository?: MemoryGlobalDreamRepository;
  }> = {}
): MemoryJobHandler {
  const now = () => memoryExecutionNow(authority);
  const execution = createPrismaMemoryExecutionService(authority, client);
  const repository = options.repository ??
    createPrismaMemoryGlobalDreamRepository(authority, client, { now });
  return createMemoryGlobalDreamHandler({
    execution,
    probeAuthority: (userId, role) => withLockedMemoryTransaction(
      client,
      userId,
      async (tx, settings) => {
        const versions = role === "MEMORY_CONSOLIDATE"
          ? MEMORY_FACT_CONSOLIDATION_VERSIONS
          : MEMORY_FACT_VERIFICATION_VERSIONS;
        const resolved = await resolveCurrentMemoryExecutionAuthority(tx, settings, {
          dependencies: authority,
          now: now(),
          role: role as MemoryExecutionRole,
          userId,
          versions
        });
        const model = resolved.target.snapshot.model;
        if (
          model.adapterKind === "fake" || model.modelClass !== "answer" ||
          model.capabilities.toolCalling !== true
        ) throw new MemoryExecutionError("memory_execution_capability_unavailable");
      }
    ),
    provider: options.provider ?? createAcceptedMemoryFactDecisionProvider(client),
    repository
  });
}
