import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MemoryJobClaim } from "../coordinator/types";
import { MemoryCoordinatorError } from "../coordinator/errors";
import {
  MEMORY_EMBEDDING_BATCH_PIPELINE_VERSION,
  MEMORY_EMBEDDING_BATCH_VERSIONS,
  memoryEmbeddingBatchJobFingerprint,
  memoryEmbeddingBatchTriggerHash,
  renderMemoryDocumentEmbeddingText,
  type MemoryFactEmbeddingTarget,
  type MemoryItemEmbeddingPin
} from "./contract";
import {
  createMemoryEmbeddingBatchHandler,
  type MemoryEmbeddingBatchHandlerDependencies
} from "./batchHandler";

const now = new Date("2026-08-27T07:00:00.000Z");
const entryIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222"
] as const;
const pin: MemoryItemEmbeddingPin = Object.freeze({
  configurationFingerprint: "c".repeat(64),
  connectionId: "connection-1",
  dimension: 2,
  providerModelId: "model-1",
  vectorSpaceFingerprint: "d".repeat(64)
});

function target(index: number): MemoryFactEmbeddingTarget {
  const entryId = entryIds[index]!;
  return {
    embeddingState: "PENDING",
    entryId,
    factId: `fact-${index}`,
    factVersionId: `version-${index}`,
    generation: {
      embeddingConfigurationFingerprint: pin.configurationFingerprint,
      embeddingConnectionId: pin.connectionId,
      embeddingDimension: pin.dimension,
      embeddingProviderModelId: pin.providerModelId,
      id: "generation-1",
      indexMode: "HYBRID",
      retrievalPipelineVersion: "memory-personal-retrieval-v8-vector",
      vectorSpaceFingerprint: pin.vectorSpaceFingerprint
    },
    itemId: `version-${index}`,
    itemType: "FACT_VERSION",
    normalizedSearchText: `remember exact detail ${index}`,
    safeContentHash: String(index + 1).repeat(64),
    selectedEmbeddingProviderModelId: pin.providerModelId,
    userId: "user-1"
  };
}

function claim(): MemoryJobClaim {
  return {
    activeLeafMessageId: null,
    attemptCount: 1,
    branchGeneration: null,
    chatId: null,
    claimToken: randomUUID(),
    id: "batch-job-1",
    idempotencyFingerprint: memoryEmbeddingBatchJobFingerprint(
      entryIds[0],
      "trigger-0"
    ),
    kind: "EMBED_ITEMS",
    leaseExpiresAt: new Date("2026-08-27T07:05:00.000Z"),
    memoryGenerationSnapshot: 0,
    memoryRevisionSnapshot: 1,
    pipelineVersion: MEMORY_EMBEDDING_BATCH_PIPELINE_VERSION,
    recoveredLease: false,
    sourceHash: null,
    sourceMessageId: null,
    sourceRevision: null,
    stage: null,
    targetFactVersionId: null,
    userId: "user-1"
  };
}

function snapshot() {
  return {
    acceptedUtilityEgressFingerprint: "e".repeat(64),
    credentialSource: "user" as const,
    destinationFingerprint: "d".repeat(64),
    executionTargetFingerprint: "a".repeat(64),
    logicalRole: "MEMORY_DOCUMENT_EMBED" as const,
    policyRevision: null,
    providerExecutionSnapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1",
        authenticationMode: "bearer" as const,
        responseTimeoutMs: 300_000
      },
      connectionDisplayName: "Embedding provider",
      connectionId: pin.connectionId,
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      model: {
        adapterKind: "openai_embeddings_compatible" as const,
        answerSelectable: false,
        capabilities: {
          nativePdfInput: false,
          nativeSearch: false,
          pdf: false,
          reasoning: false,
          streaming: false,
          vision: false
        },
        defaultParams: {},
        embedding: {
          nativeDimension: 2,
          providerFamily: "openai_compatible" as const,
          queryInstructionTemplate: null,
          supportsMrl: false,
          targetDimension: 2
        },
        modelClass: "embedding" as const,
        upstreamModelId: "embedding-v2"
      },
      modelDisplayName: "Embedding model",
      providerFamily: "openai_compatible" as const,
      providerModelId: pin.providerModelId,
      version: 1 as const
    },
    compatibilityId: "compatibility-1",
    compatibilityRequirement: {
      compatibilityVersion: "memory-runtime-compatibility-v2",
      configFingerprint: pin.configurationFingerprint,
      deploymentFingerprint: "1".repeat(64),
      modelFingerprint: "2".repeat(64),
      pipelineVersion: MEMORY_EMBEDDING_BATCH_VERSIONS.pipelineVersion,
      policyVersion: MEMORY_EMBEDDING_BATCH_VERSIONS.policyVersion,
      promptVersion: MEMORY_EMBEDDING_BATCH_VERSIONS.promptVersion,
      providerFingerprint: "3".repeat(64),
      retrievalConfigFingerprint:
        MEMORY_EMBEDDING_BATCH_VERSIONS.retrievalConfigFingerprint,
      role: "MEMORY_DOCUMENT_EMBED" as const,
      schemaVersion: MEMORY_EMBEDDING_BATCH_VERSIONS.schemaVersion,
      vectorSpaceFingerprint: pin.vectorSpaceFingerprint
    },
    requiresStrictStructuredOutput: false,
    utilityPolicyVersion: "memory-utility-egress-v1",
    version: 2 as const
  };
}

type MutableRow = {
  acceptedOutputHash: string | null;
  completedAt: Date | null;
  errorCode: string | null;
  executionBindingId: string | null;
  id: string;
  indexGenerationId: string;
  inputHash: string | null;
  memoryJobId: string;
  ordinal: number;
  resultDimension: number | null;
  resultVector: readonly number[] | null;
  searchEntryId: string;
  state: "FAILED" | "OUTCOME_UNKNOWN" | "PENDING" | "RESULT_READY" |
    "SETTLED" | "STALE";
  target: MemoryFactEmbeddingTarget | null;
  triggerIdentityHash: string;
  userId: string;
};

function fixture() {
  const job = claim();
  const rows: MutableRow[] = entryIds.map((entryId, ordinal) => ({
    acceptedOutputHash: null,
    completedAt: null,
    errorCode: null,
    executionBindingId: null,
    id: `child-${ordinal}`,
    indexGenerationId: "generation-1",
    inputHash: null,
    memoryJobId: job.id,
    ordinal,
    resultDimension: null,
    resultVector: null,
    searchEntryId: entryId,
    state: "PENDING",
    target: target(ordinal),
    triggerIdentityHash: memoryEmbeddingBatchTriggerHash(
      entryId,
      `trigger-${ordinal}`
    ),
    userId: job.userId
  }));
  const bindings: Array<{
    acceptedOutputHash: string | null;
    id: string;
    inputHash: string;
    ordinal: number;
    secretFreeExecutionSnapshot: ReturnType<typeof snapshot>;
    state: "FAILED" | "OUTCOME_UNKNOWN" | "PENDING" | "RUNNING" | "SUCCEEDED";
  }> = [];
  const events: string[] = [];
  const embed = vi.fn(async () => ({
    model: "embedding-v2",
    requestId: "request-1",
    usage: { inputTokens: 8, totalTokens: 8 },
    vectors: [[0.6, 0.8], [0.8, 0.6]]
  }));
  const applyReady = vi.fn(async () => "APPLIED" as const);
  const applyFailed = vi.fn(async () => "APPLIED" as const);
  const repository = {
    applyResult: vi.fn(async (_tx, _settings, item) => {
      events.push(`apply:${item.id}`);
      const row = rows.find(({ id }) => id === item.id)!;
      row.state = "SETTLED";
      row.resultVector = null;
      row.resultDimension = null;
      row.completedAt = now;
      return { childState: "SETTLED", settlement: "APPLIED" } as const;
    }),
    bindings: vi.fn(async () => bindings.map((binding) => ({ ...binding }))),
    load: vi.fn(async () => rows.map((row) => ({ ...row }))),
    mark: vi.fn(async (
      _userId: string,
      itemIds: readonly string[],
      state: MutableRow["state"],
      errorCode: string
    ) => {
      for (const row of rows) {
        if (itemIds.includes(row.id)) {
          row.state = state;
          row.errorCode = errorCode;
          row.resultVector = null;
          row.resultDimension = null;
          row.completedAt = now;
        }
      }
      return itemIds.length;
    }),
    persistResult: vi.fn(async (_tx, input) => {
      events.push("persist");
      input.itemIds.forEach((id: string, index: number) => {
        const row = rows.find((candidate) => candidate.id === id)!;
        row.acceptedOutputHash = input.acceptedOutputHash;
        row.executionBindingId = input.bindingId;
        row.inputHash = input.inputHash;
        row.resultDimension = input.dimension;
        row.resultVector = input.vectors[index];
        row.state = "RESULT_READY";
      });
    }),
    retryableFailure: vi.fn(async () => rows.length)
  };
  const bind = vi.fn(async (_userId, input) => {
    bindings.push({
      acceptedOutputHash: null,
      id: "binding-1",
      inputHash: input.inputHash,
      ordinal: input.ordinal,
      secretFreeExecutionSnapshot: snapshot(),
      state: "PENDING"
    });
    return { id: "binding-1" };
  });
  const start = vi.fn(async () => {
    bindings[0]!.state = "RUNNING";
    return { bindingId: "binding-1", snapshot: snapshot() };
  });
  const settle = vi.fn(async (_userId, bindingId, input) => {
    const binding = bindings.find(({ id }) => id === bindingId)!;
    binding.state = input.state;
    binding.acceptedOutputHash = input.acceptedOutputHash;
    return { state: input.state };
  });
  const settleSucceededWithDurableResult = vi.fn(async (
    _userId,
    bindingId,
    input,
    persist
  ) => {
    await persist({});
    events.push("settle");
    const binding = bindings.find(({ id }) => id === bindingId)!;
    binding.state = "SUCCEEDED";
    binding.acceptedOutputHash = input.acceptedOutputHash;
    return { state: "SUCCEEDED" };
  });
  const withAuthorizedResultCommit = vi.fn(async (_userId, _input, apply) =>
    apply({}, { settings: { userId: "user-1" } }));
  const dependencies = {
    execution: {
      admission: { bind, start },
      lifecycle: {
        settle,
        settleSucceededWithDurableResult,
        withAuthorizedResultCommit
      }
    },
    itemRepository: {
      applyFailed,
      applyReady,
      bindings: vi.fn(async () => []),
      loadTarget: vi.fn()
    },
    now: () => now,
    probeAuthority: vi.fn(async () => pin),
    repository,
    runtime: { resolve: vi.fn(async () => ({ adapter: { embed } })) }
  } as unknown as MemoryEmbeddingBatchHandlerDependencies;
  return {
    applyFailed,
    bind,
    bindings,
    dependencies,
    embed,
    events,
    job,
    repository,
    rows,
    settle,
    settleSucceededWithDurableResult,
    withAuthorizedResultCommit
  };
}

function context() {
  return {
    now: () => now,
    setStage: vi.fn(async () => undefined),
    signal: new AbortController().signal
  };
}

describe("Memory durable embedding batch handler", () => {
  it("uses one provider request and durably settles ordered children", async () => {
    const f = fixture();
    const result = await createMemoryEmbeddingBatchHandler(f.dependencies)
      .execute(f.job, context());

    expect(f.embed).toHaveBeenCalledOnce();
    expect(f.embed).toHaveBeenCalledWith({
      mode: "document",
      signal: expect.any(AbortSignal),
      texts: f.rows.map((row) => renderMemoryDocumentEmbeddingText(row.target!))
    });
    expect(f.settleSucceededWithDurableResult).toHaveBeenCalledOnce();
    expect(f.events).toEqual(["persist", "settle", "apply:child-0", "apply:child-1"]);
    expect(result.operationalCounters).toEqual({
      embeddingBatchItems: 2,
      embeddingFailedItems: 0,
      embeddingProviderRequests: 1,
      embeddingSettledItems: 2,
      embeddingStaleItems: 0
    });
  });

  it("resumes durable child apply without another paid call", async () => {
    const f = fixture();
    const outputHash = "f".repeat(64);
    f.bindings.push({
      acceptedOutputHash: outputHash,
      id: "recovered-binding",
      inputHash: "a".repeat(64),
      ordinal: 0,
      secretFreeExecutionSnapshot: snapshot(),
      state: "SUCCEEDED"
    });
    f.rows.forEach((row, index) => {
      row.acceptedOutputHash = outputHash;
      row.executionBindingId = "recovered-binding";
      row.inputHash = "a".repeat(64);
      row.resultDimension = 2;
      row.resultVector = index === 0 ? [0.6, 0.8] : [0.8, 0.6];
      row.state = "RESULT_READY";
    });

    const result = await createMemoryEmbeddingBatchHandler(f.dependencies)
      .execute(f.job, context());

    expect(f.embed).not.toHaveBeenCalled();
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.repository.applyResult).toHaveBeenCalledTimes(2);
    expect(result.operationalCounters?.embeddingProviderRequests).toBe(1);
  });

  it("never replays a crash-ambiguous running request", async () => {
    const f = fixture();
    f.bindings.push({
      acceptedOutputHash: null,
      id: "ambiguous-binding",
      inputHash: "a".repeat(64),
      ordinal: 0,
      secretFreeExecutionSnapshot: snapshot(),
      state: "RUNNING"
    });

    await expect(createMemoryEmbeddingBatchHandler(f.dependencies)
      .execute(f.job, context())).rejects.toMatchObject({
        code: "memory_embedding_batch_outcome_unknown",
        retryable: false
      } satisfies Partial<MemoryCoordinatorError>);
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.settle).toHaveBeenCalledWith(
      "user-1",
      "ambiguous-binding",
      expect.objectContaining({ state: "OUTCOME_UNKNOWN" })
    );
    expect(f.rows.every(({ state }) => state === "OUTCOME_UNKNOWN")).toBe(true);
  });

  it("accepts no child when result count is not exact", async () => {
    const f = fixture();
    f.embed.mockResolvedValueOnce({
      model: "embedding-v2",
      requestId: "request-1",
      usage: { inputTokens: 8, totalTokens: 8 },
      vectors: [[0.6, 0.8]]
    });

    await expect(createMemoryEmbeddingBatchHandler(f.dependencies)
      .execute(f.job, context())).rejects.toMatchObject({
        code: "memory_embedding_batch_output_invalid",
        retryable: true
      } satisfies Partial<MemoryCoordinatorError>);
    expect(f.repository.persistResult).not.toHaveBeenCalled();
    expect(f.rows.every(({ state }) => state === "PENDING")).toBe(true);
  });

  it("fences a changed generation before applying a recovered vector", async () => {
    const f = fixture();
    const outputHash = "f".repeat(64);
    f.bindings.push({
      acceptedOutputHash: outputHash,
      id: "recovered-binding",
      inputHash: "a".repeat(64),
      ordinal: 0,
      secretFreeExecutionSnapshot: snapshot(),
      state: "SUCCEEDED"
    });
    f.rows.forEach((row) => {
      row.acceptedOutputHash = outputHash;
      row.executionBindingId = "recovered-binding";
      row.inputHash = "a".repeat(64);
      row.resultDimension = 2;
      row.resultVector = [0.6, 0.8];
      row.state = "RESULT_READY";
      row.target = row.target ? {
        ...row.target,
        generation: { ...row.target.generation, id: "generation-2" }
      } : null;
    });

    await createMemoryEmbeddingBatchHandler(f.dependencies)
      .execute(f.job, context());

    expect(f.withAuthorizedResultCommit).not.toHaveBeenCalled();
    expect(f.rows.every(({ state }) => state === "STALE")).toBe(true);
    expect(f.embed).not.toHaveBeenCalled();
  });
});
