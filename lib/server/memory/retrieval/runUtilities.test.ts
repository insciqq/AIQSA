import { describe, expect, it, vi } from "vitest";
import type { MemorySecretFreeExecutionSnapshot } from "../execution";
import type { PrismaMemoryExecutionService } from "../execution";
import {
  createMemoryRunUtilityService,
  memoryDedicatedRerankDocument,
  MEMORY_QUERY_EMBEDDING_ATTEMPT_TIMEOUT_MS,
  MEMORY_QUERY_EMBEDDING_VERSIONS,
  MEMORY_RERANK_AGGREGATION_MAX_CANDIDATES,
  MEMORY_RERANK_AGGREGATION_MAX_BATCHES,
  MEMORY_RERANK_AGGREGATION_BATCH_SIZE,
  MEMORY_RERANK_AGGREGATION_MAX_PARALLEL_BATCHES,
  MEMORY_RERANK_MAX_ATTEMPTS,
  MEMORY_RERANK_TARGETED_MAX_CANDIDATES,
  type MemoryRunUtilityService
} from "./runUtilities";
import {
  memoryRunUtilityPromptCharacters,
  MemoryRunUtilityProviderCallError,
  MEMORY_RERANK_MAX_PROMPT_CHARACTERS,
  MEMORY_RERANK_TOOL_NAME,
  type MemoryRerankUtilityProviderInput,
  type MemoryRunUtilityProviderInput,
  type MemoryRunUtilityProvider
} from "./runUtilityRuntime";
import {
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  type MemoryVectorProfile
} from "./vector";
import {
  EmbeddingAdapterError
} from "../../providers/embeddings";
import {
  MAX_RERANK_DOCUMENT_CHARACTERS,
  RerankAdapterError,
  type RerankRequest,
  type RerankResult
} from "../../providers/rerank";
import { RERANKER_ROUTE_POLICY_VERSION } from "../../../domain/rerankerModels";
import { approvedRerankerDeployments } from "../../admin/providers/approvedRerankers";

const profile: MemoryVectorProfile = Object.freeze({
  configurationFingerprint: "a".repeat(64),
  connectionId: "connection-1",
  dimension: 1_024,
  generationId: "generation-1",
  minimumSimilarity: 0.55,
  providerModelId: "embedding-model-1",
  retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  vectorSpaceFingerprint: "b".repeat(64)
});

const currentFactRerankCandidate = Object.freeze({
  directness: "DIRECT" as const,
  historical: false,
  lifecycleState: "ACTIVE" as const,
  temporalReason: "current" as const
});

const currentHistoryRerankCandidate = Object.freeze({
  directness: null,
  historical: false,
  lifecycleState: null,
  temporalReason: "current" as const
});

function rerankInput(
  input: MemoryRunUtilityProviderInput
): MemoryRerankUtilityProviderInput {
  return input;
}

function snapshot(
  role: "MEMORY_QUERY_EMBED" | "MEMORY_RERANK"
): MemorySecretFreeExecutionSnapshot {
  const embedding = role === "MEMORY_QUERY_EMBED";
  return {
    acceptedUtilityEgressFingerprint: "c".repeat(64),
    destinationFingerprint: "d".repeat(64),
    executionTargetFingerprint: "e".repeat(64),
    logicalRole: role,
    providerExecutionSnapshot: {
      connection: {
        apiRoot: "https://provider.example/v1",
        authentication: { mode: "bearer" },
        protocol: embedding ? "openai_embeddings" : "openai_responses"
      },
      connectionId: "connection-1",
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      model: embedding
        ? {
            adapterKind: "openai_embeddings_compatible",
            capabilities: {
              nativePdfInput: false,
              nativeSearch: false,
              pdf: false,
              reasoning: false,
              toolCalling: false,
              vision: false
            },
            defaultParams: {},
            embedding: {
              nativeDimension: 1_024,
              targetDimension: 1_024
            },
            modelClass: "embedding",
            upstreamModelId: "embedding-upstream-1"
          }
        : {
            adapterKind: "openai_responses",
            capabilities: {
              nativePdfInput: false,
              nativeSearch: false,
              pdf: false,
              reasoning: false,
              toolCalling: true,
              vision: false
            },
            defaultParams: {},
            modelClass: "answer",
            upstreamModelId: "answer-upstream-1"
          },
      providerFamily: "openai",
      providerModelId: embedding ? "embedding-model-1" : "answer-model-1"
    },
    compatibilityId: "compatibility-1",
    compatibilityRequirement: {
      compatibilityVersion: "memory-runtime-compatibility-v2",
      configFingerprint: embedding ? profile.configurationFingerprint : "f".repeat(64),
      deploymentFingerprint: "2".repeat(64),
      modelFingerprint: "3".repeat(64),
      pipelineVersion: "pipeline-v1",
      policyVersion: "policy-v1",
      promptVersion: "prompt-v1",
      providerFingerprint: "4".repeat(64),
      retrievalConfigFingerprint: embedding
        ? profile.retrievalConfigFingerprint
        : "5".repeat(64),
      role,
      schemaVersion: "schema-v1",
      vectorSpaceFingerprint: embedding ? profile.vectorSpaceFingerprint : null
    },
    requiresStrictStructuredOutput: !embedding,
    utilityPolicyVersion: "memory-utility-egress-v2",
    version: 2
  } as unknown as MemorySecretFreeExecutionSnapshot;
}

function dedicatedRerankerSnapshot(): MemorySecretFreeExecutionSnapshot {
  const base = snapshot("MEMORY_RERANK");
  return {
    ...base,
    providerExecutionSnapshot: {
      ...base.providerExecutionSnapshot,
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://openrouter.ai/api/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 30_000
      },
      connectionDisplayName: "OpenRouter",
      connectionId: "reranker-connection",
      credentialId: "reranker-credential",
      credentialVersionId: "reranker-credential-version",
      model: {
        adapterKind: "openrouter_rerank",
        answerSelectable: false,
        capabilities: {
          nativePdfInput: false,
          nativeSearch: false,
          pdf: false,
          reasoning: false,
          streaming: false,
          toolCalling: false,
          vision: false
        },
        defaultParams: {},
        modelClass: "reranker",
        openRouterRouting: {
          mode: "only_selected",
          providers: ["Together"]
        },
        upstreamModelId: "qwen/qwen3-reranker-8b"
      },
      modelDisplayName: "Qwen3 Reranker 8B",
      providerFamily: "openrouter",
      providerModelId: "reranker-model"
    },
    requiresStrictStructuredOutput: false
  } as MemorySecretFreeExecutionSnapshot;
}

function dedicatedCandidates(length: number) {
  return Array.from({ length }, (_, index) => ({
    ...currentHistoryRerankCandidate,
    authorityLevel: "PAST_CHAT" as const,
    current: true,
    handle: `c${index}`,
    occurredFrom: `2026-01-${String(index % 28 + 1).padStart(2, "0")}T00:00:00.000Z`,
    occurredTo: null,
    sensitivityClass: "NORMAL" as const,
    speakerScope: "mixed_conversation" as const,
    sourceKind: "HISTORY" as const,
    text: `The user discussed release milestone ${index}.`
  }));
}

function execution(log: string[]) {
  const lifecycle = {
    settle: vi.fn(async (_userId: string, _bindingId: string, _input: unknown) => {
      log.push("settle");
      return {};
    }),
    withAuthorizedResultCommit: vi.fn(async (
      _userId: string,
      _input: unknown,
      apply: () => Promise<unknown>
    ) => {
      log.push("authorize");
      return apply();
    })
  };
  const admission = {
    bind: vi.fn(async (
      _userId: string,
      input: { inputHash: string; ordinal: number; role: Parameters<typeof snapshot>[0] }
    ) => {
      log.push(`bind:${input.role}`);
      return { id: `binding-${input.role}` };
    }),
    start: vi.fn(async (_userId: string, bindingId: string) => {
      log.push("start");
      const role = bindingId.replace("binding-", "") as Parameters<typeof snapshot>[0];
      return { bindingId, snapshot: snapshot(role) };
    })
  };
  return {
    admission,
    lifecycle,
    value: { admission, lifecycle } as unknown as PrismaMemoryExecutionService
  };
}

function baseInput() {
  return {
    attemptId: "attempt-1",
    retrievalMode: "TARGETED_CURRENT" as const,
    signal: new AbortController().signal,
    temporalIntent: "CURRENT" as const,
    userId: "user-1"
  };
}

function dedicatedHarness(
  run: (request: RerankRequest) => Promise<RerankResult>
) {
  const accepted = dedicatedRerankerSnapshot();
  const rerank = vi.fn(run);
  const resolve = vi.fn(async () => ({
    adapter: { rerank },
    configuration: accepted.providerExecutionSnapshot.model,
    executionSnapshot: accepted.providerExecutionSnapshot,
    provider: "openrouter",
    providerModelId: "reranker-model"
  }));
  const bind = vi.fn(async (_userId: string, input: { ordinal: number }) => ({
    id: `binding-${input.ordinal}`
  }));
  const start = vi.fn(async (_userId: string, bindingId: string) => ({
    bindingId,
    snapshot: accepted
  }));
  const settle = vi.fn(async (
    _userId: string,
    _bindingId: string,
    _input: unknown
  ) => ({}));
  const executionService = {
    admission: {
      bind,
      start
    },
    lifecycle: {
      settle,
      withAuthorizedResultCommit: vi.fn(async (
        _userId: string,
        _input: unknown,
        apply: () => Promise<unknown>
      ) => apply())
    }
  } as unknown as PrismaMemoryExecutionService;
  const provider = { run: vi.fn() } as unknown as MemoryRunUtilityProvider;
  return {
    accepted,
    bind,
    executionService,
    provider,
    rerank,
    resolve,
    settle,
    start,
    service: createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: executionService,
      provider,
      rerankerRuntime: { resolve } as never,
      resolveRerankPath: vi.fn(async () => "DEDICATED" as const)
    })
  };
}

describe("Memory run utility execution", () => {
  it("binds query embedding to the active vector retrieval fingerprint", () => {
    expect(MEMORY_QUERY_EMBEDDING_VERSIONS.retrievalConfigFingerprint)
      .toBe(MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT);
  });

  it("retries the whole dedicated rerank on the next model without mixing batch scores", async () => {
    vi.useFakeTimers();
    try {
    const [voyage, cohere] = approvedRerankerDeployments;
    if (!voyage || !cohere) throw new Error("approved reranker route missing");
    const targetByBinding = new Map<string, string>();
    const bind = vi.fn(async (_userId: string, input: {
      ordinal: number;
      targetProviderModelId?: string;
    }) => {
      const bindingId = `binding-${input.ordinal}`;
      targetByBinding.set(bindingId, input.targetProviderModelId ?? "");
      return { id: bindingId };
    });
    const start = vi.fn(async (_userId: string, bindingId: string) => {
      const providerModelId = targetByBinding.get(bindingId)!;
      const deployment = approvedRerankerDeployments.find(
        (candidate) => candidate.providerModelId === providerModelId
      )!;
      const base = dedicatedRerankerSnapshot();
      return {
        bindingId,
        snapshot: {
          ...base,
          destinationFingerprint: providerModelId.padEnd(64, "0").slice(0, 64),
          executionTargetFingerprint: providerModelId.padEnd(64, "1").slice(0, 64),
          providerExecutionSnapshot: {
            ...base.providerExecutionSnapshot,
            model: deployment.configuration,
            modelDisplayName: deployment.displayName,
            providerModelId
          }
        } as MemorySecretFreeExecutionSnapshot
      };
    });
    const settle = vi.fn(async () => ({}));
    const executionService = {
      admission: { bind, start },
      lifecycle: {
        settle,
        withAuthorizedResultCommit: vi.fn(async (
          _userId: string,
          _input: unknown,
          apply: () => Promise<unknown>
        ) => apply())
      }
    } as unknown as PrismaMemoryExecutionService;
    const calls: Array<{ handles: string[]; providerModelId: string }> = [];
    const rerankerRuntime = {
      resolve: vi.fn(async (evidence: { providerModelId: string }) => ({
        adapter: {
          rerank: async (request: RerankRequest) => {
            calls.push({
              handles: request.documents.map(({ handle }) => handle),
              providerModelId: evidence.providerModelId
            });
            if (
              evidence.providerModelId === voyage.providerModelId &&
              request.documents.some(({ handle }) =>
                handle === `c${MEMORY_RERANK_AGGREGATION_MAX_CANDIDATES - 1}`)
            ) {
              throw new RerankAdapterError("rerank_provider_http_error", {
                httpStatus: 503
              });
            }
            const relevanceScore = evidence.providerModelId === voyage.providerModelId
              ? 0.2
              : 0.9;
            return {
              model: approvedRerankerDeployments.find(
                ({ providerModelId }) => providerModelId === evidence.providerModelId
              )!.configuration.upstreamModelId,
              provider: "test",
              requestId: `request-${calls.length}`,
              scores: request.documents.map((document, index) => ({
                handle: document.handle,
                index,
                relevanceScore
              })),
              usage: { inputTokens: 10, searchUnits: 1, totalTokens: 10 }
            };
          }
        }
      }))
    };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: executionService,
      provider: { run: vi.fn() } as unknown as MemoryRunUtilityProvider,
      rerankerRuntime: rerankerRuntime as never,
      resolveDedicatedRerankRoute: vi.fn(async () => ({
        policyVersion: RERANKER_ROUTE_POLICY_VERSION,
        providerModelIds: [voyage.providerModelId, cohere.providerModelId]
      })),
      resolveRerankPath: vi.fn(async () => "DEDICATED" as const)
    });

    const pending = service.rerank({
      ...baseInput(),
      aggregationRequested: true,
      candidates: dedicatedCandidates(MEMORY_RERANK_AGGREGATION_MAX_CANDIDATES)
        .map((candidate) => ({
          ...candidate,
          text: candidate.text.padEnd(3_900, "x")
        })),
      profileRequested: false,
      query: "release milestones"
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({
      diagnostics: {
        fallbackDepth: 1,
        modelAttemptCount: 2,
        routePolicyVersion: RERANKER_ROUTE_POLICY_VERSION
      },
      relevanceScoreFloor: null,
      rerankerRoute: {
        fallbackDepth: 1,
        policyVersion: RERANKER_ROUTE_POLICY_VERSION,
        providerModelId: cohere.providerModelId
      },
      status: "READY"
    });
    if (result.status !== "READY") throw new Error("rerank route failed");
    expect(result.decisions).toHaveLength(
      MEMORY_RERANK_AGGREGATION_MAX_CANDIDATES
    );
    expect(result.decisions.every(({ relevanceScore }) => relevanceScore === 0.9))
      .toBe(true);
    const primaryCallCount = calls.filter(
      ({ providerModelId }) => providerModelId === voyage.providerModelId
    ).length;
    const fallbackCallCount = calls.filter(
      ({ providerModelId }) => providerModelId === cohere.providerModelId
    ).length;
    expect(primaryCallCount).toBeGreaterThan(1);
    expect(fallbackCallCount).toBe(primaryCallCount);
    expect(result.externalCallCount).toBe(calls.length);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it.each([
    { ordinal: 1, purpose: "RETRIEVAL" as const },
    { ordinal: 3, purpose: "ACTION_TARGET" as const }
  ])("binds ordinal $ordinal before a $purpose embedding and settles usage once", async ({
    ordinal,
    purpose
  }) => {
    const log: string[] = [];
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const bound = execution(log);
    const embed = vi.fn(async () => {
      log.push("provider");
      return {
        model: "embedding-upstream-1",
        requestId: "embedding-response-1",
        usage: { inputTokens: 7, totalTokens: 7 },
        vectors: [Array.from(
          { length: 1_024 },
          (_, index) => index === 0 ? 1 : 0
        )]
      };
    });
    const embeddingRuntime = {
      resolve: vi.fn(async () => ({
        adapter: { embed }
      }))
    };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: embeddingRuntime as never,
      execution: bound.value,
      provider: { run: vi.fn() } as unknown as MemoryRunUtilityProvider
    });
    const result = await service.embedQuery({
      ...baseInput(),
      profile,
      purpose,
      query: `what did we discuss about postgres; token ${token}`
    });
    expect(result).toMatchObject({
      bindingId: "binding-MEMORY_QUERY_EMBED",
      status: "READY"
    });
    expect(log).toEqual([
      "bind:MEMORY_QUERY_EMBED",
      "start",
      "provider",
      "settle",
      "authorize"
    ]);
    expect(bound.lifecycle.settle).toHaveBeenCalledOnce();
    expect(bound.lifecycle.settle.mock.calls[0]?.[2]).toMatchObject({
      state: "SUCCEEDED",
      usage: { completeness: "COMPLETE", inputTokens: 7, totalTokens: 7 }
    });
    expect(bound.admission.bind).toHaveBeenCalledWith("user-1", expect.objectContaining({
      ordinal,
      role: "MEMORY_QUERY_EMBED"
    }));
    expect(embed).toHaveBeenCalledWith({
      mode: "document",
      signal: expect.any(AbortSignal),
      texts: [expect.stringMatching(
        /prior personal conversational evidence.*English, Russian, and mixed-language.*what did we discuss about postgres.*REDACTED/su
      )]
    });
    expect(JSON.stringify(embed.mock.calls)).not.toContain(token);
    expect(JSON.stringify(embed.mock.calls)).not.toContain("web search");
  });

  it("does not retry a transport-uncertain interactive query embedding", async () => {
    const bind = vi.fn(async (_userId: string, input: { ordinal: number }) => ({
      id: `embedding-binding-${input.ordinal}`
    }));
    const settle = vi.fn(async () => ({}));
    const executionService = {
      admission: {
        bind,
        start: vi.fn(async (_userId: string, bindingId: string) => ({
          bindingId,
          snapshot: snapshot("MEMORY_QUERY_EMBED")
        }))
      },
      lifecycle: {
        settle,
        withAuthorizedResultCommit: vi.fn(async (
          _userId: string,
          _input: unknown,
          apply: () => Promise<unknown>
        ) => apply())
      }
    } as unknown as PrismaMemoryExecutionService;
    const embed = vi.fn(async () => {
      throw new EmbeddingAdapterError("embedding_provider_request_failed");
    });
    const service = createMemoryRunUtilityService({
      embeddingRuntime: {
        resolve: vi.fn(async () => ({ adapter: { embed } }))
      } as never,
      execution: executionService,
      provider: { run: vi.fn() } as unknown as MemoryRunUtilityProvider
    });

    const result = await service.embedQuery({
      ...baseInput(),
      profile,
      query: "What did I say about release readiness?"
    });

    expect(result).toMatchObject({
      bindingId: "embedding-binding-1",
      reason: "memory_query_embedding_outcome_unknown",
      status: "UNAVAILABLE"
    });
    expect(embed).toHaveBeenCalledOnce();
    expect(bind.mock.calls.map((call) => call[1].ordinal)).toEqual([1]);
    expect(settle).toHaveBeenCalledWith(
      "user-1",
      "embedding-binding-1",
      expect.objectContaining({
        errorCode: "embedding_provider_request_failed",
        state: "OUTCOME_UNKNOWN"
      })
    );
  });

  it("bounds one query-embedding request without starting a second request", async () => {
    vi.useFakeTimers();
    try {
      const bind = vi.fn(async (_userId: string, input: { ordinal: number }) => ({
        id: `embedding-binding-${input.ordinal}`
      }));
      const settle = vi.fn(async () => ({}));
      const executionService = {
        admission: {
          bind,
          start: vi.fn(async (_userId: string, bindingId: string) => ({
            bindingId,
            snapshot: snapshot("MEMORY_QUERY_EMBED")
          }))
        },
        lifecycle: {
          settle,
          withAuthorizedResultCommit: vi.fn(async (
            _userId: string,
            _input: unknown,
            apply: () => Promise<unknown>
          ) => apply())
        }
      } as unknown as PrismaMemoryExecutionService;
      const roleController = new AbortController();
      const attemptSignals: AbortSignal[] = [];
      const embed = vi.fn(async (request: { signal?: AbortSignal }) => {
        const signal = request.signal!;
        attemptSignals.push(signal);
        return new Promise<never>((_resolve, reject) => {
          const rejectFromSignal = () => reject(signal.reason);
          if (signal.aborted) rejectFromSignal();
          else signal.addEventListener("abort", rejectFromSignal, { once: true });
        });
      });
      const service = createMemoryRunUtilityService({
        embeddingRuntime: {
          resolve: vi.fn(async () => ({ adapter: { embed } }))
        } as never,
        execution: executionService,
        provider: { run: vi.fn() } as unknown as MemoryRunUtilityProvider
      });

      const pending = service.embedQuery({
        ...baseInput(),
        profile,
        query: "What did I say about release readiness?",
        signal: roleController.signal
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(embed).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(MEMORY_QUERY_EMBEDDING_ATTEMPT_TIMEOUT_MS);
      const result = await pending;

      expect(result).toMatchObject({
        bindingId: "embedding-binding-1",
        reason: "memory_query_embedding_outcome_unknown",
        status: "UNAVAILABLE"
      });
      expect(roleController.signal.aborted).toBe(false);
      expect(attemptSignals).toHaveLength(1);
      expect(attemptSignals[0]?.aborted).toBe(true);
      expect(bind.mock.calls.map((call) => call[1].ordinal)).toEqual([1]);
      expect(settle).toHaveBeenCalledWith(
        "user-1",
        "embedding-binding-1",
        expect.objectContaining({
          errorCode: "memory_query_embedding_attempt_timed_out",
          state: "OUTCOME_UNKNOWN"
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry query embedding after the parent role is cancelled", async () => {
    const bound = execution([]);
    const roleController = new AbortController();
    let notifyStarted!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => {
      notifyStarted = resolve;
    });
    const embed = vi.fn(async (request: { signal?: AbortSignal }) => {
      const signal = request.signal!;
      notifyStarted(signal);
      return new Promise<never>((_resolve, reject) => {
        const rejectFromSignal = () => reject(signal.reason);
        if (signal.aborted) rejectFromSignal();
        else signal.addEventListener("abort", rejectFromSignal, { once: true });
      });
    });
    const service = createMemoryRunUtilityService({
      embeddingRuntime: {
        resolve: vi.fn(async () => ({ adapter: { embed } }))
      } as never,
      execution: bound.value,
      provider: { run: vi.fn() } as unknown as MemoryRunUtilityProvider
    });

    const pending = service.embedQuery({
      ...baseInput(),
      profile,
      query: "What did I say about release readiness?",
      signal: roleController.signal
    });
    const attemptSignal = await started;
    roleController.abort({ code: "memory_query_role_cancelled" });

    await expect(pending).resolves.toMatchObject({
      reason: "memory_query_embedding_outcome_unknown",
      status: "UNAVAILABLE"
    });
    expect(attemptSignal.aborted).toBe(true);
    expect(embed).toHaveBeenCalledOnce();
    expect(bound.admission.bind).toHaveBeenCalledOnce();
    expect(bound.lifecycle.settle).toHaveBeenCalledWith(
      "user-1",
      "binding-MEMORY_QUERY_EMBED",
      expect.objectContaining({ state: "OUTCOME_UNKNOWN" })
    );
  });

  it("does not retry a transient interactive query-embedding HTTP response", async () => {
    const bind = vi.fn(async (_userId: string, input: { ordinal: number }) => ({
      id: `embedding-binding-${input.ordinal}`
    }));
    const settle = vi.fn(async () => ({}));
    const executionService = {
      admission: {
        bind,
        start: vi.fn(async (_userId: string, bindingId: string) => ({
          bindingId,
          snapshot: snapshot("MEMORY_QUERY_EMBED")
        }))
      },
      lifecycle: {
        settle,
        withAuthorizedResultCommit: vi.fn(async (
          _userId: string,
          _input: unknown,
          apply: () => Promise<unknown>
        ) => apply())
      }
    } as unknown as PrismaMemoryExecutionService;
    const embed = vi.fn(async () => {
      throw new EmbeddingAdapterError("embedding_provider_http_error", {
        httpStatus: 503
      });
    });
    const service = createMemoryRunUtilityService({
      embeddingRuntime: {
        resolve: vi.fn(async () => ({ adapter: { embed } }))
      } as never,
      execution: executionService,
      provider: { run: vi.fn() } as unknown as MemoryRunUtilityProvider
    });

    await expect(service.embedQuery({
      ...baseInput(),
      profile,
      query: "What did I say about release readiness?"
    })).resolves.toMatchObject({
      bindingId: "embedding-binding-1",
      reason: "memory_query_embedding_transient_http_failure",
      status: "UNAVAILABLE"
    });
    expect(embed).toHaveBeenCalledOnce();
    expect(bind.mock.calls.map((call) => call[1].ordinal)).toEqual([1]);
    expect(settle).toHaveBeenCalledWith(
      "user-1",
      "embedding-binding-1",
      expect.objectContaining({
        errorCode: "memory_query_embedding_transient_http_failure",
        state: "FAILED"
      })
    );
  });

  it("uses one distinct governed query-embedding binding for each bounded job attempt", async () => {
    const executionService = {
      admission: {
        bind: vi.fn(async (_userId: string, input: { ordinal: number }) => ({
          id: `embedding-binding-${input.ordinal}`
        })),
        start: vi.fn(async (_userId: string, bindingId: string) => ({
          bindingId,
          snapshot: snapshot("MEMORY_QUERY_EMBED")
        }))
      },
      lifecycle: {
        settle: vi.fn(async () => ({})),
        withAuthorizedResultCommit: vi.fn(async (
          _userId: string,
          _input: unknown,
          apply: () => Promise<unknown>
        ) => apply())
      }
    } as unknown as PrismaMemoryExecutionService;
    let providerCall = 0;
    const embeddingRuntime = {
      resolve: vi.fn(async () => ({
        adapter: {
          embed: vi.fn(async () => ({
            model: "embedding-upstream-1",
            requestId: `embedding-response-${++providerCall}`,
            usage: { inputTokens: 7, totalTokens: 7 },
            vectors: [Array.from(
              { length: 1_024 },
              (_, index) => index === 0 ? 1 : 0
            )]
          }))
        }
      }))
    };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: embeddingRuntime as never,
      execution: executionService,
      provider: { run: vi.fn() } as unknown as MemoryRunUtilityProvider
    });
    const owner = { memoryJobId: "consolidation-job-1", type: "JOB" as const };

    const first = await service.embedQuery({
      jobAttemptCount: 1,
      owner,
      profile,
      query: "I prefer concise replies.",
      signal: new AbortController().signal,
      userId: "user-1"
    });
    const second = await service.embedQuery({
      jobAttemptCount: 2,
      owner,
      profile,
      query: "I prefer concise replies.",
      signal: new AbortController().signal,
      userId: "user-1"
    });

    expect(first).toMatchObject({ bindingId: "embedding-binding-1", status: "READY" });
    expect(second).toMatchObject({ bindingId: "embedding-binding-2", status: "READY" });
    expect(executionService.admission.bind).toHaveBeenNthCalledWith(
      1,
      "user-1",
      expect.objectContaining({ ordinal: 1, owner })
    );
    expect(executionService.admission.bind).toHaveBeenNthCalledWith(
      2,
      "user-1",
      expect.objectContaining({ ordinal: 2, owner })
    );
    expect(executionService.lifecycle.settle).toHaveBeenNthCalledWith(
      1,
      "user-1",
      "embedding-binding-1",
      expect.objectContaining({ state: "SUCCEEDED" })
    );
    expect(executionService.lifecycle.settle).toHaveBeenNthCalledWith(
      2,
      "user-1",
      "embedding-binding-2",
      expect.objectContaining({ state: "SUCCEEDED" })
    );
  });

  it("accepts one complete bounded rerank decision set after durable binding", async () => {
    const log: string[] = [];
    const bound = execution(log);
    const provider: MemoryRunUtilityProvider = {
      run: vi.fn(async () => {
        log.push("provider");
        return {
          providerResponseId: "response-1",
          toolCalls: [{
            arguments: {
              decisions: [{
                applicable: true,
                current: true,
                handle: "c0",
                reason_code: "DIRECT_RELEVANCE",
                relevance_score: 0.91
              }]
            },
            id: "call-1",
            name: MEMORY_RERANK_TOOL_NAME
          }],
          usage: {
            cachedInputTokens: 0,
            inputTokens: 10,
            outputTokens: 4,
            reasoningTokens: 0,
            totalTokens: 14
          }
        };
      })
    };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: bound.value,
      provider
    });
    const result = await service.rerank({
      ...baseInput(),
      candidates: [{
        ...currentFactRerankCandidate,
        authorityLevel: "SAVED",
        current: true,
        handle: "c0",
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL",
        speakerScope: "memory_record" as const,
        sourceKind: "FACT",
        text: "The user prefers concise replies."
      }],
      profileRequested: false,
      query: "How should I respond?"
    });
    expect(result).toMatchObject({
      bindingId: "binding-MEMORY_RERANK",
      decisions: [{
        applicable: true,
        current: true,
        handle: "c0",
        reasonCode: "DIRECT_RELEVANCE",
        relevanceScore: 0.91
      }],
      status: "READY",
    });
    expect(log).toEqual([
      "bind:MEMORY_RERANK",
      "start",
      "provider",
      "settle",
      "authorize"
    ]);
    expect(provider.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        candidates: [expect.objectContaining({
          text: expect.stringContaining("[authoritative_evidence]")
        })]
      }),
      expect.anything()
    );
  });

  it("renders contextual hints as authority-none with cited raw support", () => {
    const [base] = dedicatedCandidates(1);
    const document = memoryDedicatedRerankDocument({
      ...base!,
      retrievalHint: "Мария выбрала стол у окна.",
      supportingEvidence: [{
        itemId: "prior-round",
        occurredFrom: "2026-01-01T00:00:00.000Z",
        occurredTo: "2026-01-01T00:01:00.000Z",
        sourceChatId: "source-chat",
        text: "User: Мария забронировала стол."
      }],
      text: "User: Она выбрала стол у окна."
    });

    expect(document).toContain("[retrieval_hint derived=true authority=none]");
    expect(document).toContain("[authoritative_evidence]\nUser: Она выбрала стол у окна.");
    expect(document).toContain("[supporting_authoritative_evidence]");
    expect(document).toContain("User: Мария забронировала стол.");
    expect(document.indexOf("[retrieval_hint"))
      .toBeLessThan(document.indexOf("[authoritative_evidence]"));
  });

  it("labels settled tool outcomes as lower-authority tool observations", () => {
    const [base] = dedicatedCandidates(1);
    const document = memoryDedicatedRerankDocument({
      ...base!,
      authorityLevel: "SUPPORTING",
      speakerScope: "tool",
      sourceKind: "TOOL_OBSERVATION",
      text: "Tool file_create completed successfully; filename=report.csv."
    });

    expect(document).toContain(
      "[source=tool_observation speaker=tool state=current lifecycle=not_applicable]"
    );
    expect(document).toContain(
      "[authoritative_evidence]\nTool file_create completed successfully; filename=report.csv."
    );
  });

  it("bounds maximum contextual evidence to the dedicated document limit", () => {
    const [base] = dedicatedCandidates(1);
    const document = memoryDedicatedRerankDocument({
      ...base!,
      retrievalHint: "h".repeat(1_000),
      supportingEvidence: [0, 1].map((index) => ({
        itemId: `prior-round-${index}`,
        occurredFrom: "2026-01-01T00:00:00.000Z",
        occurredTo: "2026-01-01T00:01:00.000Z",
        sourceChatId: "source-chat",
        text: String(index).repeat(4_000)
      })),
      text: "r".repeat(4_000)
    });

    expect(document.length).toBeLessThanOrEqual(MAX_RERANK_DOCUMENT_CHARACTERS);
    expect(document).toContain("[authoritative_evidence]\n" + "r".repeat(4_000));
    expect(document).toContain("[support_1 raw_excerpt=true");
    expect(document).toContain("[support_2 raw_excerpt=true");
  });


  it("reranks the full broad history pool in nine governed batches", async () => {
    const bind = vi.fn(async (_userId: string, input: { ordinal: number }) => ({
      id: `binding-${input.ordinal}`
    }));
    const executionService = {
      admission: {
        bind,
        start: vi.fn(async (_userId: string, bindingId: string) => ({
          bindingId,
          snapshot: snapshot("MEMORY_RERANK")
        }))
      },
      lifecycle: {
        settle: vi.fn(async () => ({})),
        withAuthorizedResultCommit: vi.fn(async (
          _userId: string,
          _input: unknown,
          apply: () => Promise<unknown>
        ) => apply())
      }
    } as unknown as PrismaMemoryExecutionService;
    let active = 0;
    let peak = 0;
    const providerRun = vi.fn(async (
      _evidence: Parameters<MemoryRunUtilityProvider["run"]>[0],
      input: Parameters<MemoryRunUtilityProvider["run"]>[1]
    ) => {
        const rerank = rerankInput(input);
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return {
          providerResponseId: `response-${rerank.candidates[0]?.handle}`,
          toolCalls: [{
            arguments: {
              decisions: rerank.candidates.map((candidate) => ({
                applicable: true,
                current: true,
                handle: candidate.handle,
                reason_code: "SUPPORTING_CONTEXT",
                relevance_score: 0.9
              }))
            },
            id: `call-${rerank.candidates[0]?.handle}`,
            name: MEMORY_RERANK_TOOL_NAME
          }],
          usage: {
            cachedInputTokens: 0,
            inputTokens: 100,
            outputTokens: 50,
            reasoningTokens: 0,
            totalTokens: 150
          }
        };
      });
    const provider: MemoryRunUtilityProvider = { run: providerRun };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: executionService,
      provider
    });
    const candidates = Array.from({
      length: MEMORY_RERANK_AGGREGATION_MAX_CANDIDATES
    }, (_, index) => ({
      ...currentHistoryRerankCandidate,
      authorityLevel: "PAST_CHAT" as const,
      current: true,
      handle: `c${index}`,
      occurredFrom: null,
      occurredTo: null,
      sensitivityClass: "NORMAL" as const,
      speakerScope: "mixed_conversation" as const,
      sourceKind: "HISTORY" as const,
      text: `Safe digest for an unrelated project milestone ${index}.`
    }));

    const result = await service.rerank({
      ...baseInput(),
      aggregationRequested: true,
      candidates,
      profileRequested: false,
      query: "Which project milestones did I mention across our chats?",
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "ANY"
    });

    expect(result).toMatchObject({ bindingId: "binding-2", status: "READY" });
    expect(result.status === "READY" ? result.decisions.map(({ handle }) => handle) : [])
      .toEqual(candidates.map(({ handle }) => handle));
    expect(providerRun).toHaveBeenCalledTimes(MEMORY_RERANK_AGGREGATION_MAX_BATCHES);
    expect(providerRun.mock.calls.map((call) => rerankInput(call[1]).candidates.length))
      .toEqual(Array.from(
        { length: MEMORY_RERANK_AGGREGATION_MAX_BATCHES },
        () => MEMORY_RERANK_AGGREGATION_BATCH_SIZE
      ));
    expect(bind).toHaveBeenCalledTimes(MEMORY_RERANK_AGGREGATION_MAX_BATCHES);
    expect(bind.mock.calls.map((call) => call[1].ordinal))
      .toEqual(Array.from(
        { length: MEMORY_RERANK_AGGREGATION_MAX_BATCHES },
        (_, index) => 2 + index * MEMORY_RERANK_MAX_ATTEMPTS
      ));
    expect(peak).toBe(MEMORY_RERANK_AGGREGATION_MAX_PARALLEL_BATCHES);
  });

  it("reranks the widened targeted pool in bounded governed batches", async () => {
    const log: string[] = [];
    const bound = execution(log);
    const providerRun = vi.fn(async (
      _evidence: Parameters<MemoryRunUtilityProvider["run"]>[0],
      input: Parameters<MemoryRunUtilityProvider["run"]>[1]
    ) => {
      const rerank = rerankInput(input);
      return {
        providerResponseId: `response-${rerank.candidates[0]?.handle}`,
        toolCalls: [{
          arguments: {
            decisions: rerank.candidates.map((candidate) => ({
              applicable: true,
              current: true,
              handle: candidate.handle,
              reason_code: "DIRECT_RELEVANCE",
              relevance_score: 0.9
            }))
          },
          id: `call-${rerank.candidates[0]?.handle}`,
          name: MEMORY_RERANK_TOOL_NAME
        }],
        usage: {
          cachedInputTokens: 0,
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 0,
          totalTokens: 150
        }
      };
    });
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: bound.value,
      provider: { run: providerRun }
    });
    const candidates = Array.from({
      length: MEMORY_RERANK_TARGETED_MAX_CANDIDATES
    }, (_, index) => ({
      ...currentFactRerankCandidate,
      authorityLevel: "SAVED" as const,
      current: true,
      handle: `c${index}`,
      occurredFrom: null,
      occurredTo: null,
      sensitivityClass: "NORMAL" as const,
      speakerScope: "memory_record" as const,
      sourceKind: "FACT" as const,
      text: `Safe targeted fact ${index}.`
    }));

    const result = await service.rerank({
      ...baseInput(),
      candidates,
      profileRequested: false,
      query: "Which facts apply?"
    });

    expect(result.status === "READY" ? result.decisions.map(({ handle }) => handle) : [])
      .toEqual(candidates.map(({ handle }) => handle));
    expect(providerRun).toHaveBeenCalledTimes(4);
    expect(providerRun.mock.calls.map((call) => rerankInput(call[1]).candidates.length))
      .toEqual([20, 20, 20, 20]);
    expect(bound.admission.bind.mock.calls.map((call) => call[1].ordinal))
      .toEqual(Array.from(
        { length: 4 },
        (_, index) => 2 + index * MEMORY_RERANK_MAX_ATTEMPTS
      ));
  });

  it("partitions aggregation reranking by the complete structured prompt limit", async () => {
    const bind = vi.fn(async (_userId: string, input: { ordinal: number }) => ({
      id: `binding-${input.ordinal}`
    }));
    const executionService = {
      admission: {
        bind,
        start: vi.fn(async (_userId: string, bindingId: string) => ({
          bindingId,
          snapshot: snapshot("MEMORY_RERANK")
        }))
      },
      lifecycle: {
        settle: vi.fn(async () => ({})),
        withAuthorizedResultCommit: vi.fn(async (
          _userId: string,
          _input: unknown,
          apply: () => Promise<unknown>
        ) => apply())
      }
    } as unknown as PrismaMemoryExecutionService;
    const promptSizes: number[] = [];
    const providerRun = vi.fn(async (
      _evidence: Parameters<MemoryRunUtilityProvider["run"]>[0],
      input: Parameters<MemoryRunUtilityProvider["run"]>[1]
    ) => {
      const rerank = rerankInput(input);
      promptSizes.push(memoryRunUtilityPromptCharacters(input));
      return {
        providerResponseId: `response-${rerank.candidates[0]?.handle}`,
        toolCalls: [{
          arguments: {
            decisions: rerank.candidates.map((candidate) => ({
              applicable: true,
              current: true,
              handle: candidate.handle,
              reason_code: "SUPPORTING_CONTEXT",
              relevance_score: 0.9
            }))
          },
          id: `call-${rerank.candidates[0]?.handle}`,
          name: MEMORY_RERANK_TOOL_NAME
        }],
        usage: {
          cachedInputTokens: 0,
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 0,
          totalTokens: 150
        }
      };
    });
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: executionService,
      provider: { run: providerRun }
    });
    const candidates = Array.from({ length: 60 }, (_, index) => ({
      ...currentHistoryRerankCandidate,
      authorityLevel: "PAST_CHAT" as const,
      current: true,
      handle: `c${index}`,
      occurredFrom: null,
      occurredTo: null,
      sensitivityClass: "NORMAL" as const,
      speakerScope: "mixed_conversation" as const,
      sourceKind: "HISTORY" as const,
      text: `Digest ${index}: `.padEnd(4_000, "x")
    }));

    const result = await service.rerank({
      ...baseInput(),
      aggregationRequested: true,
      candidates,
      profileRequested: false,
      query: "Which deployment rehearsals did I mention across our chats?",
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "ANY"
    });

    expect(result).toMatchObject({ bindingId: "binding-2", status: "READY" });
    expect(providerRun.mock.calls.length).toBeGreaterThan(3);
    expect(providerRun.mock.calls.length)
      .toBeLessThanOrEqual(MEMORY_RERANK_AGGREGATION_MAX_BATCHES);
    expect(providerRun.mock.calls.flatMap((call) =>
      rerankInput(call[1]).candidates.map((candidate) => candidate.handle)
    )).toEqual(candidates.map((candidate) => candidate.handle));
    expect(promptSizes.every((size) =>
      size <= MEMORY_RERANK_MAX_PROMPT_CHARACTERS
    )).toBe(true);
    expect(bind.mock.calls.map((call) => call[1].ordinal))
      .toEqual(promptSizes.map((_, index) =>
        2 + index * MEMORY_RERANK_MAX_ATTEMPTS));
  });

  it("binds and dispatches distinct ordinary and broad-profile rerank inputs", async () => {
    const log: string[] = [];
    const bound = execution(log);
    const provider: MemoryRunUtilityProvider = {
      run: vi.fn(async () => ({
        providerResponseId: "response-1",
        toolCalls: [{
          arguments: {
            decisions: [{
              applicable: true,
              current: true,
              handle: "c0",
              reason_code: "DIRECT_RELEVANCE",
              relevance_score: 0.91
            }]
          },
          id: "call-1",
          name: MEMORY_RERANK_TOOL_NAME
        }],
        usage: {
          cachedInputTokens: 0,
          inputTokens: 10,
          outputTokens: 4,
          reasoningTokens: 0,
          totalTokens: 14
        }
      }))
    };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: bound.value,
      provider
    });
    const input = {
      ...baseInput(),
      candidates: [{
        ...currentFactRerankCandidate,
        authorityLevel: "SAVED" as const,
        current: true,
        handle: "c0",
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL" as const,
        speakerScope: "memory_record" as const,
        sourceKind: "FACT" as const,
        text: "The user's name is Nebula."
      }],
      query: "What do you know about me?"
    };

    await expect(service.rerank({
      ...input,
      profileRequested: false
    })).resolves.toMatchObject({ status: "READY" });
    await expect(service.rerank({
      ...input,
      profileRequested: true,
      retrievalMode: "CURRENT_PROFILE"
    })).resolves.toMatchObject({ status: "READY" });

    const ordinaryHash = bound.admission.bind.mock.calls[0]?.[1].inputHash;
    const profileHash = bound.admission.bind.mock.calls[1]?.[1].inputHash;
    expect(ordinaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(profileHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(profileHash).not.toBe(ordinaryHash);
    expect(provider.run).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ profileRequested: false }),
      input.signal
    );
    expect(provider.run).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ profileRequested: true }),
      input.signal
    );
  });

  it("rejects a broad-profile batch when any decision is malformed", async () => {
    const log: string[] = [];
    const bound = execution(log);
    const provider: MemoryRunUtilityProvider = {
      run: vi.fn(async () => ({
        providerResponseId: "response-1",
        toolCalls: [{
          arguments: {
            decisions: [{
              applicable: true,
              current: true,
              handle: "c0",
              reason_code: "DIRECT_RELEVANCE",
              relevance_score: 0.95
            }, {
              applicable: false,
              current: true,
              handle: "c1",
              reason_code: "NOT_RELEVANT",
              relevance_score: 2
            }]
          },
          id: "call-1",
          name: MEMORY_RERANK_TOOL_NAME
        }],
        usage: {
          cachedInputTokens: 0,
          inputTokens: 12,
          outputTokens: 8,
          reasoningTokens: 0,
          totalTokens: 20
        }
      }))
    };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: bound.value,
      provider
    });

    await expect(service.rerank({
      ...baseInput(),
      candidates: [{
        ...currentFactRerankCandidate,
        authorityLevel: "SAVED",
        current: true,
        handle: "c0",
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL",
        speakerScope: "memory_record" as const,
        sourceKind: "FACT",
        text: "The user's name is Nebula."
      }, {
        ...currentFactRerankCandidate,
        authorityLevel: "LEARNED",
        current: true,
        handle: "c1",
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL",
        speakerScope: "memory_record" as const,
        sourceKind: "FACT",
        text: "The user lives in Rostov."
      }],
      profileRequested: true,
      retrievalMode: "CURRENT_PROFILE",
      query: "What do you know about me?"
    })).resolves.toMatchObject({
      diagnostics: {
        batchCount: 1,
        candidateCount: 2,
        coverageRatio: 0,
        decisionCount: 0,
        duplicateDecisionCount: 0,
        failedBatchCount: 1,
        fullFallbackUsed: true,
        invalidResponseCount: 2,
        missingDecisionCount: 2,
        providerModelMismatchCount: 0,
        readyBatchCount: 0,
        retryCount: 1
      },
      externalCallCount: 2,
      reason: "memory_run_utility_output_invalid",
      status: "UNAVAILABLE"
    });
    expect(provider.run).toHaveBeenCalledTimes(2);
    expect(bound.lifecycle.settle).toHaveBeenCalledTimes(2);
    expect(bound.lifecycle.settle.mock.calls.map((call) => call[2]))
      .toEqual(Array.from({ length: 2 }, () => expect.objectContaining({
        errorCode: "memory_run_utility_output_invalid",
        state: "FAILED"
      })));
  });

  it("accepts a broad-profile result when every supplied fact is directly relevant", async () => {
    const log: string[] = [];
    const bound = execution(log);
    const provider: MemoryRunUtilityProvider = {
      run: vi.fn(async () => ({
        providerResponseId: "response-1",
        toolCalls: [{
          arguments: {
            decisions: [{
              applicable: true,
              current: true,
              handle: "c0",
              reason_code: "DIRECT_RELEVANCE",
              relevance_score: 0.95
            }, {
              applicable: true,
              current: true,
              handle: "c1",
              reason_code: "DIRECT_RELEVANCE",
              relevance_score: 0.61
            }]
          },
          id: "call-1",
          name: MEMORY_RERANK_TOOL_NAME
        }],
        usage: {
          cachedInputTokens: 0,
          inputTokens: 12,
          outputTokens: 8,
          reasoningTokens: 0,
          totalTokens: 20
        }
      }))
    };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: bound.value,
      provider
    });

    await expect(service.rerank({
      ...baseInput(),
      candidates: [{
        ...currentFactRerankCandidate,
        authorityLevel: "SAVED",
        current: true,
        handle: "c0",
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL",
        speakerScope: "memory_record" as const,
        sourceKind: "FACT",
        text: "The user's name is Nebula."
      }, {
        ...currentFactRerankCandidate,
        authorityLevel: "LEARNED",
        current: true,
        handle: "c1",
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL",
        speakerScope: "memory_record" as const,
        sourceKind: "FACT",
        text: "The user lives in Rostov."
      }],
      profileRequested: true,
      retrievalMode: "CURRENT_PROFILE",
      query: "What do you know about me?"
    })).resolves.toMatchObject({
      bindingId: "binding-MEMORY_RERANK",
      decisions: [{
        applicable: true,
        current: true,
        handle: "c0",
        reasonCode: "DIRECT_RELEVANCE",
        relevanceScore: 0.95
      }, {
        applicable: true,
        current: true,
        handle: "c1",
        reasonCode: "DIRECT_RELEVANCE",
        relevanceScore: 0.61
      }],
      status: "READY"
    });
    expect(provider.run).toHaveBeenCalledOnce();
  });

  it("records uncertain provider outcomes and never sends secret-tainted rerank input", async () => {
    const log: string[] = [];
    const bound = execution(log);
    const provider: MemoryRunUtilityProvider = {
      run: vi.fn(async () => {
        log.push("provider");
        throw new MemoryRunUtilityProviderCallError(null);
      })
    };
    const service: MemoryRunUtilityService = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: bound.value,
      provider
    });
    const uncertain = await service.rerank({
      ...baseInput(),
      candidates: [{
        ...currentHistoryRerankCandidate,
        authorityLevel: "PAST_CHAT",
        current: true,
        handle: "c0",
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL",
        speakerScope: "mixed_conversation" as const,
        sourceKind: "HISTORY",
        text: "We discussed PostgreSQL migrations."
      }],
      profileRequested: false,
      query: "what did we discuss last time"
    });
    expect(uncertain).toMatchObject({
      bindingId: "binding-MEMORY_RERANK",
      externalCallCount: 2,
      reason: "memory_run_utility_outcome_unknown",
      status: "UNAVAILABLE"
    });
    expect(bound.lifecycle.settle.mock.calls[0]?.[2]).toMatchObject({
      state: "OUTCOME_UNKNOWN",
      usage: { completeness: "UNAVAILABLE" }
    });
    expect(bound.lifecycle.settle).toHaveBeenCalledTimes(2);

    const blocked = await service.rerank({
      ...baseInput(),
      candidates: [{
        ...currentHistoryRerankCandidate,
        authorityLevel: "PAST_CHAT",
        current: true,
        handle: "c0",
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL",
        speakerScope: "mixed_conversation" as const,
        sourceKind: "HISTORY",
        text: "API key sk-abcdefghijklmnopqrstuvwxyz123456"
      }],
      profileRequested: false,
      query: "previous chat"
    });
    expect(blocked).toEqual({
      reason: "memory_utility_input_blocked",
      status: "UNAVAILABLE"
    });
    expect(provider.run).toHaveBeenCalledTimes(2);
  });

  it("blocks a candidate beyond the widened targeted bound before provider I/O", async () => {
    const log: string[] = [];
    const bound = execution(log);
    const provider = { run: vi.fn() } as unknown as MemoryRunUtilityProvider;
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: bound.value,
      provider
    });

    await expect(service.rerank({
      ...baseInput(),
      candidates: Array.from({ length: MEMORY_RERANK_TARGETED_MAX_CANDIDATES + 1 },
        (_, index) => ({
        ...currentFactRerankCandidate,
        authorityLevel: "SAVED" as const,
        current: true,
        handle: `c${index}`,
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL" as const,
        speakerScope: "memory_record" as const,
        sourceKind: "FACT" as const,
        text: `Fact ${index}`
        })),
      profileRequested: false,
      query: "Which facts apply?"
    })).resolves.toMatchObject({
      reason: "memory_utility_input_blocked",
      status: "UNAVAILABLE"
    });
    expect(bound.admission.bind).not.toHaveBeenCalled();
    expect(provider.run).not.toHaveBeenCalled();
  });

  it("blocks a candidate beyond the widened aggregation bound before provider I/O", async () => {
    const log: string[] = [];
    const bound = execution(log);
    const provider = { run: vi.fn() } as unknown as MemoryRunUtilityProvider;
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: bound.value,
      provider
    });

    await expect(service.rerank({
      ...baseInput(),
      aggregationRequested: true,
      candidates: Array.from({ length: MEMORY_RERANK_AGGREGATION_MAX_CANDIDATES + 1 },
        (_, index) => ({
        ...currentHistoryRerankCandidate,
        authorityLevel: "PAST_CHAT" as const,
        current: true,
        handle: `c${index}`,
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL" as const,
        speakerScope: "mixed_conversation" as const,
        sourceKind: "HISTORY" as const,
        text: `History candidate ${index}`
        })),
      profileRequested: false,
      query: "Which events happened across my chats?",
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "ANY"
    })).resolves.toMatchObject({
      reason: "memory_utility_input_blocked",
      status: "UNAVAILABLE"
    });
    expect(bound.admission.bind).not.toHaveBeenCalled();
    expect(provider.run).not.toHaveBeenCalled();
  });

  it("rejects missing and duplicate compatibility decisions across one fresh retry", async () => {
    const log: string[] = [];
    const settled: unknown[] = [];
    const executionService = {
      admission: {
        bind: vi.fn(async (_userId: string, input: { ordinal: number }) => ({
          id: `binding-${input.ordinal}`
        })),
        start: vi.fn(async (_userId: string, bindingId: string) => ({
          bindingId,
          snapshot: snapshot("MEMORY_RERANK")
        }))
      },
      lifecycle: {
        settle: vi.fn(async (_userId: string, _bindingId: string, input: unknown) => {
          settled.push(input);
          return {};
        }),
        withAuthorizedResultCommit: vi.fn()
      }
    } as unknown as PrismaMemoryExecutionService;
    const provider: MemoryRunUtilityProvider = {
      run: vi.fn(async () => {
        log.push("provider");
        return {
          providerResponseId: `response-${log.length}`,
          toolCalls: [{
            arguments: {
              decisions: log.length === 1
                ? [{
                    applicable: true,
                    current: true,
                    handle: "c0",
                    reason_code: "DIRECT_RELEVANCE",
                    relevance_score: 0.9
                  }]
                : [{
                    applicable: true,
                    current: true,
                    handle: "c0",
                    reason_code: "DIRECT_RELEVANCE",
                    relevance_score: 0.9
                  }, {
                    applicable: false,
                    current: true,
                    handle: "c0",
                    reason_code: "NOT_RELEVANT",
                    relevance_score: 0.1
                  }]
            },
            id: `call-${log.length}`,
            name: MEMORY_RERANK_TOOL_NAME
          }],
          usage: {
            cachedInputTokens: 0,
            inputTokens: 5,
            outputTokens: 1,
            reasoningTokens: 0,
            totalTokens: 6
          }
        };
      })
    };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: executionService,
      provider
    });

    await expect(service.rerank({
      ...baseInput(),
      candidates: [{
        ...currentFactRerankCandidate,
        authorityLevel: "SAVED",
        current: true,
        handle: "c0",
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL",
        speakerScope: "memory_record" as const,
        sourceKind: "FACT",
        text: "The user prefers concise replies."
      }, {
        ...currentFactRerankCandidate,
        authorityLevel: "LEARNED",
        current: true,
        handle: "c1",
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL",
        speakerScope: "memory_record" as const,
        sourceKind: "FACT",
        text: "The user prefers direct examples."
      }],
      profileRequested: false,
      query: "How should I respond?"
    })).resolves.toMatchObject({
      bindingId: "binding-3",
      diagnostics: {
        candidateCount: 2,
        decisionCount: 0,
        fullFallbackUsed: true,
        invalidResponseCount: 2,
        missingDecisionCount: 2,
        retryCount: 1
      },
      externalCallCount: 2,
      reason: "memory_run_utility_output_invalid",
      status: "UNAVAILABLE"
    });
    expect(MEMORY_RERANK_MAX_ATTEMPTS).toBe(2);
    expect(provider.run).toHaveBeenCalledTimes(2);
    expect(executionService.admission.bind).toHaveBeenCalledTimes(2);
    expect(settled).toHaveLength(2);
    expect(settled).toEqual([
      expect.objectContaining({ state: "FAILED" }),
      expect.objectContaining({ state: "FAILED" })
    ]);
  });

  it("accepts one valid retry and preserves per-attempt settlement evidence", async () => {
    const executionService = {
      admission: {
        bind: vi.fn(async (_userId: string, input: { ordinal: number }) => ({
          id: `binding-${input.ordinal}`
        })),
        start: vi.fn(async (_userId: string, bindingId: string) => ({
          bindingId,
          snapshot: snapshot("MEMORY_RERANK")
        }))
      },
      lifecycle: {
        settle: vi.fn(async () => ({})),
        withAuthorizedResultCommit: vi.fn(async (
          _userId: string,
          _input: unknown,
          apply: () => Promise<unknown>
        ) => apply())
      }
    } as unknown as PrismaMemoryExecutionService;
    let attempt = 0;
    const provider: MemoryRunUtilityProvider = {
      run: vi.fn(async () => {
        attempt += 1;
        return attempt === 1
          ? {
              providerResponseId: "response-invalid",
              toolCalls: [{
                arguments: {
                  decisions: [{
                    applicable: true,
                    current: true,
                    handle: "x0",
                    reason_code: "NOT_RELEVANT",
                    relevance_score: 0.1
                  }]
                },
                id: "call-invalid",
                name: MEMORY_RERANK_TOOL_NAME
              }],
              usage: {
                cachedInputTokens: 0,
                inputTokens: 5,
                outputTokens: 1,
                reasoningTokens: 0,
                totalTokens: 6
              }
            }
          : {
              providerResponseId: "response-valid",
              toolCalls: [{
                arguments: {
                  decisions: [{
                    applicable: true,
                    current: true,
                    handle: "c0",
                    reason_code: "DIRECT_RELEVANCE",
                    relevance_score: 0.91
                  }]
                },
                id: "call-valid",
                name: MEMORY_RERANK_TOOL_NAME
              }],
              usage: {
                cachedInputTokens: 0,
                inputTokens: 10,
                outputTokens: 4,
                reasoningTokens: 0,
                totalTokens: 14
              }
            };
      })
    };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: executionService,
      provider
    });

    await expect(service.rerank({
      ...baseInput(),
      candidates: [{
        ...currentFactRerankCandidate,
        authorityLevel: "SAVED",
        current: true,
        handle: "c0",
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL",
        speakerScope: "memory_record" as const,
        sourceKind: "FACT",
        text: "The user prefers concise replies."
      }],
      profileRequested: false,
      query: "How should I respond?"
    })).resolves.toMatchObject({
      bindingId: "binding-3",
      decisions: [{
        applicable: true,
        current: true,
        handle: "c0",
        reasonCode: "DIRECT_RELEVANCE",
        relevanceScore: 0.91
      }],
      externalCallCount: 2,
      status: "READY"
    });
    expect(provider.run).toHaveBeenCalledTimes(2);
    expect(executionService.lifecycle.settle).toHaveBeenNthCalledWith(
      1,
      "user-1",
      "binding-2",
      expect.objectContaining({
        errorCode: "memory_run_utility_output_invalid",
        providerResponseId: "response-invalid",
        state: "FAILED",
        usage: expect.objectContaining({ totalTokens: 6 })
      })
    );
    expect(executionService.lifecycle.settle).toHaveBeenNthCalledWith(
      2,
      "user-1",
      "binding-3",
      expect.objectContaining({
        errorCode: null,
        providerResponseId: "response-valid",
        state: "SUCCEEDED",
        usage: expect.objectContaining({ totalTokens: 14 })
      })
    );
  });

  it.each([
    ["DIRECT_RELEVANCE", false, true],
    ["SUPPORTING_CONTEXT", true, false],
    ["RESPONSE_PREFERENCE", false, false],
    ["OUTDATED", false, true],
    ["OUTDATED", true, false],
    ["NOT_RELEVANT", true, true]
  ] as const)(
    "accepts non-authoritative compatibility flags for %s without retrying",
    async (reasonCode, applicable, current) => {
      const executionService = {
        admission: {
          bind: vi.fn(async (_userId: string, input: { ordinal: number }) => ({
            id: `binding-${input.ordinal}`
          })),
          start: vi.fn(async (_userId: string, bindingId: string) => ({
            bindingId,
            snapshot: snapshot("MEMORY_RERANK")
          }))
        },
        lifecycle: {
          settle: vi.fn(async () => ({})),
          withAuthorizedResultCommit: vi.fn()
        }
      } as unknown as PrismaMemoryExecutionService;
      const provider: MemoryRunUtilityProvider = {
        run: vi.fn(async () => ({
          providerResponseId: "response-invalid",
          toolCalls: [{
            arguments: {
              decisions: [{
                applicable,
                current,
                handle: "c0",
                reason_code: reasonCode,
                relevance_score: 0.1
              }]
            },
            id: "call-invalid",
            name: MEMORY_RERANK_TOOL_NAME
          }],
          usage: {
            cachedInputTokens: 0,
            inputTokens: 5,
            outputTokens: 1,
            reasoningTokens: 0,
            totalTokens: 6
          }
        }))
      };
      const service = createMemoryRunUtilityService({
        embeddingRuntime: { resolve: vi.fn() } as never,
        execution: executionService,
        provider
      });

      await expect(service.rerank({
        ...baseInput(),
        candidates: [{
          ...currentFactRerankCandidate,
          authorityLevel: "SAVED",
          current: true,
          handle: "c0",
          occurredFrom: null,
          occurredTo: null,
          sensitivityClass: "NORMAL",
          speakerScope: "memory_record" as const,
          sourceKind: "FACT",
          text: "The user prefers concise replies."
        }],
        profileRequested: false,
        query: "How should I respond?"
      })).resolves.toMatchObject({
        bindingId: "binding-2",
        decisions: [{
          applicable,
          current,
          handle: "c0",
          reasonCode,
          relevanceScore: 0.1
        }],
        status: "READY"
      });
      expect(provider.run).toHaveBeenCalledOnce();
      expect(executionService.lifecycle.settle).toHaveBeenCalledOnce();
      expect(executionService.lifecycle.settle).toHaveBeenCalledWith(
        "user-1",
        "binding-2",
        expect.objectContaining({ errorCode: null, state: "SUCCEEDED" })
      );
    }
  );

  it("does not retry unless the invalid first result was durably settled", async () => {
    const executionService = {
      admission: {
        bind: vi.fn(async () => ({ id: "binding-2" })),
        start: vi.fn(async () => ({
          bindingId: "binding-2",
          snapshot: snapshot("MEMORY_RERANK")
        }))
      },
      lifecycle: {
        settle: vi.fn(async () => { throw new Error("database unavailable"); }),
        withAuthorizedResultCommit: vi.fn()
      }
    } as unknown as PrismaMemoryExecutionService;
    const provider: MemoryRunUtilityProvider = {
      run: vi.fn(async () => ({
        providerResponseId: "response-1",
        toolCalls: [],
        usage: {
          cachedInputTokens: 0,
          inputTokens: 5,
          outputTokens: 1,
          reasoningTokens: 0,
          totalTokens: 6
        }
      }))
    };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: executionService,
      provider
    });

    await expect(service.rerank({
      ...baseInput(),
      candidates: [{
        ...currentFactRerankCandidate,
        authorityLevel: "SAVED",
        current: true,
        handle: "c0",
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL",
        speakerScope: "memory_record" as const,
        sourceKind: "FACT",
        text: "The user prefers concise replies."
      }],
      profileRequested: false,
      query: "How should I respond?"
    })).resolves.toMatchObject({
      reason: "memory_run_utility_settle_failed",
      status: "UNAVAILABLE"
    });
    expect(provider.run).toHaveBeenCalledOnce();
    expect(executionService.admission.bind).toHaveBeenCalledOnce();
  });

  it("rejects a non-strict reranker binding before provider dispatch", async () => {
    const nonStrict = {
      ...snapshot("MEMORY_RERANK"),
      requiresStrictStructuredOutput: false
    } as MemorySecretFreeExecutionSnapshot;
    const executionService = {
      admission: {
        bind: vi.fn(async () => ({ id: "binding-2" })),
        start: vi.fn(async () => ({ bindingId: "binding-2", snapshot: nonStrict }))
      },
      lifecycle: {
        settle: vi.fn(async () => ({})),
        withAuthorizedResultCommit: vi.fn()
      }
    } as unknown as PrismaMemoryExecutionService;
    const provider = { run: vi.fn() } as unknown as MemoryRunUtilityProvider;
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: executionService,
      provider
    });

    await expect(service.rerank({
      ...baseInput(),
      candidates: [{
        ...currentFactRerankCandidate,
        authorityLevel: "SAVED",
        current: true,
        handle: "c0",
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL",
        speakerScope: "memory_record" as const,
        sourceKind: "FACT",
        text: "The user prefers concise replies."
      }],
      profileRequested: false,
      query: "How should I respond?"
    })).resolves.toMatchObject({
      reason: "memory_run_utility_binding_invalid",
      status: "UNAVAILABLE"
    });
    expect(provider.run).not.toHaveBeenCalled();
    expect(executionService.lifecycle.settle).toHaveBeenCalledWith(
      "user-1",
      "binding-2",
      expect.objectContaining({ state: "FAILED" })
    );
  });

  it("pins a retry to the first exact execution snapshot", async () => {
    const first = snapshot("MEMORY_RERANK");
    const changed = {
      ...first,
      destinationFingerprint: "9".repeat(64)
    } as MemorySecretFreeExecutionSnapshot;
    let started = 0;
    const executionService = {
      admission: {
        bind: vi.fn(async (_userId: string, input: { ordinal: number }) => ({
          id: `binding-${input.ordinal}`
        })),
        start: vi.fn(async (_userId: string, bindingId: string) => ({
          bindingId,
          snapshot: started++ === 0 ? first : changed
        }))
      },
      lifecycle: {
        settle: vi.fn(async () => ({})),
        withAuthorizedResultCommit: vi.fn()
      }
    } as unknown as PrismaMemoryExecutionService;
    const provider: MemoryRunUtilityProvider = {
      run: vi.fn(async () => ({
        providerResponseId: "response-1",
        toolCalls: [],
        usage: {
          cachedInputTokens: 0,
          inputTokens: 5,
          outputTokens: 1,
          reasoningTokens: 0,
          totalTokens: 6
        }
      }))
    };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: executionService,
      provider
    });

    await expect(service.rerank({
      ...baseInput(),
      candidates: [{
        ...currentFactRerankCandidate,
        authorityLevel: "SAVED",
        current: true,
        handle: "c0",
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL",
        speakerScope: "memory_record" as const,
        sourceKind: "FACT",
        text: "The user prefers concise replies."
      }],
      profileRequested: false,
      query: "How should I respond?"
    })).resolves.toMatchObject({
      bindingId: "binding-3",
      reason: "memory_run_utility_binding_changed",
      status: "UNAVAILABLE"
    });
    expect(provider.run).toHaveBeenCalledOnce();
    expect(executionService.lifecycle.settle).toHaveBeenCalledTimes(2);
    expect(executionService.lifecycle.settle).toHaveBeenLastCalledWith(
      "user-1",
      "binding-3",
      expect.objectContaining({
        errorCode: "memory_run_utility_binding_changed",
        state: "FAILED"
      })
    );
  });

  it("uses one dedicated reranker request for the normal 60-candidate pool", async () => {
    const harness = dedicatedHarness(async (request) => ({
      model: "qwen/qwen3-reranker-8b",
      provider: "Together",
      requestId: "rerank-request-1",
      scores: request.documents.map((document, index) => ({
        handle: document.handle,
        index,
        relevanceScore: 1 - index / 100
      })),
      usage: { inputTokens: 320, searchUnits: 1, totalTokens: 320 }
    }));
    const candidates = dedicatedCandidates(60);

    const result = await harness.service.rerank({
      ...baseInput(),
      candidates,
      profileRequested: false,
      query: "Which release milestones did I discuss?",
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "ANY"
    });

    expect(result).toMatchObject({ bindingId: "binding-2", status: "READY" });
    expect(result.status === "READY" ? result.decisions : []).toHaveLength(60);
    expect(harness.rerank).toHaveBeenCalledOnce();
    expect(harness.provider.run).not.toHaveBeenCalled();
    const request = harness.rerank.mock.calls[0]?.[0];
    expect(request?.documents).toHaveLength(60);
    expect(request?.documents[0]).toEqual({
      handle: "c0",
      text: expect.stringMatching(
        /^\[date_from=2026-01-01T00:00:00\.000Z date_to=open\]\n\[source=history speaker=mixed_conversation state=current lifecycle=not_applicable\]\n/u
      )
    });
    expect(harness.resolve).toHaveBeenCalledWith({
      connectionId: "reranker-connection",
      credentialId: "reranker-credential",
      credentialVersionId: "reranker-credential-version",
      executionSnapshot: harness.accepted.providerExecutionSnapshot,
      providerModelId: "reranker-model"
    });
    expect(harness.executionService.lifecycle.settle).toHaveBeenCalledWith(
      "user-1",
      "binding-2",
      expect.objectContaining({
        errorCode: null,
        providerResponseId: "rerank-request-1",
        state: "SUCCEEDED",
        usage: expect.objectContaining({
          completeness: "COMPLETE",
          inputTokens: 320,
          outputTokens: 0,
          totalTokens: 320
        })
      })
    );
  });

  it("discards dedicated partial scores and falls back atomically", async () => {
    const harness = dedicatedHarness(async () => ({
      model: "qwen/qwen3-reranker-8b",
      provider: "Together",
      requestId: "rerank-partial",
      scores: [
        { handle: "c2", index: 2, relevanceScore: 0.92 },
        { handle: "c0", index: 0, relevanceScore: 0.41 }
      ],
      usage: { inputTokens: null, searchUnits: 1, totalTokens: null }
    }));

    await expect(harness.service.rerank({
      ...baseInput(),
      candidates: dedicatedCandidates(3),
      profileRequested: false,
      query: "query"
    })).resolves.toMatchObject({
      bindingId: "binding-3",
      diagnostics: {
        batchCount: 1,
        candidateCount: 3,
        coverageRatio: 0,
        decisionCount: 0,
        duplicateDecisionCount: 0,
        failedBatchCount: 1,
        fullFallbackUsed: true,
        invalidResponseCount: 2,
        missingDecisionCount: 3,
        providerModelMismatchCount: 0,
        readyBatchCount: 0,
        retryCount: 1
      },
      externalCallCount: 2,
      reason: "memory_run_utility_output_invalid",
      status: "UNAVAILABLE"
    });
    expect(harness.rerank).toHaveBeenCalledTimes(2);
    expect(harness.executionService.lifecycle.settle).toHaveBeenCalledTimes(2);
    expect(harness.settle.mock.calls.map((call) => call[2]))
      .toEqual(Array.from({ length: 2 }, () => expect.objectContaining({
        errorCode: "memory_run_utility_output_invalid",
        state: "FAILED"
      })));
  });

  it("retries one transport-uncertain dedicated rerank against the same snapshot", async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const harness = dedicatedHarness(async (request) => {
        attempt += 1;
        if (attempt === 1) {
          throw new RerankAdapterError("rerank_provider_request_failed");
        }
        return {
          model: "qwen/qwen3-reranker-8b",
          provider: "Together",
          requestId: "rerank-retry-success",
          scores: request.documents.map((document, index) => ({
            handle: document.handle,
            index,
            relevanceScore: 0.9 - index / 100
          })),
          usage: { inputTokens: 20, searchUnits: 1, totalTokens: 20 }
        };
      });

      const pending = harness.service.rerank({
        ...baseInput(),
        candidates: dedicatedCandidates(3),
        profileRequested: false,
        query: "Which release milestones did I discuss?"
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result).toMatchObject({
        bindingId: "binding-3",
        externalCallCount: 2,
        status: "READY"
      });
      expect(result.status === "READY" ? result.decisions : []).toHaveLength(3);
      expect(harness.rerank).toHaveBeenCalledTimes(2);
      expect(harness.bind.mock.calls.map((call) => call[1].ordinal)).toEqual([2, 3]);
      expect(harness.executionService.lifecycle.settle).toHaveBeenNthCalledWith(
        1,
        "user-1",
        "binding-2",
        expect.objectContaining({
          errorCode: "rerank_provider_request_failed",
          state: "OUTCOME_UNKNOWN"
        })
      );
      expect(harness.executionService.lifecycle.settle).toHaveBeenNthCalledWith(
        2,
        "user-1",
        "binding-3",
        expect.objectContaining({ errorCode: null, state: "SUCCEEDED" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a dedicated rerank retry after the caller's soft deadline", async () => {
    const canRetry = vi.fn(() => false);
    const harness = dedicatedHarness(async () => {
      throw new RerankAdapterError("rerank_provider_request_failed");
    });

    await expect(harness.service.rerank({
      ...baseInput(),
      candidates: dedicatedCandidates(3),
      canRetry,
      profileRequested: false,
      query: "Which release milestones did I discuss?"
    })).resolves.toMatchObject({
      bindingId: "binding-2",
      diagnostics: {
        fullFallbackUsed: true,
        retryCount: 0
      },
      reason: "memory_reranker_outcome_unknown",
      status: "UNAVAILABLE"
    });
    expect(canRetry).toHaveBeenCalledOnce();
    expect(harness.rerank).toHaveBeenCalledOnce();
    expect(harness.bind.mock.calls.map((call) => call[1].ordinal)).toEqual([2]);
  });

  it("cancels before dedicated provider I/O and returns full fallback evidence", async () => {
    const harness = dedicatedHarness(async () => {
      throw new Error("provider must not run");
    });
    const controller = new AbortController();
    controller.abort({ code: "memory_rerank_cancelled" });

    await expect(harness.service.rerank({
      ...baseInput(),
      candidates: dedicatedCandidates(3),
      profileRequested: false,
      query: "query",
      signal: controller.signal
    })).resolves.toMatchObject({
      bindingId: "binding-2",
      diagnostics: {
        failedBatchCount: 1,
        fullFallbackUsed: true,
        readyBatchCount: 0,
        retryCount: 0
      },
      reason: "memory_run_utility_cancelled",
      status: "UNAVAILABLE"
    });
    expect(harness.rerank).not.toHaveBeenCalled();
    expect(harness.settle).toHaveBeenCalledWith(
      "user-1",
      "binding-2",
      expect.objectContaining({ state: "CANCELLED" })
    );
  });

  it("stops after one fresh retry for replay-safe transient rerank responses", async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const harness = dedicatedHarness(async (request) => {
        if (++attempt <= 2) {
          throw new RerankAdapterError("rerank_provider_http_error", {
            httpStatus: 503
          });
        }
        return {
          model: "qwen/qwen3-reranker-8b",
          provider: "Together",
          requestId: "rerank-http-retry-success",
          scores: request.documents.map((document, index) => ({
            handle: document.handle,
            index,
            relevanceScore: 0.9 - index / 100
          })),
          usage: { inputTokens: 20, searchUnits: 1, totalTokens: 20 }
        };
      });

      const pending = harness.service.rerank({
        ...baseInput(),
        candidates: dedicatedCandidates(3),
        profileRequested: false,
        query: "query"
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result).toMatchObject({
        bindingId: "binding-3",
        externalCallCount: 2,
        reason: "memory_reranker_transient_http_failure",
        status: "UNAVAILABLE"
      });
      expect(harness.rerank).toHaveBeenCalledTimes(2);
      expect(harness.bind.mock.calls.map((call) => call[1].ordinal))
        .toEqual([2, 3]);
      expect(harness.executionService.lifecycle.settle).toHaveBeenNthCalledWith(
        1,
        "user-1",
        "binding-2",
        expect.objectContaining({
          errorCode: "memory_reranker_transient_http_failure",
          state: "FAILED"
        })
      );
      expect(harness.executionService.lifecycle.settle).toHaveBeenNthCalledWith(
        2,
        "user-1",
        "binding-3",
        expect.objectContaining({
          errorCode: "memory_reranker_transient_http_failure",
          state: "FAILED"
        })
      );
      expect(harness.provider.run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a permanent dedicated rerank HTTP response", async () => {
    const harness = dedicatedHarness(async () => {
      throw new RerankAdapterError("rerank_provider_http_error", {
        httpStatus: 400
      });
    });

    await expect(harness.service.rerank({
      ...baseInput(),
      candidates: dedicatedCandidates(60),
      profileRequested: false,
      query: "query"
    })).resolves.toMatchObject({
      bindingId: "binding-2",
      reason: "memory_reranker_failed",
      status: "UNAVAILABLE"
    });
    expect(harness.rerank).toHaveBeenCalledOnce();
    expect(harness.provider.run).not.toHaveBeenCalled();
    expect(harness.executionService.lifecycle.settle).toHaveBeenCalledWith(
      "user-1",
      "binding-2",
      expect.objectContaining({
        acceptedOutputHash: null,
        errorCode: "rerank_provider_http_error",
        state: "FAILED"
      })
    );
  });

  it.each([
    ["model", "rerank_response_model_mismatch"],
    ["provider", "rerank_response_provider_mismatch"]
  ] as const)("fails atomically without retry when the reranker response %s drifts", async (
    _identity,
    errorCode
  ) => {
    const harness = dedicatedHarness(async () => {
      throw new RerankAdapterError(errorCode);
    });

    await expect(harness.service.rerank({
      ...baseInput(),
      candidates: dedicatedCandidates(3),
      profileRequested: false,
      query: "query"
    })).resolves.toMatchObject({
      bindingId: "binding-2",
      diagnostics: {
        failedBatchCount: 1,
        fullFallbackUsed: true,
        providerModelMismatchCount: 1,
        readyBatchCount: 0,
        retryCount: 0
      },
      reason: "memory_run_utility_binding_changed",
      status: "UNAVAILABLE"
    });
    expect(harness.rerank).toHaveBeenCalledOnce();
  });

  it("splits the 180-candidate aggregation pool only at the dedicated envelope", async () => {
    const harness = dedicatedHarness(async (request) => ({
      model: "qwen/qwen3-reranker-8b",
      provider: "Together",
      requestId: `rerank-${request.documents[0]?.handle}`,
      scores: request.documents.map((document, index) => ({
        handle: document.handle,
        index,
        relevanceScore: 0.8
      })),
      usage: { inputTokens: 500, searchUnits: 1, totalTokens: 500 }
    }));
    const result = await harness.service.rerank({
      ...baseInput(),
      aggregationRequested: true,
      candidates: dedicatedCandidates(180),
      profileRequested: false,
      query: "Which milestones appeared across all chats?",
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "ANY"
    });

    expect(result.status === "READY" ? result.decisions : []).toHaveLength(180);
    expect(harness.rerank).toHaveBeenCalledTimes(2);
    expect(harness.rerank.mock.calls.map(([request]) => request.documents.length))
      .toEqual([96, 84]);
    expect(harness.bind).toHaveBeenCalledTimes(2);
    expect(harness.bind.mock.calls.map((call) =>
      call[1].ordinal)).toEqual([2, 2 + MEMORY_RERANK_MAX_ATTEMPTS]);
  });

  it("discards every ready batch when one dedicated batch fails", async () => {
    const harness = dedicatedHarness(async (request) => {
      if (request.documents[0]?.handle === "c96") {
        throw new RerankAdapterError("rerank_provider_http_error", {
          httpStatus: 400
        });
      }
      return {
        model: "qwen/qwen3-reranker-8b",
        provider: "Together",
        requestId: "rerank-first-batch",
        scores: request.documents.map((document, index) => ({
          handle: document.handle,
          index,
          relevanceScore: 0.8
        })),
        usage: { inputTokens: 500, searchUnits: 1, totalTokens: 500 }
      };
    });

    const result = await harness.service.rerank({
      ...baseInput(),
      aggregationRequested: true,
      candidates: dedicatedCandidates(180),
      profileRequested: false,
      query: "Which milestones appeared across all chats?",
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "ANY"
    });

    expect(result).toMatchObject({
      bindingId: "binding-4",
      diagnostics: {
        batchCount: 2,
        candidateCount: 180,
        coverageRatio: 96 / 180,
        decisionCount: 96,
        duplicateDecisionCount: 0,
        failedBatchCount: 1,
        fullFallbackUsed: true,
        invalidResponseCount: 0,
        missingDecisionCount: 84,
        providerModelMismatchCount: 0,
        readyBatchCount: 1,
        retryCount: 0
      },
      externalCallCount: 2,
      reason: "memory_reranker_failed",
      status: "UNAVAILABLE"
    });
    expect("decisions" in result).toBe(false);
    expect(harness.rerank).toHaveBeenCalledTimes(2);
  });

  it("discards complete batches when their governed snapshots differ", async () => {
    const harness = dedicatedHarness(async (request) => ({
      model: "qwen/qwen3-reranker-8b",
      provider: "Together",
      requestId: `rerank-${request.documents[0]?.handle}`,
      scores: request.documents.map((document, index) => ({
        handle: document.handle,
        index,
        relevanceScore: 0.8
      })),
      usage: { inputTokens: 500, searchUnits: 1, totalTokens: 500 }
    }));
    const changed = {
      ...harness.accepted,
      destinationFingerprint: "9".repeat(64)
    } as MemorySecretFreeExecutionSnapshot;
    harness.start.mockImplementation(async (
      _userId,
      bindingId
    ) => ({
      bindingId,
      snapshot: bindingId === "binding-4" ? changed : harness.accepted
    }));

    const result = await harness.service.rerank({
      ...baseInput(),
      aggregationRequested: true,
      candidates: dedicatedCandidates(180),
      profileRequested: false,
      query: "Which milestones appeared across all chats?",
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "ANY"
    });

    expect(result).toMatchObject({
      bindingId: "binding-2",
      diagnostics: {
        batchCount: 2,
        candidateCount: 180,
        coverageRatio: 1,
        decisionCount: 180,
        duplicateDecisionCount: 0,
        failedBatchCount: 0,
        fullFallbackUsed: true,
        invalidResponseCount: 0,
        missingDecisionCount: 0,
        providerModelMismatchCount: 1,
        readyBatchCount: 2,
        retryCount: 0
      },
      externalCallCount: 2,
      reason: "memory_run_utility_binding_changed",
      status: "UNAVAILABLE"
    });
    expect("decisions" in result).toBe(false);
    expect(harness.rerank).toHaveBeenCalledTimes(2);
  });

  it("rejects a dedicated path bound to an answer snapshot before either provider runs", async () => {
    const executionService = {
      admission: {
        bind: vi.fn(async () => ({ id: "binding-2" })),
        start: vi.fn(async () => ({
          bindingId: "binding-2",
          snapshot: snapshot("MEMORY_RERANK")
        }))
      },
      lifecycle: {
        settle: vi.fn(async () => ({})),
        withAuthorizedResultCommit: vi.fn()
      }
    } as unknown as PrismaMemoryExecutionService;
    const provider = { run: vi.fn() } as unknown as MemoryRunUtilityProvider;
    const rerankerRuntime = { resolve: vi.fn() };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: executionService,
      provider,
      rerankerRuntime: rerankerRuntime as never,
      resolveRerankPath: vi.fn(async () => "DEDICATED" as const)
    });

    await expect(service.rerank({
      ...baseInput(),
      candidates: dedicatedCandidates(1),
      profileRequested: false,
      query: "query"
    })).resolves.toMatchObject({
      bindingId: "binding-2",
      reason: "memory_reranker_binding_invalid",
      status: "UNAVAILABLE"
    });
    expect(rerankerRuntime.resolve).not.toHaveBeenCalled();
    expect(provider.run).not.toHaveBeenCalled();
  });
});
