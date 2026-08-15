import type { PrismaClient } from "@prisma/client";
import {
  createAcceptedEmbeddingRuntime,
  type AcceptedEmbeddingRuntimeEvidence
} from "../../providerRuntime/embeddingRuntime";
import { ProviderAdmissionError } from "../../providerRuntime/admission";
import {
  EmbeddingAdapterError,
  type EmbeddingResult
} from "../../providers/embeddings";
import { prisma } from "../../prisma";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type {
  MemoryJobDescriptor,
  MemoryJobExecutionResult,
  MemoryJobHandler
} from "../coordinator/types";
import {
  createPrismaMemoryExecutionService,
  memoryExecutionNow,
  MemoryExecutionError,
  resolveCurrentMemoryExecutionAuthority,
  type MemoryExecutionAuthorityDependencies,
  type MemoryExecutionVersions,
  type MemoryReportedUsage,
  type PrismaMemoryExecutionService
} from "../execution";
import { memoryExecutionSha256 } from "../execution/canonical";
import { memoryVectorSpaceFingerprint } from "../execution/policy";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import {
  MEMORY_ITEM_EMBEDDING_VERSIONS,
  memoryItemEmbeddingGenerationMatchesPin,
  memoryItemEmbeddingInputHash,
  memoryItemEmbeddingOutputHash,
  memoryItemEmbeddingPinFromSnapshot,
  parseMemoryEmbeddingJobFingerprint,
  type MemoryItemEmbeddingPin,
  type MemoryItemEmbeddingTarget
} from "./contract";
import {
  createPrismaMemoryItemEmbeddingRepository,
  type MemoryItemEmbeddingRepository
} from "./repository";

type AcceptedEmbeddingRuntime = ReturnType<
  typeof createAcceptedEmbeddingRuntime
>;

export type MemoryItemEmbeddingHandlerDependencies = Readonly<{
  execution: PrismaMemoryExecutionService;
  now: () => Date;
  probeAuthority: (
    userId: string,
    versions: MemoryExecutionVersions
  ) => Promise<MemoryItemEmbeddingPin>;
  repository: MemoryItemEmbeddingRepository;
  runtime: AcceptedEmbeddingRuntime;
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

const uncertainEmbeddingErrors = new Set([
  "embedding_provider_request_failed",
  "embedding_request_timed_out"
]);

const deterministicInputErrors = new Set([
  "embedding_batch_invalid",
  "embedding_input_invalid",
  "embedding_request_too_large"
]);

function resultUsage(result: EmbeddingResult): MemoryReportedUsage {
  const { inputTokens, totalTokens } = result.usage;
  if (inputTokens === null && totalTokens === null) return unavailableUsage;
  const complete = inputTokens !== null && totalTokens !== null;
  return {
    cachedInputTokens: 0,
    completeness: complete ? "COMPLETE" : "PARTIAL",
    estimatedCostMicros: null,
    inputTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens
  };
}

function terminalResult(
  job: MemoryJobDescriptor,
  target: MemoryItemEmbeddingTarget | null,
  reason: string
): MemoryJobExecutionResult {
  return {
    acceptedResultHash: memoryExecutionSha256({
      domain: "aiqsa.memory.item-embedding-local-terminal",
      entryId: target?.entryId ?? null,
      generationId: target?.generation.id ?? null,
      itemId: target?.itemId ?? null,
      itemType: target?.itemType ?? null,
      jobId: job.id,
      reason,
      safeContentHash: target?.safeContentHash ?? null,
      version: "v1"
    }),
    stage: "local_terminal"
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
      return {
        errorCode: error.code,
        status: "WAITING_FOR_EGRESS_CONSENT" as const
      };
    }
    return {
      errorCode: error.code,
      status: "CANCELLED" as const
    };
  }
  if (error instanceof ProviderAdmissionError) {
    return {
      errorCode: "memory_execution_target_unavailable",
      status: "WAITING_FOR_EGRESS_CONSENT" as const
    };
  }
  throw error;
}

function runtimeEvidence(
  snapshot: Parameters<typeof memoryItemEmbeddingPinFromSnapshot>[0]
): AcceptedEmbeddingRuntimeEvidence {
  const provider = snapshot.providerExecutionSnapshot;
  if (!provider.credentialId || !provider.credentialVersionId) {
    throw new MemoryCoordinatorError("memory_embedding_binding_invalid", false);
  }
  return {
    connectionId: provider.connectionId,
    credentialId: provider.credentialId,
    credentialVersionId: provider.credentialVersionId,
    executionSnapshot: provider,
    providerModelId: provider.providerModelId
  };
}

function maxOrdinal(bindings: Awaited<
  ReturnType<MemoryItemEmbeddingRepository["bindings"]>
>): number {
  return bindings.reduce((maximum, binding) =>
    Math.max(maximum, binding.ordinal), -1);
}

async function settleAbandonedBindings(
  deps: MemoryItemEmbeddingHandlerDependencies,
  job: MemoryJobDescriptor,
  target: MemoryItemEmbeddingTarget,
  inputHash: string
): Promise<Readonly<{
  bindings: Awaited<ReturnType<MemoryItemEmbeddingRepository["bindings"]>>;
  succeededHash: string | null;
}>> {
  const bindings = await deps.repository.bindings(job.userId, job.id);
  if (bindings.some((binding) => binding.inputHash !== inputHash)) {
    throw new MemoryCoordinatorError("memory_embedding_binding_stale", false);
  }
  const succeeded = bindings.find((binding) => binding.state === "SUCCEEDED");
  if (succeeded) {
    if (target.embeddingState === "READY" && succeeded.acceptedOutputHash) {
      return { bindings, succeededHash: succeeded.acceptedOutputHash };
    }
    await deps.repository.applyFailed(target, deps.now());
    throw new MemoryCoordinatorError("memory_embedding_result_unavailable", false);
  }
  const uncertain = bindings.find((binding) =>
    binding.state === "RUNNING" || binding.state === "OUTCOME_UNKNOWN");
  if (uncertain) {
    if (uncertain.state === "RUNNING") {
      await deps.execution.lifecycle.settle(job.userId, uncertain.id, {
        acceptedOutputHash: null,
        errorCode: "memory_embedding_recovered_uncertain",
        providerResponseId: null,
        state: "OUTCOME_UNKNOWN",
        usage: unavailableUsage
      });
    }
    await deps.repository.applyFailed(target, deps.now());
    throw new MemoryCoordinatorError("memory_embedding_outcome_unknown", false);
  }
  for (const pending of bindings.filter((binding) => binding.state === "PENDING")) {
    await deps.execution.lifecycle.settle(job.userId, pending.id, {
      acceptedOutputHash: null,
      errorCode: "memory_embedding_execution_abandoned",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
  }
  return { bindings, succeededHash: null };
}

function embeddingContract(target: MemoryItemEmbeddingTarget): Readonly<{
  inputHash: string;
  outputHash: (vector: readonly number[]) => string;
  versions: MemoryExecutionVersions;
}> {
  const inputHash = memoryItemEmbeddingInputHash(target);
  return {
    inputHash,
    outputHash: (vector) => memoryItemEmbeddingOutputHash({ inputHash, vector }),
    versions: MEMORY_ITEM_EMBEDDING_VERSIONS
  };
}

export function createMemoryItemEmbeddingHandler(
  deps: MemoryItemEmbeddingHandlerDependencies
): MemoryJobHandler {
  return Object.freeze({
    kind: "EMBED_ITEMS" as const,

    async preflight(job) {
      const identity = parseMemoryEmbeddingJobFingerprint(
        job.idempotencyFingerprint
      );
      if (
        job.kind !== "EMBED_ITEMS" ||
        job.pipelineVersion !== identity?.pipelineVersion ||
        !identity
      ) {
        return {
          errorCode: "memory_embedding_job_invalid",
          status: "CANCELLED"
        };
      }
      const target = await deps.repository.loadTarget(job.userId, identity.entryId);
      if (!target) {
        return { errorCode: "memory_embedding_target_stale", status: "STALE" };
      }
      const contract = embeddingContract(target);
      if (target.embeddingState === "READY") return { status: "READY" };
      try {
        const pin = await deps.probeAuthority(job.userId, contract.versions);
        if (!memoryItemEmbeddingGenerationMatchesPin(target.generation, pin)) {
          return {
            errorCode: "memory_embedding_generation_changed",
            status: "CANCELLED"
          };
        }
        return { status: "READY" };
      } catch (error) {
        return authorityGate(error);
      }
    },

    async execute(job, context) {
      const identity = parseMemoryEmbeddingJobFingerprint(
        job.idempotencyFingerprint
      );
      if (!identity) return terminalResult(job, null, "invalid");
      const target = await deps.repository.loadTarget(job.userId, identity.entryId);
      if (!target) return terminalResult(job, null, "stale");
      const contract = embeddingContract(target);
      if (job.pipelineVersion !== identity.pipelineVersion) {
        return terminalResult(job, target, "invalid_contract");
      }
      const { inputHash } = contract;
      const recovered = await settleAbandonedBindings(
        deps,
        job,
        target,
        inputHash
      );
      if (recovered.succeededHash) {
        return {
          acceptedResultHash: recovered.succeededHash,
          stage: "vector_ready"
        };
      }
      if (target.embeddingState === "READY") {
        return terminalResult(job, target, "ready");
      }

      const pin = await deps.probeAuthority(
        job.userId,
        contract.versions
      ).catch((error: unknown) => {
        const decision = authorityGate(error);
        throw new MemoryCoordinatorError(decision.errorCode, true);
      });
      if (!memoryItemEmbeddingGenerationMatchesPin(target.generation, pin)) {
        return terminalResult(job, target, "generation_changed");
      }

      await context.setStage("binding");
      const binding = await deps.execution.admission.bind(job.userId, {
        inputHash,
        ordinal: maxOrdinal(recovered.bindings) + 1,
        owner: { memoryJobId: job.id, type: "JOB" },
        role: "MEMORY_DOCUMENT_EMBED",
        versions: contract.versions
      });
      const started = await deps.execution.admission.start(job.userId, binding.id);
      const acceptedPin = memoryItemEmbeddingPinFromSnapshot(started.snapshot);
      if (
        !acceptedPin ||
        !memoryItemEmbeddingGenerationMatchesPin(target.generation, acceptedPin)
      ) {
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: "memory_embedding_generation_changed",
          providerResponseId: null,
          state: "FAILED",
          usage: unavailableUsage
        });
        throw new MemoryCoordinatorError("memory_embedding_generation_changed", false);
      }
      if (context.signal.aborted) throw context.signal.reason;

      await context.setStage("provider_call");
      let result: EmbeddingResult;
      let runtime: Awaited<ReturnType<AcceptedEmbeddingRuntime["resolve"]>>;
      try {
        runtime = await deps.runtime.resolve(runtimeEvidence(started.snapshot));
      } catch (error) {
        if (context.signal.aborted) throw error;
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: "memory_embedding_credential_unavailable",
          providerResponseId: null,
          state: "FAILED",
          usage: unavailableUsage
        });
        await deps.repository.applyFailed(target, deps.now());
        throw new MemoryCoordinatorError(
          "memory_embedding_credential_unavailable",
          true
        );
      }
      try {
        result = await runtime.adapter.embed({
          mode: "document",
          signal: context.signal,
          texts: [target.normalizedSearchText]
        });
      } catch (error) {
        if (context.signal.aborted) throw error;
        if (
          !(error instanceof EmbeddingAdapterError) ||
          uncertainEmbeddingErrors.has(error.code)
        ) {
          await deps.execution.lifecycle.settle(job.userId, binding.id, {
            acceptedOutputHash: null,
            errorCode: error instanceof EmbeddingAdapterError
              ? error.code
              : "memory_embedding_provider_outcome_unknown",
            providerResponseId: null,
            state: "OUTCOME_UNKNOWN",
            usage: unavailableUsage
          });
          await deps.repository.applyFailed(target, deps.now());
          throw new MemoryCoordinatorError("memory_embedding_outcome_unknown", false);
        }
        const code = error instanceof EmbeddingAdapterError
          ? error.code
          : "memory_embedding_provider_failed";
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: code,
          providerResponseId: null,
          state: "FAILED",
          usage: unavailableUsage
        });
        await deps.repository.applyFailed(target, deps.now());
        throw new MemoryCoordinatorError(
          code,
          !deterministicInputErrors.has(error.code)
        );
      }

      if (context.signal.aborted) throw context.signal.reason;
      const vector = result.vectors[0];
      const squaredNorm = vector?.reduce(
        (total, value) => total + value * value,
        0
      ) ?? 0;
      if (
        result.vectors.length !== 1 ||
        !vector ||
        vector.length !== acceptedPin.dimension ||
        vector.some((value) => !Number.isFinite(value)) ||
        !Number.isFinite(squaredNorm) ||
        squaredNorm <= 0
      ) {
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: "memory_embedding_output_invalid",
          providerResponseId: result.requestId,
          state: "FAILED",
          usage: resultUsage(result)
        });
        await deps.repository.applyFailed(target, deps.now());
        throw new MemoryCoordinatorError("memory_embedding_output_invalid", true);
      }
      const outputHash = contract.outputHash(vector);
      await deps.execution.lifecycle.settle(job.userId, binding.id, {
        acceptedOutputHash: outputHash,
        errorCode: null,
        providerResponseId: result.requestId,
        state: "SUCCEEDED",
        usage: resultUsage(result)
      });
      if (context.signal.aborted) throw context.signal.reason;

      await context.setStage("authorized_apply");
      let applied: Awaited<ReturnType<MemoryItemEmbeddingRepository["applyReady"]>>;
      try {
        applied = await deps.execution.lifecycle.withAuthorizedResultCommit(
          job.userId,
          { acceptedOutputHash: outputHash, bindingId: binding.id },
          (tx, evidence) => deps.repository.applyReady(
            tx,
            evidence.settings,
            target,
            acceptedPin,
            vector,
            context.now()
          )
        );
      } catch (error) {
        await deps.repository.applyFailed(target, deps.now());
        throw new MemoryCoordinatorError("memory_embedding_apply_rejected", false);
      }
      if (applied === "STALE") {
        await deps.repository.applyFailed(target, deps.now());
        return terminalResult(job, target, "stale_apply");
      }
      return { acceptedResultHash: outputHash, stage: "vector_ready" };
    }
  });
}

export function createPrismaMemoryItemEmbeddingHandler(
  authority: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma,
  options: Readonly<{
    repository?: MemoryItemEmbeddingRepository;
    runtime?: AcceptedEmbeddingRuntime;
  }> = {}
): MemoryJobHandler {
  const now = () => memoryExecutionNow(authority);
  return createMemoryItemEmbeddingHandler({
    execution: createPrismaMemoryExecutionService(authority, client),
    now,
    probeAuthority: (userId, versions) => probeCurrentMemoryEmbeddingPin(
      authority,
      client,
      userId,
      versions
    ),
    repository: options.repository ??
      createPrismaMemoryItemEmbeddingRepository(client),
    runtime: options.runtime ?? createAcceptedEmbeddingRuntime(client)
  });
}

export function probeCurrentMemoryEmbeddingPin(
  authority: MemoryExecutionAuthorityDependencies,
  client: PrismaClient,
  userId: string,
  versions: MemoryExecutionVersions = MEMORY_ITEM_EMBEDDING_VERSIONS
): Promise<MemoryItemEmbeddingPin> {
  const now = () => memoryExecutionNow(authority);
  return withLockedMemoryTransaction(
    client,
    userId,
    async (tx, settings) => {
      const resolved = await resolveCurrentMemoryExecutionAuthority(tx, settings, {
        dependencies: authority,
        now: now(),
        role: "MEMORY_DOCUMENT_EMBED",
        userId,
        versions
      });
      const model = resolved.target.snapshot.model;
      const vectorSpaceFingerprint = memoryVectorSpaceFingerprint(resolved.target);
      if (
        model.adapterKind !== "openai_embeddings_compatible" ||
        model.modelClass !== "embedding" ||
        !model.embedding ||
        !vectorSpaceFingerprint
      ) {
        throw new MemoryExecutionError("memory_execution_capability_unavailable");
      }
      return {
        configurationFingerprint:
          resolved.compatibility.requirement.configFingerprint,
        connectionId: resolved.target.authority.connectionId,
        dimension: model.embedding.targetDimension,
        providerModelId: resolved.target.authority.providerModelId,
        vectorSpaceFingerprint
      };
    }
  );
}
