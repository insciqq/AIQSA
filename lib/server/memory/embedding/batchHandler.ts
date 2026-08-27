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
  parseMemoryExecutionSnapshot,
  type MemoryExecutionAuthorityDependencies,
  type MemoryExecutionVersions,
  type MemoryReportedUsage,
  type PrismaMemoryExecutionService
} from "../execution";
import { memoryExecutionSha256 } from "../execution/canonical";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from "../retrieval/vector";
import {
  MEMORY_EMBEDDING_BATCH_PIPELINE_VERSION,
  MEMORY_EMBEDDING_BATCH_VERSIONS,
  MAX_MEMORY_EMBEDDING_BATCH_SIZE,
  memoryEmbeddingBatchInputHash,
  memoryEmbeddingBatchOutputHash,
  memoryItemEmbeddingGenerationMatchesPin,
  memoryItemEmbeddingPinFromSnapshot,
  parseMemoryEmbeddingBatchJobFingerprint,
  renderMemoryDocumentEmbeddingText,
  type MemoryEmbeddingBatchInputItem,
  type MemoryItemEmbeddingPin,
  type MemoryItemEmbeddingTarget
} from "./contract";
import {
  createPrismaMemoryEmbeddingBatchRepository,
  type MemoryEmbeddingBatchBinding,
  type MemoryEmbeddingBatchRepository,
  type MemoryEmbeddingBatchStoredItem
} from "./batchRepository";
import {
  createPrismaMemoryItemEmbeddingRepository,
  type MemoryItemEmbeddingRepository
} from "./repository";
import { probeCurrentMemoryEmbeddingPin } from "./handler";

type AcceptedEmbeddingRuntime = ReturnType<
  typeof createAcceptedEmbeddingRuntime
>;

export type MemoryEmbeddingBatchHandlerDependencies = Readonly<{
  execution: PrismaMemoryExecutionService;
  itemRepository: MemoryItemEmbeddingRepository;
  now: () => Date;
  probeAuthority: (
    userId: string,
    versions: MemoryExecutionVersions
  ) => Promise<MemoryItemEmbeddingPin>;
  repository: MemoryEmbeddingBatchRepository;
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

function boundedResponseId(value: string | null): string | null {
  return value && value.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,254}$/u.test(value)
    ? value
    : null;
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
    return { errorCode: error.code, status: "CANCELLED" as const };
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

function validVector(vector: readonly number[], dimension: number): boolean {
  if (!Array.isArray(vector) || vector.length !== dimension) return false;
  let squaredNorm = 0;
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    squaredNorm += value * value;
  }
  return Number.isFinite(squaredNorm) && squaredNorm > 0;
}

function currentBatchTarget(target: MemoryItemEmbeddingTarget): boolean {
  return target.generation.retrievalPipelineVersion ===
    MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION;
}

function validBatch(
  job: MemoryJobDescriptor,
  items: readonly MemoryEmbeddingBatchStoredItem[]
): boolean {
  const identity = parseMemoryEmbeddingBatchJobFingerprint(
    job.idempotencyFingerprint
  );
  return Boolean(identity) &&
    job.kind === "EMBED_ITEMS" &&
    job.pipelineVersion === MEMORY_EMBEDDING_BATCH_PIPELINE_VERSION &&
    job.pipelineVersion === identity?.pipelineVersion &&
    items.length >= 1 &&
    items.length <= MAX_MEMORY_EMBEDDING_BATCH_SIZE &&
    items.every((item, index) =>
      item.userId === job.userId &&
      item.memoryJobId === job.id &&
      item.ordinal >= 0 &&
      item.ordinal < MAX_MEMORY_EMBEDDING_BATCH_SIZE &&
      (index === 0 || item.ordinal > items[index - 1]!.ordinal) &&
      item.indexGenerationId === items[0]?.indexGenerationId) &&
    items.every((item) => item.ordinal !== 0 || (
      item.searchEntryId === identity?.seedEntryId &&
      item.triggerIdentityHash === identity?.triggerHash
    ));
}

function batchItems(
  items: readonly MemoryEmbeddingBatchStoredItem[]
): readonly MemoryEmbeddingBatchInputItem[] {
  return items.flatMap((item) => item.target ? [{
    ordinal: item.ordinal,
    target: item.target,
    triggerIdentityHash: item.triggerIdentityHash
  }] : []);
}

function terminalHash(
  job: MemoryJobDescriptor,
  items: readonly MemoryEmbeddingBatchStoredItem[],
  reason: string
): string {
  return items.find((item) => item.acceptedOutputHash)?.acceptedOutputHash ??
    memoryExecutionSha256({
      domain: "aiqsa.memory.embedding-batch-terminal",
      items: items.map((item) => ({
        id: item.id,
        ordinal: item.ordinal,
        state: item.state
      })),
      jobId: job.id,
      reason,
      version: 2
    });
}

function operationalCounters(
  items: readonly MemoryEmbeddingBatchStoredItem[],
  providerRequests: number
) {
  return {
    embeddingBatchItems: items.length,
    embeddingFailedItems: items.filter((item) =>
      item.state === "FAILED" || item.state === "OUTCOME_UNKNOWN").length,
    embeddingProviderRequests: providerRequests,
    embeddingSettledItems: items.filter((item) => item.state === "SETTLED").length,
    embeddingStaleItems: items.filter((item) => item.state === "STALE").length
  } as const;
}

function maxBindingOrdinal(bindings: readonly MemoryEmbeddingBatchBinding[]): number {
  return bindings.reduce((maximum, binding) =>
    Math.max(maximum, binding.ordinal), -1);
}

function accountedProviderRequests(
  bindings: readonly MemoryEmbeddingBatchBinding[]
): number {
  return bindings.filter((binding) =>
    binding.state === "SUCCEEDED" ||
    binding.state === "OUTCOME_UNKNOWN" ||
    binding.state === "RUNNING").length;
}

async function markTargetsFailed(
  deps: MemoryEmbeddingBatchHandlerDependencies,
  items: readonly MemoryEmbeddingBatchStoredItem[]
): Promise<void> {
  for (const item of items) {
    if (item.target) {
      await deps.itemRepository.applyFailed(item.target, deps.now())
        .catch(() => undefined);
    }
  }
}

async function applyDurableResults(
  deps: MemoryEmbeddingBatchHandlerDependencies,
  job: MemoryJobDescriptor,
  items: readonly MemoryEmbeddingBatchStoredItem[],
  bindings: readonly MemoryEmbeddingBatchBinding[],
  now: Date
): Promise<void> {
  const byId = new Map(bindings.map((binding) => [binding.id, binding]));
  for (const item of items) {
    if (item.state !== "RESULT_READY") continue;
    const binding = item.executionBindingId
      ? byId.get(item.executionBindingId)
      : undefined;
    if (
      !binding ||
      binding.state !== "SUCCEEDED" ||
      !binding.acceptedOutputHash ||
      binding.acceptedOutputHash !== item.acceptedOutputHash ||
      !item.target
    ) {
      await deps.repository.mark(
        job.userId,
        [item.id],
        "STALE",
        "memory_embedding_batch_result_stale",
        now
      );
      continue;
    }
    const snapshot = parseMemoryExecutionSnapshot(
      binding.secretFreeExecutionSnapshot
    );
    const pin = memoryItemEmbeddingPinFromSnapshot(snapshot);
    if (
      !pin ||
      item.target.generation.id !== item.indexGenerationId ||
      !currentBatchTarget(item.target) ||
      !memoryItemEmbeddingGenerationMatchesPin(item.target.generation, pin)
    ) {
      await deps.repository.mark(
        job.userId,
        [item.id],
        "STALE",
        "memory_embedding_batch_generation_stale",
        now
      );
      continue;
    }
    try {
      await deps.execution.lifecycle.withAuthorizedResultCommit(
        job.userId,
        {
          acceptedOutputHash: binding.acceptedOutputHash,
          bindingId: binding.id
        },
        (tx, evidence) => deps.repository.applyResult(
          tx,
          evidence.settings,
          item,
          item.target!,
          pin,
          now
        )
      );
    } catch {
      throw new MemoryCoordinatorError(
        "memory_embedding_batch_apply_retryable",
        true
      );
    }
  }
}

export function createMemoryEmbeddingBatchHandler(
  deps: MemoryEmbeddingBatchHandlerDependencies
): MemoryJobHandler {
  return Object.freeze({
    kind: "EMBED_ITEMS" as const,

    async preflight(job) {
      const items = await deps.repository.load(job.userId, job.id);
      const identity = parseMemoryEmbeddingBatchJobFingerprint(
        job.idempotencyFingerprint
      );
      if (
        identity &&
        job.kind === "EMBED_ITEMS" &&
        job.pipelineVersion === identity.pipelineVersion &&
        items.length === 0
      ) {
        return {
          errorCode: "memory_embedding_batch_target_stale",
          status: "STALE"
        };
      }
      if (!validBatch(job, items)) {
        return { errorCode: "memory_embedding_batch_invalid", status: "CANCELLED" };
      }
      const pending = items.filter((item) =>
        item.state === "PENDING" && item.target !== null);
      if (pending.length === 0 || items.some((item) => item.state === "RESULT_READY")) {
        return { status: "READY" };
      }
      const targets = batchItems(pending);
      if (
        targets.length !== pending.length ||
        targets.some(({ target }) =>
          target.generation.id !== pending[0]?.indexGenerationId ||
          !currentBatchTarget(target))
      ) return { status: "READY" };
      try {
        const pin = await deps.probeAuthority(
          job.userId,
          MEMORY_EMBEDDING_BATCH_VERSIONS
        );
        if (targets.some(({ target }) =>
          !memoryItemEmbeddingGenerationMatchesPin(target.generation, pin))) {
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
      let items = await deps.repository.load(job.userId, job.id);
      if (!validBatch(job, items)) {
        return {
          acceptedResultHash: terminalHash(job, items, "invalid"),
          operationalCounters: operationalCounters(items, 0),
          stage: "local_terminal"
        };
      }
      let bindings = await deps.repository.bindings(job.userId, job.id);
      await applyDurableResults(deps, job, items, bindings, context.now());
      items = await deps.repository.load(job.userId, job.id);
      if (items.every((item) =>
        ["FAILED", "OUTCOME_UNKNOWN", "SETTLED", "STALE"].includes(item.state))) {
        return {
          acceptedResultHash: terminalHash(job, items, "recovered"),
          operationalCounters: operationalCounters(
            items,
            accountedProviderRequests(bindings)
          ),
          stage: "batch_settled"
        };
      }

      const uncertain = bindings.find((binding) =>
        binding.state === "RUNNING" || binding.state === "OUTCOME_UNKNOWN");
      const pendingItems = items.filter((item) => item.state === "PENDING");
      if (uncertain) {
        if (uncertain.state === "RUNNING") {
          await deps.execution.lifecycle.settle(job.userId, uncertain.id, {
            acceptedOutputHash: null,
            errorCode: "memory_embedding_batch_recovered_uncertain",
            providerResponseId: null,
            state: "OUTCOME_UNKNOWN",
            usage: unavailableUsage
          });
        }
        await deps.repository.mark(
          job.userId,
          pendingItems.map(({ id }) => id),
          "OUTCOME_UNKNOWN",
          "memory_embedding_batch_outcome_unknown",
          deps.now()
        );
        await markTargetsFailed(deps, pendingItems);
        throw new MemoryCoordinatorError(
          "memory_embedding_batch_outcome_unknown",
          false
        );
      }
      const succeededWithoutResult = bindings.find((binding) =>
        binding.state === "SUCCEEDED" &&
        !items.some((item) => item.executionBindingId === binding.id));
      if (succeededWithoutResult) {
        await deps.repository.mark(
          job.userId,
          pendingItems.map(({ id }) => id),
          "OUTCOME_UNKNOWN",
          "memory_embedding_batch_result_missing",
          deps.now()
        );
        await markTargetsFailed(deps, pendingItems);
        throw new MemoryCoordinatorError(
          "memory_embedding_batch_result_missing",
          false
        );
      }
      for (const binding of bindings.filter(({ state }) => state === "PENDING")) {
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: "memory_embedding_batch_execution_abandoned",
          providerResponseId: null,
          state: "FAILED",
          usage: unavailableUsage
        });
      }

      const locallyStale = pendingItems.filter((item) =>
        !item.target ||
        item.target.embeddingState === "READY" ||
        !currentBatchTarget(item.target) ||
        item.target.generation.id !== item.indexGenerationId);
      await deps.repository.mark(
        job.userId,
        locallyStale.map(({ id }) => id),
        "STALE",
        "memory_embedding_batch_target_stale",
        deps.now()
      );
      items = await deps.repository.load(job.userId, job.id);
      let requestItems = items.filter((item) =>
        item.state === "PENDING" && item.target !== null);
      if (requestItems.length === 0) {
        return {
          acceptedResultHash: terminalHash(job, items, "no_pending_targets"),
          operationalCounters: operationalCounters(items, 0),
          stage: "local_terminal"
        };
      }

      const pin = await deps.probeAuthority(
        job.userId,
        MEMORY_EMBEDDING_BATCH_VERSIONS
      ).catch((error: unknown) => {
        const decision = authorityGate(error);
        throw new MemoryCoordinatorError(decision.errorCode, true);
      });
      const incompatible = requestItems.filter((item) =>
        !item.target ||
        !currentBatchTarget(item.target) ||
        !memoryItemEmbeddingGenerationMatchesPin(item.target.generation, pin));
      if (incompatible.length > 0) {
        await deps.repository.mark(
          job.userId,
          incompatible.map(({ id }) => id),
          "STALE",
          "memory_embedding_batch_generation_changed",
          deps.now()
        );
        items = await deps.repository.load(job.userId, job.id);
        requestItems = items.filter((item) =>
          item.state === "PENDING" && item.target !== null);
      }
      if (requestItems.length === 0) {
        return {
          acceptedResultHash: terminalHash(job, items, "generation_changed"),
          operationalCounters: operationalCounters(items, 0),
          stage: "local_terminal"
        };
      }
      const targets = batchItems(requestItems);
      const dimension = pin.dimension;
      const generationId = requestItems[0]!.indexGenerationId;
      const inputHash = memoryEmbeddingBatchInputHash({
        dimension,
        generationId,
        items: targets
      });

      await context.setStage("batch_binding");
      bindings = await deps.repository.bindings(job.userId, job.id);
      const binding = await deps.execution.admission.bind(job.userId, {
        inputHash,
        ordinal: maxBindingOrdinal(bindings) + 1,
        owner: { memoryJobId: job.id, type: "JOB" },
        role: "MEMORY_DOCUMENT_EMBED",
        versions: MEMORY_EMBEDDING_BATCH_VERSIONS
      });
      const started = await deps.execution.admission.start(job.userId, binding.id);
      const acceptedPin = memoryItemEmbeddingPinFromSnapshot(started.snapshot);
      if (
        !acceptedPin ||
        requestItems.some((item) =>
          !item.target ||
          !currentBatchTarget(item.target) ||
          !memoryItemEmbeddingGenerationMatchesPin(
            item.target.generation,
            acceptedPin
          ))
      ) {
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: "memory_embedding_generation_changed",
          providerResponseId: null,
          state: "FAILED",
          usage: unavailableUsage
        });
        await deps.repository.mark(
          job.userId,
          requestItems.map(({ id }) => id),
          "STALE",
          "memory_embedding_batch_generation_changed",
          deps.now()
        );
        return {
          acceptedResultHash: terminalHash(job, items, "accepted_pin_changed"),
          operationalCounters: operationalCounters(
            await deps.repository.load(job.userId, job.id),
            0
          ),
          stage: "local_terminal"
        };
      }

      await context.setStage("batch_provider_call");
      let runtime: Awaited<ReturnType<AcceptedEmbeddingRuntime["resolve"]>>;
      try {
        runtime = await deps.runtime.resolve(runtimeEvidence(started.snapshot));
      } catch {
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: "memory_embedding_credential_unavailable",
          providerResponseId: null,
          state: "FAILED",
          usage: unavailableUsage
        });
        await deps.repository.retryableFailure(
          job.userId,
          requestItems.map(({ id }) => id),
          "memory_embedding_credential_unavailable"
        );
        throw new MemoryCoordinatorError(
          "memory_embedding_credential_unavailable",
          true
        );
      }

      let result: EmbeddingResult;
      try {
        result = await runtime.adapter.embed({
          mode: "document",
          signal: context.signal,
          texts: requestItems.map((item) =>
            renderMemoryDocumentEmbeddingText(item.target!))
        });
      } catch (error) {
        const code = error instanceof EmbeddingAdapterError
          ? error.code
          : "memory_embedding_provider_outcome_unknown";
        const uncertain = !(error instanceof EmbeddingAdapterError) ||
          uncertainEmbeddingErrors.has(error.code) || context.signal.aborted;
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: code,
          providerResponseId: null,
          state: uncertain ? "OUTCOME_UNKNOWN" : "FAILED",
          usage: unavailableUsage
        });
        if (uncertain) {
          await deps.repository.mark(
            job.userId,
            requestItems.map(({ id }) => id),
            "OUTCOME_UNKNOWN",
            code,
            deps.now()
          );
          await markTargetsFailed(deps, requestItems);
          throw new MemoryCoordinatorError(
            "memory_embedding_batch_outcome_unknown",
            false
          );
        }
        if (deterministicInputErrors.has(code)) {
          await deps.repository.mark(
            job.userId,
            requestItems.map(({ id }) => id),
            "FAILED",
            code,
            deps.now()
          );
          await markTargetsFailed(deps, requestItems);
          throw new MemoryCoordinatorError(code, false);
        }
        await deps.repository.retryableFailure(
          job.userId,
          requestItems.map(({ id }) => id),
          code
        );
        throw new MemoryCoordinatorError(code, true);
      }

      const vectors = result.vectors;
      if (
        vectors.length !== requestItems.length ||
        vectors.some((vector) => !validVector(vector, acceptedPin.dimension))
      ) {
        await deps.execution.lifecycle.settle(job.userId, binding.id, {
          acceptedOutputHash: null,
          errorCode: "memory_embedding_batch_output_invalid",
          providerResponseId: boundedResponseId(result.requestId),
          state: "FAILED",
          usage: resultUsage(result)
        });
        await deps.repository.retryableFailure(
          job.userId,
          requestItems.map(({ id }) => id),
          "memory_embedding_batch_output_invalid"
        );
        throw new MemoryCoordinatorError(
          "memory_embedding_batch_output_invalid",
          true
        );
      }
      const outputHash = memoryEmbeddingBatchOutputHash({ inputHash, vectors });
      await deps.execution.lifecycle.settleSucceededWithDurableResult(
        job.userId,
        binding.id,
        {
          acceptedOutputHash: outputHash,
          errorCode: null,
          providerResponseId: boundedResponseId(result.requestId),
          state: "SUCCEEDED",
          usage: resultUsage(result)
        },
        (tx) => deps.repository.persistResult(tx, {
          acceptedOutputHash: outputHash,
          bindingId: binding.id,
          dimension: acceptedPin.dimension,
          inputHash,
          itemIds: requestItems.map(({ id }) => id),
          userId: job.userId,
          vectors
        })
      );

      await context.setStage("batch_authorized_apply");
      items = await deps.repository.load(job.userId, job.id);
      bindings = await deps.repository.bindings(job.userId, job.id);
      await applyDurableResults(deps, job, items, bindings, context.now());
      items = await deps.repository.load(job.userId, job.id);
      return {
        acceptedResultHash: outputHash,
        operationalCounters: operationalCounters(
          items,
          accountedProviderRequests(bindings)
        ),
        stage: "batch_settled"
      };
    }
  });
}

export function createPrismaMemoryEmbeddingBatchHandler(
  authority: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma,
  options: Readonly<{
    itemRepository?: MemoryItemEmbeddingRepository;
    repository?: MemoryEmbeddingBatchRepository;
    runtime?: AcceptedEmbeddingRuntime;
  }> = {}
): MemoryJobHandler {
  const itemRepository = options.itemRepository ??
    createPrismaMemoryItemEmbeddingRepository(client);
  return createMemoryEmbeddingBatchHandler({
    execution: createPrismaMemoryExecutionService(authority, client),
    itemRepository,
    now: () => memoryExecutionNow(authority),
    probeAuthority: (userId, versions) => probeCurrentMemoryEmbeddingPin(
      authority,
      client,
      userId,
      versions
    ),
    repository: options.repository ??
      createPrismaMemoryEmbeddingBatchRepository(client, itemRepository),
    runtime: options.runtime ?? createAcceptedEmbeddingRuntime(client)
  });
}
