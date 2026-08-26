import type { PrismaClient } from "@prisma/client";
import { normalizeTokenUsage } from "../../../../domain/usage";
import { prisma } from "../../../prisma";
import { MemoryCoordinatorError } from "../../coordinator/errors";
import type {
  MemoryJobDescriptor,
  MemoryJobHandler
} from "../../coordinator/types";
import {
  createPrismaMemoryExecutionService,
  memoryExecutionNow,
  MemoryExecutionError,
  resolveCurrentMemoryExecutionAuthority,
  type MemoryExecutionAuthorityDependencies,
  type MemoryExecutionRole,
  type MemoryLegacyExecutionRole,
  type MemoryReportedUsage,
  type PrismaMemoryExecutionService
} from "../../execution";
import { memoryExecutionSha256 } from "../../execution/canonical";
import { withLockedMemoryTransaction } from "../../persistence/transaction";
import {
  createPrismaMemoryRunUtilityService,
  type MemoryRunUtilityService
} from "../../retrieval/runUtilities";
import {
  createPrismaMemoryVectorRepository,
  type MemoryVectorRepository
} from "../../retrieval/vector";
import {
  MEMORY_FACT_CONSOLIDATION_VERSIONS,
  MEMORY_FACT_VERIFICATION_VERSIONS,
  parseMemoryFactConsolidationJob,
  parseMemoryFactVerificationJob,
  type MemoryFactConsolidationInput,
  type MemoryFactCandidateSnapshot,
  type MemoryFactVerificationInput
} from "./contract";
import {
  decodeMemoryFactConsolidation,
  decodeMemoryFactVerification,
  MemoryFactConsolidationDecodeError
} from "./decoder";
import {
  createPrismaMemoryFactConsolidationRepository,
  type MemoryFactConsolidationRepository,
  type MemoryFactDecisionExecutionBinding
} from "./repository";
import {
  createAcceptedMemoryFactDecisionProvider,
  memoryFactDecisionProviderEvidence,
  MemoryFactDecisionProviderCallError,
  type MemoryFactDecisionProvider
} from "./runtime";

type DecisionRole = "MEMORY_CONSOLIDATE" | MemoryLegacyExecutionRole;

export type MemoryFactDecisionHandlerDependencies = Readonly<{
  execution: PrismaMemoryExecutionService;
  neighborhood?: MemoryFactNeighborhoodResolver;
  probeAuthority: (userId: string, role: DecisionRole) => Promise<void>;
  provider: MemoryFactDecisionProvider;
  repository: MemoryFactConsolidationRepository;
}>;

export type MemoryFactNeighborhoodResolver = Readonly<{
  relatedVersionIds(
    job: MemoryJobDescriptor,
    candidate: MemoryFactCandidateSnapshot,
    signal: AbortSignal
  ): Promise<readonly string[] | null>;
}>;

function createMemoryFactNeighborhoodResolver(
  utilities: MemoryRunUtilityService,
  vectors: MemoryVectorRepository
): MemoryFactNeighborhoodResolver {
  return Object.freeze({
    async relatedVersionIds(job, candidate, signal) {
      const profile = await vectors.resolveActiveProfile(job.userId);
      if (profile.status !== "READY") return null;
      const embedding = await utilities.embedQuery({
        jobAttemptCount: consolidationAttempt(job),
        owner: { memoryJobId: job.id, type: "JOB" },
        profile: profile.profile,
        query: candidate.displayText,
        signal,
        userId: job.userId
      });
      if (embedding.status !== "READY") return null;
      const scope = candidate.scope;
      const result = await vectors.search({
        eligibility: {
          allowedFactSensitivity: ["NORMAL"],
          allowedHistorySafety: ["NORMAL"],
          assistantId: scope.type === "ASSISTANT" ? scope.targetId : null,
          chatId: scope.type === "CHAT" ? scope.targetId : null,
          factMode: "CURRENT",
          factTemporalAsOf: null,
          folderId: scope.type === "FOLDER" ? scope.targetId : null,
          includePatterns: false,
          occurredFrom: null,
          occurredTo: null,
          sourceAssistantId: null,
          sourceChatIds: null,
          sourceFolderId: null
        },
        itemTypes: ["FACT_VERSION"],
        limit: 24,
        minimumScore: profile.profile.minimumSimilarity,
        profile: embedding.profile,
        userId: job.userId,
        vector: embedding.vector
      });
      return result.status === "READY"
        ? result.hits.map((hit) => hit.itemId)
        : null;
    }
  });
}

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

function terminalHash(
  job: MemoryJobDescriptor,
  inputHash: string | null,
  reason: string
): string {
  return memoryExecutionSha256({
    domain: "aiqsa.memory.fact-decision-local-terminal",
    inputHash,
    jobId: job.id,
    reason,
    version: 1
  });
}

function maxOrdinal(bindings: readonly MemoryFactDecisionExecutionBinding[]): number {
  return bindings.reduce((maximum, binding) => Math.max(maximum, binding.ordinal), -1);
}

type MemoryFactConsolidationAttempt = 1 | 2;

function consolidationAttempt(job: MemoryJobDescriptor): MemoryFactConsolidationAttempt {
  if (job.attemptCount === 1 || job.attemptCount === 2) return job.attemptCount;
  throw new MemoryCoordinatorError("memory_fact_consolidation_attempt_invalid", false);
}

function guardedConsolidationBindings(
  bindings: readonly MemoryFactDecisionExecutionBinding[],
  attempt: MemoryFactConsolidationAttempt
): readonly MemoryFactDecisionExecutionBinding[] {
  const ordered = [...bindings].sort((left, right) =>
    left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  if (
    ordered.length > attempt ||
    ordered.length > 2 ||
    ordered.some((binding, ordinal) =>
      binding.ordinal !== ordinal ||
      (binding.state === "SUCCEEDED") !== Boolean(binding.acceptedOutputHash))
  ) {
    throw new MemoryCoordinatorError("memory_fact_decision_binding_stale", false);
  }
  const unsettled = ordered.findIndex((binding) => binding.state !== "FAILED");
  if (unsettled !== -1 && unsettled !== ordered.length - 1) {
    throw new MemoryCoordinatorError("memory_fact_decision_binding_stale", false);
  }
  return ordered;
}

function consolidationDispatchAllowed(
  bindings: readonly MemoryFactDecisionExecutionBinding[],
  attempt: MemoryFactConsolidationAttempt
): boolean {
  if (attempt === 1) return bindings.length === 0;
  const prior = bindings[0];
  return bindings.length === 1 &&
    prior?.ordinal === 0 &&
    prior.state === "FAILED" &&
    prior.errorCode === "memory_fact_decision_provider_transient";
}

function isV1Candidate(candidate: MemoryFactCandidateSnapshot): boolean {
  return candidate.confidenceBand === "HIGH" &&
    typeof candidate.proposedValue === "object" &&
    candidate.proposedValue !== null &&
    !Array.isArray(candidate.proposedValue) &&
    typeof (candidate.proposedValue as { statement?: unknown }).statement === "string";
}

async function abandonPendingBindings(
  execution: PrismaMemoryExecutionService,
  userId: string,
  bindings: readonly MemoryFactDecisionExecutionBinding[]
): Promise<void> {
  for (const pending of bindings.filter((binding) => binding.state === "PENDING")) {
    await execution.lifecycle.settle(userId, pending.id, {
      acceptedOutputHash: null,
      errorCode: "memory_fact_decision_execution_abandoned",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
  }
}

async function recoverBinding(
  execution: PrismaMemoryExecutionService,
  userId: string,
  inputHash: string,
  bindings: readonly MemoryFactDecisionExecutionBinding[]
): Promise<Readonly<{
  binding: MemoryFactDecisionExecutionBinding;
  kind: "SUCCEEDED" | "UNCERTAIN";
}> | null> {
  if (bindings.some((binding) => binding.inputHash !== inputHash)) {
    throw new MemoryCoordinatorError("memory_fact_decision_binding_stale", false);
  }
  const succeeded = bindings.find((binding) => binding.state === "SUCCEEDED");
  if (succeeded?.acceptedOutputHash) return { binding: succeeded, kind: "SUCCEEDED" };
  const uncertain = bindings.find((binding) =>
    binding.state === "RUNNING" || binding.state === "OUTCOME_UNKNOWN");
  if (uncertain) {
    if (uncertain.state === "RUNNING") {
      await execution.lifecycle.settle(userId, uncertain.id, {
        acceptedOutputHash: null,
        errorCode: "memory_fact_decision_recovered_uncertain",
        providerResponseId: null,
        state: "OUTCOME_UNKNOWN",
        usage: unavailableUsage
      });
    }
    return { binding: uncertain, kind: "UNCERTAIN" };
  }
  await abandonPendingBindings(execution, userId, bindings);
  return null;
}

async function recoverDispatchedBinding(
  execution: PrismaMemoryExecutionService,
  userId: string,
  bindings: readonly MemoryFactDecisionExecutionBinding[]
): Promise<Readonly<{
  binding: MemoryFactDecisionExecutionBinding;
  kind: "SUCCEEDED" | "UNCERTAIN";
}> | null> {
  const binding = bindings.at(-1);
  if (binding?.state === "SUCCEEDED" && binding.acceptedOutputHash) {
    return { binding, kind: "SUCCEEDED" };
  }
  if (binding?.state !== "RUNNING" && binding?.state !== "OUTCOME_UNKNOWN") return null;
  if (binding.state === "RUNNING") {
    await execution.lifecycle.settle(userId, binding.id, {
      acceptedOutputHash: null,
      errorCode: "memory_fact_decision_recovered_uncertain",
      providerResponseId: null,
      state: "OUTCOME_UNKNOWN",
      usage: unavailableUsage
    });
  }
  return { binding, kind: "UNCERTAIN" };
}

function providerFailureState(error: unknown): Readonly<{
  classification: "UNKNOWN" | "REPLAY_SAFE_TRANSIENT" | "PERMANENT";
  errorCode: string;
  state: "FAILED" | "OUTCOME_UNKNOWN";
  usage: MemoryReportedUsage;
}> {
  const classification = error instanceof MemoryFactDecisionProviderCallError
    ? error.classification
    : "PERMANENT";
  return {
    classification,
    errorCode: classification === "UNKNOWN"
      ? "memory_fact_decision_provider_outcome_unknown"
      : classification === "REPLAY_SAFE_TRANSIENT"
        ? "memory_fact_decision_provider_transient"
        : "memory_fact_decision_provider_unavailable",
    state: classification === "UNKNOWN" ? "OUTCOME_UNKNOWN" : "FAILED",
    usage: classification === "UNKNOWN" &&
      error instanceof MemoryFactDecisionProviderCallError && error.usage
      ? reportedUsage(error.usage)
      : unavailableUsage
  };
}

export function createMemoryFactConsolidationHandler(
  deps: MemoryFactDecisionHandlerDependencies
): MemoryJobHandler {
  return Object.freeze({
    kind: "CONSOLIDATE_CANDIDATE" as const,

    async preflight(job) {
      if (!parseMemoryFactConsolidationJob(job)) {
        return { errorCode: "memory_fact_consolidation_job_invalid", status: "CANCELLED" };
      }
      const decision = await deps.repository.preflightConsolidation(job);
      if (decision.status !== "READY") return decision;
      try {
        await deps.probeAuthority(job.userId, "MEMORY_CONSOLIDATE");
        return { status: "READY" };
      } catch (error) {
        return authorityGate(error);
      }
    },

    async execute(job, context) {
      const identity = parseMemoryFactConsolidationJob(job);
      if (!identity) {
        return {
          acceptedResultHash: terminalHash(job, null, "consolidation_job_invalid"),
          stage: "consolidation_job_invalid"
        };
      }
      const attempt = consolidationAttempt(job);
      const prior = guardedConsolidationBindings(
        await deps.repository.consolidationBindings(job.userId, job.id),
        attempt
      );
      const dispatched = await recoverDispatchedBinding(
        deps.execution,
        job.userId,
        prior
      );
      if (dispatched) {
        return {
          acceptedResultHash: dispatched.binding.acceptedOutputHash ??
            terminalHash(job, dispatched.binding.inputHash, "consolidation_outcome_unknown"),
          apply: (tx, claim) => deps.repository.deferConsolidation(
            tx,
            claim,
            identity.candidateId,
            dispatched.kind === "SUCCEEDED"
              ? "consolidation_result_unavailable"
              : "consolidation_outcome_unknown"
          ),
          stage: "consolidation_deferred"
        };
      }
      if (!consolidationDispatchAllowed(prior, attempt)) {
        const failed = prior.at(-1);
        const reason = failed?.state === "FAILED" && failed.errorCode
          ? failed.errorCode
          : "memory_fact_consolidation_retry_not_allowed";
        return {
          acceptedResultHash: terminalHash(job, failed?.inputHash ?? null, reason),
          apply: (tx, claim) => deps.repository.deferConsolidation(
            tx,
            claim,
            identity.candidateId,
            reason
          ),
          stage: "consolidation_deferred"
        };
      }
      await context.setStage("related_fact_lookup");
      const initial = await deps.repository.prepareConsolidation(job);
      if ("decision" in initial) {
        return {
          acceptedResultHash: terminalHash(job, null, initial.decision.errorCode),
          apply: (tx, claim) => deps.repository.deferConsolidation(
            tx,
            claim,
            identity.candidateId,
            initial.decision.errorCode
          ),
          stage: "consolidation_deferred"
        };
      }
      const v1Candidate = isV1Candidate(initial.input.candidate);
      // The v1 comparison contract requires the exact-normalized and vector
      // neighborhood snapshot.  If vector admission is unavailable, reject
      // the candidate without invoking the System Model or mutating facts.
      if (v1Candidate && !deps.neighborhood) {
        return {
          acceptedResultHash: terminalHash(job, initial.input.inputHash, "vector_neighborhood_unavailable"),
          apply: (tx, claim) => deps.repository.deferConsolidation(
            tx,
            claim,
            identity.candidateId,
            "vector_neighborhood_unavailable"
          ),
          stage: "consolidation_deferred"
        };
      }
      const relatedVersionIds = deps.neighborhood
        ? await deps.neighborhood.relatedVersionIds(
            job,
            initial.input.candidate,
            context.signal
          ).catch(() => null)
        : null;
      if (v1Candidate && relatedVersionIds === null) {
        return {
          acceptedResultHash: terminalHash(job, initial.input.inputHash, "vector_neighborhood_unavailable"),
          apply: (tx, claim) => deps.repository.deferConsolidation(
            tx,
            claim,
            identity.candidateId,
            "vector_neighborhood_unavailable"
          ),
          stage: "consolidation_deferred"
        };
      }
      const prepared = relatedVersionIds === null
        ? initial
        : await deps.repository.prepareConsolidation(job, relatedVersionIds);
      if ("decision" in prepared) {
        return {
          acceptedResultHash: terminalHash(job, null, prepared.decision.errorCode),
          apply: (tx, claim) => deps.repository.deferConsolidation(
            tx,
            claim,
            identity.candidateId,
            prepared.decision.errorCode
          ),
          stage: "consolidation_deferred"
        };
      }
      const input: MemoryFactConsolidationInput = prepared.input;
      const recovered = await recoverBinding(
        deps.execution,
        job.userId,
        input.inputHash,
        prior
      );
      if (recovered) {
        return {
          acceptedResultHash: recovered.binding.acceptedOutputHash ??
            terminalHash(job, input.inputHash, "consolidation_outcome_unknown"),
          apply: (tx, claim) => deps.repository.deferConsolidation(
            tx,
            claim,
            identity.candidateId,
            recovered.kind === "SUCCEEDED"
              ? "consolidation_result_unavailable"
              : "consolidation_outcome_unknown"
          ),
          stage: "consolidation_deferred"
        };
      }
      await deps.probeAuthority(job.userId, "MEMORY_CONSOLIDATE").catch((error) => {
        const decision = authorityGate(error);
        throw new MemoryCoordinatorError(decision.errorCode, true);
      });
      await context.setStage("consolidation_binding");
      const binding = await deps.execution.admission.bind(job.userId, {
        inputHash: input.inputHash,
        ordinal: maxOrdinal(prior) + 1,
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
          errorCode: "memory_fact_consolidation_binding_invalid",
          providerResponseId: null,
          state: "FAILED",
          usage: unavailableUsage
        });
        return {
          acceptedResultHash: terminalHash(job, input.inputHash, "binding_invalid"),
          apply: (tx, claim) => deps.repository.deferConsolidation(
            tx,
            claim,
            identity.candidateId,
            "consolidation_binding_invalid"
          ),
          stage: "consolidation_deferred"
        };
      }
      await context.setStage("consolidation_provider_call");
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
        if (failure.classification === "REPLAY_SAFE_TRANSIENT") {
          throw new MemoryCoordinatorError(failure.errorCode, true);
        }
        return {
          acceptedResultHash: terminalHash(job, input.inputHash, failure.errorCode),
          apply: (tx, claim) => deps.repository.deferConsolidation(
            tx,
            claim,
            identity.candidateId,
            failure.errorCode
          ),
          stage: "consolidation_deferred"
        };
      }
      let plan;
      try {
        plan = decodeMemoryFactConsolidation(result.toolCalls, input);
      } catch (error) {
        const code = error instanceof MemoryFactConsolidationDecodeError
          ? error.code
          : "memory_fact_consolidation_output_invalid";
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: code,
          providerResponseId: result.providerResponseId,
          state: "FAILED",
          usage: reportedUsage(result.usage)
        });
        return {
          acceptedResultHash: terminalHash(job, input.inputHash, code),
          apply: (tx, claim) => deps.repository.deferConsolidation(
            tx,
            claim,
            identity.candidateId,
            "consolidation_output_invalid"
          ),
          stage: "consolidation_deferred"
        };
      }
      await deps.execution.lifecycle.settle(job.userId, binding.id, {
        acceptedOutputHash: plan.outputHash,
        errorCode: null,
        providerResponseId: result.providerResponseId,
        state: "SUCCEEDED",
        usage: reportedUsage(result.usage)
      });
      await context.setStage("consolidation_authorized_apply");
      return {
        acceptedResultHash: plan.outputHash,
        apply: (tx, claim) => deps.repository.applyConsolidation(
          tx,
          claim,
          input,
          plan,
          binding.id,
          context.now()
        ),
        stage: "consolidation_applied"
      };
    }
  });
}

export function createMemoryFactVerificationHandler(
  deps: MemoryFactDecisionHandlerDependencies
): MemoryJobHandler {
  return Object.freeze({
    kind: "VERIFY_CANDIDATE" as const,

    async preflight(job) {
      if (!parseMemoryFactVerificationJob(job)) {
        return { errorCode: "memory_fact_verification_job_invalid", status: "CANCELLED" };
      }
      const decision = await deps.repository.preflightVerification(job);
      if (decision.status !== "READY") return decision;
      try {
        await deps.probeAuthority(job.userId, "MEMORY_VERIFY");
        return { status: "READY" };
      } catch (error) {
        return authorityGate(error);
      }
    },

    async execute(job, context) {
      const identity = parseMemoryFactVerificationJob(job);
      if (!identity) {
        return {
          acceptedResultHash: terminalHash(job, null, "verification_job_invalid"),
          stage: "verification_job_invalid"
        };
      }
      await context.setStage("verification_snapshot");
      const prepared = await deps.repository.prepareVerification(job);
      if ("decision" in prepared) {
        return {
          acceptedResultHash: terminalHash(job, null, prepared.decision.errorCode),
          apply: (tx, claim) => deps.repository.staleVerification(
            tx,
            claim,
            identity.decisionId,
            null,
            null,
            context.now()
          ),
          stage: "verification_deferred"
        };
      }
      const input: MemoryFactVerificationInput = prepared.input;
      const prior = await deps.repository.verificationBindings(job.userId, job.id);
      const recovered = await recoverBinding(
        deps.execution,
        job.userId,
        input.inputHash,
        prior
      );
      if (recovered) {
        return {
          acceptedResultHash: recovered.binding.acceptedOutputHash ??
            terminalHash(job, input.inputHash, "verification_outcome_unknown"),
          apply: (tx, claim) => deps.repository.staleVerification(
            tx,
            claim,
            identity.decisionId,
            recovered.kind === "SUCCEEDED" ? recovered.binding.id : null,
            recovered.kind === "SUCCEEDED"
              ? recovered.binding.acceptedOutputHash
              : null,
            context.now()
          ),
          stage: "verification_deferred"
        };
      }
      await deps.probeAuthority(job.userId, "MEMORY_VERIFY").catch((error) => {
        const decision = authorityGate(error);
        throw new MemoryCoordinatorError(decision.errorCode, true);
      });
      await context.setStage("verification_binding");
      const binding = await deps.execution.admission.bind(job.userId, {
        inputHash: input.inputHash,
        ordinal: maxOrdinal(prior) + 1,
        owner: { memoryJobId: job.id, type: "JOB" },
        // Legacy verification rows are no longer admitted by the active
        // execution role manifest. Keep this cast solely so old-row
        // terminalisation code remains decodable without making VERIFY an
        // active destination.
        role: "MEMORY_VERIFY" as MemoryExecutionRole,
        versions: MEMORY_FACT_VERIFICATION_VERSIONS
      });
      const started = await deps.execution.admission.start(job.userId, binding.id);
      if (
        (started.snapshot.logicalRole as string) !== "MEMORY_VERIFY" ||
        !started.snapshot.requiresStrictStructuredOutput
      ) {
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: "memory_fact_verification_binding_invalid",
          providerResponseId: null,
          state: "FAILED",
          usage: unavailableUsage
        });
        return {
          acceptedResultHash: terminalHash(job, input.inputHash, "binding_invalid"),
          apply: (tx, claim) => deps.repository.staleVerification(
            tx,
            claim,
            identity.decisionId,
            null,
            null,
            context.now()
          ),
          stage: "verification_deferred"
        };
      }
      await context.setStage("verification_provider_call");
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
        return {
          acceptedResultHash: terminalHash(job, input.inputHash, failure.errorCode),
          apply: (tx, claim) => deps.repository.staleVerification(
            tx,
            claim,
            identity.decisionId,
            null,
            null,
            context.now()
          ),
          stage: "verification_deferred"
        };
      }
      let plan;
      try {
        plan = decodeMemoryFactVerification(result.toolCalls, input);
      } catch (error) {
        const code = error instanceof MemoryFactConsolidationDecodeError
          ? error.code
          : "memory_fact_verification_output_invalid";
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: code,
          providerResponseId: result.providerResponseId,
          state: "FAILED",
          usage: reportedUsage(result.usage)
        });
        return {
          acceptedResultHash: terminalHash(job, input.inputHash, code),
          apply: (tx, claim) => deps.repository.staleVerification(
            tx,
            claim,
            identity.decisionId,
            null,
            null,
            context.now()
          ),
          stage: "verification_deferred"
        };
      }
      await deps.execution.lifecycle.settle(job.userId, binding.id, {
        acceptedOutputHash: plan.outputHash,
        errorCode: null,
        providerResponseId: result.providerResponseId,
        state: "SUCCEEDED",
        usage: reportedUsage(result.usage)
      });
      await context.setStage("verification_authorized_apply");
      return {
        acceptedResultHash: plan.outputHash,
        apply: (tx, claim) => deps.repository.applyVerification(
          tx,
          claim,
          input,
          plan,
          binding.id,
          context.now()
        ),
        stage: "verification_applied"
      };
    }
  });
}

type PrismaMemoryFactDecisionHandlerOptions = Readonly<{
  provider?: MemoryFactDecisionProvider;
  repository?: MemoryFactConsolidationRepository;
}>;

function createPrismaMemoryFactDecisionDependencies(
  authority: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma,
  options: PrismaMemoryFactDecisionHandlerOptions = {}
): MemoryFactDecisionHandlerDependencies {
  const now = () => memoryExecutionNow(authority);
  const execution = createPrismaMemoryExecutionService(authority, client);
  const repository = options.repository ??
    createPrismaMemoryFactConsolidationRepository(client);
  const dependencies: MemoryFactDecisionHandlerDependencies = {
    execution,
    neighborhood: createMemoryFactNeighborhoodResolver(
      createPrismaMemoryRunUtilityService(authority, client),
      createPrismaMemoryVectorRepository(client)
    ),
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
  };
  return dependencies;
}

/** Active v1 production factory.  Verification is intentionally not built or
 * registered on this path; the legacy two-handler factory below exists only
 * for replay/terminalisation tests of pre-v1 rows. */
export function createPrismaMemoryFactConsolidationHandler(
  authority: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma,
  options: PrismaMemoryFactDecisionHandlerOptions = {}
): MemoryJobHandler {
  return createMemoryFactConsolidationHandler(
    createPrismaMemoryFactDecisionDependencies(authority, client, options)
  );
}

/** @deprecated Use createPrismaMemoryFactConsolidationHandler for active v1. */
export function createPrismaMemoryFactDecisionHandlers(
  authority: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma,
  options: PrismaMemoryFactDecisionHandlerOptions = {}
): Readonly<{
  consolidation: MemoryJobHandler;
  verification: MemoryJobHandler;
}> {
  const dependencies = createPrismaMemoryFactDecisionDependencies(authority, client, options);
  return Object.freeze({
    consolidation: createMemoryFactConsolidationHandler(dependencies),
    verification: createMemoryFactVerificationHandler(dependencies)
  });
}
