import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EmbeddingAdapterError } from "../../providers/embeddings";
import type { MemoryJobClaim } from "../coordinator/types";
import { MemoryCoordinatorError } from "../coordinator/errors";
import { MemoryExecutionError } from "../execution";
import {
  MEMORY_EXPLICIT_EMBEDDING_PIPELINE_VERSION,
  memoryExplicitEmbeddingJobFingerprint,
  memoryExplicitEmbeddingInputHash,
  type MemoryExplicitEmbeddingPin,
  type MemoryExplicitEmbeddingTarget
} from "./contract";
import {
  createMemoryExplicitEmbeddingHandler,
  type MemoryExplicitEmbeddingHandlerDependencies
} from "./handler";

const pin: MemoryExplicitEmbeddingPin = Object.freeze({
  configurationFingerprint: "c".repeat(64),
  connectionId: "connection-1",
  dimension: 2,
  providerModelId: "model-1",
  vectorSpaceFingerprint: "v".repeat(64)
});

function target(
  embeddingState: MemoryExplicitEmbeddingTarget["embeddingState"] = "PENDING"
): MemoryExplicitEmbeddingTarget {
  return {
    embeddingState,
    entryId: "11111111-1111-4111-8111-111111111111",
    factId: "fact-1",
    factVersionId: "version-1",
    generation: {
      embeddingConfigurationFingerprint: pin.configurationFingerprint,
      embeddingConnectionId: pin.connectionId,
      embeddingDimension: pin.dimension,
      embeddingProviderModelId: pin.providerModelId,
      id: "generation-1",
      indexMode: "HYBRID",
      vectorSpaceFingerprint: pin.vectorSpaceFingerprint
    },
    safeContentHash: "a".repeat(64),
    safeSearchText: "the owner prefers tea",
    selectedEmbeddingProviderModelId: pin.providerModelId,
    userId: "user-1"
  };
}

function claim(): MemoryJobClaim {
  const entryId = "11111111-1111-4111-8111-111111111111";
  return {
    activeLeafMessageId: null,
    attemptCount: 1,
    branchGeneration: null,
    chatId: null,
    claimToken: randomUUID(),
    id: randomUUID(),
    idempotencyFingerprint: memoryExplicitEmbeddingJobFingerprint(entryId, "save-1"),
    kind: "EMBED_ITEMS",
    leaseExpiresAt: new Date("2026-08-10T12:05:00.000Z"),
    memoryGenerationSnapshot: 0,
    memoryRevisionSnapshot: 1,
    pipelineVersion: MEMORY_EXPLICIT_EMBEDDING_PIPELINE_VERSION,
    recoveredLease: false,
    sourceHash: null,
    sourceRevision: null,
    stage: null,
    userId: "user-1"
  };
}

function snapshot() {
  return {
    acceptedUtilityEgressFingerprint: "e".repeat(64),
    destinationFingerprint: "d".repeat(64),
    executionTargetFingerprint: "t".repeat(64),
    logicalRole: "MEMORY_DOCUMENT_EMBED",
    providerExecutionSnapshot: {
      connection: { apiRoot: "https://provider.example.test/v1" },
      connectionId: pin.connectionId,
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      model: {
        adapterKind: "openai_embeddings_compatible",
        embedding: {
          nativeDimension: 2,
          providerFamily: "openai_compatible",
          queryInstructionTemplate: null,
          supportsMrl: false,
          targetDimension: 2
        },
        modelClass: "embedding",
        upstreamModelId: "embedding-v1"
      },
      providerFamily: "openai_compatible",
      providerModelId: pin.providerModelId
    },
    qualificationId: "qualification-1",
    qualificationRequirement: {
      configFingerprint: pin.configurationFingerprint,
      vectorSpaceFingerprint: pin.vectorSpaceFingerprint
    },
    requiresStrictStructuredOutput: false,
    utilityPolicyVersion: "memory-utility-egress-v1"
  };
}

function dependencies(overrides: Partial<MemoryExplicitEmbeddingHandlerDependencies> = {}) {
  const current = target();
  const applyReady = vi.fn(async () => "APPLIED" as const);
  const applyFailed = vi.fn(async () => "APPLIED" as const);
  const settle = vi.fn(async () => ({ state: "SUCCEEDED" }));
  const bind = vi.fn(async () => ({ id: "binding-1" }));
  const start = vi.fn(async () => ({
    bindingId: "binding-1",
    snapshot: snapshot()
  }));
  const embed = vi.fn(async () => ({
    model: "embedding-v1",
    requestId: "request-1",
    usage: { inputTokens: 4, totalTokens: 4 },
    vectors: [[0.6, 0.8]]
  }));
  const base = {
    execution: {
      admission: { bind, start },
      lifecycle: {
        settle,
        withAuthorizedResultCommit: vi.fn(async (
          _userId: string,
          _input: unknown,
          apply: (tx: never, evidence: never) => Promise<unknown>
        ) => apply({} as never, {
          settings: { userId: "user-1" }
        } as never))
      }
    },
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    probeAuthority: vi.fn(async () => pin),
    repository: {
      applyFailed,
      applyReady,
      bindings: vi.fn(async () => []),
      loadTarget: vi.fn(async () => current)
    },
    runtime: {
      resolve: vi.fn(async () => ({ adapter: { embed } }))
    }
  } as unknown as MemoryExplicitEmbeddingHandlerDependencies;
  return {
    applyFailed,
    applyReady,
    base: { ...base, ...overrides } as MemoryExplicitEmbeddingHandlerDependencies,
    bind,
    current,
    embed,
    settle,
    start
  };
}

function context() {
  return {
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    setStage: vi.fn(async () => undefined),
    signal: new AbortController().signal
  };
}

describe("explicit Memory vector enrichment handler", () => {
  it("parks missing consent, qualification, or credential authority before binding", async () => {
    for (const code of [
      "memory_execution_egress_consent_required",
      "memory_execution_qualification_required",
      "memory_execution_target_unavailable"
    ] as const) {
      const fixture = dependencies({
        probeAuthority: vi.fn(async () => {
          throw new MemoryExecutionError(code);
        })
      });
      const handler = createMemoryExplicitEmbeddingHandler(fixture.base);
      await expect(handler.preflight(claim())).resolves.toEqual({
        errorCode: code,
        status: "WAITING_FOR_EGRESS_CONSENT"
      });
      expect(fixture.bind).not.toHaveBeenCalled();
      expect(fixture.embed).not.toHaveBeenCalled();
    }
  });

  it("binds and starts before one document call, then applies through authorization", async () => {
    const fixture = dependencies();
    const handler = createMemoryExplicitEmbeddingHandler(fixture.base);
    const result = await handler.execute(claim(), context());

    expect(result).toMatchObject({ stage: "vector_ready" });
    expect(fixture.bind).toHaveBeenCalledTimes(1);
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.embed).toHaveBeenCalledWith({
      mode: "document",
      signal: expect.any(AbortSignal),
      texts: [fixture.current.safeSearchText]
    });
    expect(fixture.bind.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.start.mock.invocationCallOrder[0]!
    );
    expect(fixture.start.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.embed.mock.invocationCallOrder[0]!
    );
    expect(fixture.settle).toHaveBeenCalledWith(
      "user-1",
      "binding-1",
      expect.objectContaining({ state: "SUCCEEDED" })
    );
    expect(fixture.applyReady).toHaveBeenCalledTimes(1);
    expect(fixture.applyFailed).not.toHaveBeenCalled();
  });

  it("degrades uncertain and recovered calls without replaying provider I/O", async () => {
    const recovered = dependencies();
    const recoveredClaim = claim();
    const inputHash = memoryExplicitEmbeddingInputHash(recovered.current);
    const recoveredHandler = createMemoryExplicitEmbeddingHandler({
      ...recovered.base,
      repository: {
        ...recovered.base.repository,
        bindings: vi.fn(async () => [{
      acceptedOutputHash: null,
      id: "old-binding",
      inputHash,
      ordinal: 0,
      secretFreeExecutionSnapshot: {},
      state: "RUNNING" as const
        }])
      }
    });
    await expect(recoveredHandler.execute(recoveredClaim, context())).rejects.toMatchObject({
      code: "memory_embedding_outcome_unknown"
    } satisfies Partial<MemoryCoordinatorError>);
    expect(recovered.settle).toHaveBeenCalledWith(
      "user-1",
      "old-binding",
      expect.objectContaining({ state: "OUTCOME_UNKNOWN" })
    );
    expect(recovered.embed).not.toHaveBeenCalled();
    expect(recovered.applyFailed).toHaveBeenCalledTimes(1);

    const uncertain = dependencies();
    const uncertainHandler = createMemoryExplicitEmbeddingHandler({
      ...uncertain.base,
      runtime: {
        resolve: vi.fn(async () => ({
          adapter: {
            embed: vi.fn(async () => {
              throw new EmbeddingAdapterError("embedding_request_timed_out");
            })
          }
        }))
      } as never
    });
    await expect(uncertainHandler.execute(claim(), context())).rejects.toMatchObject({
      code: "memory_embedding_outcome_unknown"
    });
    expect(uncertain.settle).toHaveBeenCalledWith(
      "user-1",
      "binding-1",
      expect.objectContaining({ state: "OUTCOME_UNKNOWN" })
    );
    expect(uncertain.applyFailed).toHaveBeenCalledTimes(1);
  });
});
