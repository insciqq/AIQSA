import { describe, expect, it, vi } from "vitest";
import type { MemorySecretFreeExecutionSnapshot } from "../execution";
import type { PrismaMemoryExecutionService } from "../execution";
import {
  createMemoryRunUtilityService,
  MEMORY_AGGREGATION_MAX_ATTEMPTS,
  MEMORY_AGGREGATION_MAX_EVIDENCE_ITEMS,
  MEMORY_QUERY_EMBEDDING_ATTEMPT_TIMEOUT_MS,
  MEMORY_RERANK_AGGREGATION_MAX_CANDIDATES,
  MEMORY_RERANK_AGGREGATION_MAX_BATCHES,
  MEMORY_RERANK_AGGREGATION_BATCH_SIZE,
  MEMORY_RERANK_MAX_ATTEMPTS,
  MEMORY_RERANK_TARGETED_MAX_CANDIDATES,
  type MemoryRunUtilityService
} from "./runUtilities";
import {
  memoryRunUtilityPromptCharacters,
  MemoryRunUtilityProviderCallError,
  MEMORY_AGGREGATION_TOOL_NAME,
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
  RerankAdapterError,
  type RerankRequest,
  type RerankResult
} from "../../providers/rerank";

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
  if ("kind" in input) throw new Error("unexpected_aggregation_input");
  return input;
}

function snapshot(
  role: "MEMORY_AGGREGATE" | "MEMORY_QUERY_EMBED" | "MEMORY_RERANK"
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
  const executionService = {
    admission: {
      bind,
      start: vi.fn(async (_userId: string, bindingId: string) => ({
        bindingId,
        snapshot: accepted
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
  const provider = { run: vi.fn() } as unknown as MemoryRunUtilityProvider;
  return {
    accepted,
    bind,
    executionService,
    provider,
    rerank,
    resolve,
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

  it("retries one transport-uncertain query embedding against the same snapshot", async () => {
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
    let attempt = 0;
    const vector = Array.from(
      { length: 1_024 },
      (_, index) => index === 0 ? 1 : 0
    );
    const embed = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new EmbeddingAdapterError("embedding_provider_request_failed");
      }
      return {
        model: "embedding-upstream-1",
        requestId: "embedding-response-retry",
        usage: { inputTokens: 7, totalTokens: 7 },
        vectors: [vector]
      };
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
      bindingId: "embedding-binding-2",
      externalCallCount: 2,
      status: "READY"
    });
    expect(result.status === "READY" ? result.vector : []).toEqual(vector);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(bind.mock.calls.map((call) => call[1].ordinal)).toEqual([1, 2]);
    expect(settle).toHaveBeenNthCalledWith(
      1,
      "user-1",
      "embedding-binding-1",
      expect.objectContaining({
        errorCode: "embedding_provider_request_failed",
        state: "OUTCOME_UNKNOWN"
      })
    );
    expect(settle).toHaveBeenNthCalledWith(
      2,
      "user-1",
      "embedding-binding-2",
      expect.objectContaining({ errorCode: null, state: "SUCCEEDED" })
    );
  });

  it("bounds a query-embedding attempt without consuming the role retry signal", async () => {
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
      const vector = Array.from(
        { length: 1_024 },
        (_, index) => index === 0 ? 1 : 0
      );
      const embed = vi.fn(async (request: { signal?: AbortSignal }) => {
        const signal = request.signal!;
        attemptSignals.push(signal);
        if (attemptSignals.length === 1) {
          return new Promise<never>((_resolve, reject) => {
            const rejectFromSignal = () => reject(signal.reason);
            if (signal.aborted) rejectFromSignal();
            else signal.addEventListener("abort", rejectFromSignal, { once: true });
          });
        }
        return {
          model: "embedding-upstream-1",
          requestId: "embedding-timeout-retry-success",
          usage: { inputTokens: 7, totalTokens: 7 },
          vectors: [vector]
        };
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
        bindingId: "embedding-binding-2",
        externalCallCount: 2,
        status: "READY"
      });
      expect(roleController.signal.aborted).toBe(false);
      expect(attemptSignals).toHaveLength(2);
      expect(attemptSignals[0]?.aborted).toBe(true);
      expect(attemptSignals[1]?.aborted).toBe(false);
      expect(bind.mock.calls.map((call) => call[1].ordinal)).toEqual([1, 2]);
      expect(settle).toHaveBeenNthCalledWith(
        1,
        "user-1",
        "embedding-binding-1",
        expect.objectContaining({
          errorCode: "memory_query_embedding_attempt_timed_out",
          state: "OUTCOME_UNKNOWN"
        })
      );
      expect(settle).toHaveBeenNthCalledWith(
        2,
        "user-1",
        "embedding-binding-2",
        expect.objectContaining({ errorCode: null, state: "SUCCEEDED" })
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

  it("retries one replay-safe transient query-embedding HTTP response", async () => {
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
    const vector = Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0);
    let attempt = 0;
    const embed = vi.fn(async () => {
      if (++attempt === 1) {
        throw new EmbeddingAdapterError("embedding_provider_http_error", {
          httpStatus: 503
        });
      }
      return {
        model: "embedding-upstream-1",
        requestId: "embedding-http-retry-success",
        usage: { inputTokens: 7, totalTokens: 7 },
        vectors: [vector]
      };
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
      bindingId: "embedding-binding-2",
      externalCallCount: 2,
      status: "READY"
    });
    expect(embed).toHaveBeenCalledTimes(2);
    expect(bind.mock.calls.map((call) => call[1].ordinal)).toEqual([1, 2]);
    expect(settle).toHaveBeenNthCalledWith(
      1,
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
    expect(result).toEqual({
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
  });

  it("globally groups grounded individual and aggregate quantities before a count", async () => {
    const log: string[] = [];
    const bound = execution(log);
    const provider: MemoryRunUtilityProvider = {
      run: vi.fn(async (
        _evidence: Parameters<MemoryRunUtilityProvider["run"]>[0],
        input: Parameters<MemoryRunUtilityProvider["run"]>[1]
      ) => {
        expect(input).toMatchObject({ kind: "AGGREGATE", role: "MEMORY_AGGREGATE" });
        expect("kind" in input ? input.evidence.map(({ handle }) => handle) : [])
          .toEqual(["i0", "i1", "i2", "i3"]);
        return {
          providerResponseId: "response-aggregation",
          toolCalls: [{
            arguments: {
              groups: [{
                item_handles: ["i0", "i1"],
                occurrence: "release Alpha",
                quantity: 1,
                quantity_evidence: "release Alpha",
                role: "MEMBER"
              }, {
                item_handles: ["i2"],
                occurrence: "two Beta releases",
                quantity: 2,
                quantity_evidence: "two Beta releases",
                role: "MEMBER"
              }, {
                item_handles: ["i3"],
                occurrence: "launch day",
                quantity: 0,
                quantity_evidence: null,
                role: "BOUNDARY"
              }],
              operation: "COUNT",
              resolution: "RESOLVED"
            },
            id: "call-aggregation",
            name: MEMORY_AGGREGATION_TOOL_NAME
          }],
          usage: {
            cachedInputTokens: 0,
            inputTokens: 80,
            outputTokens: 30,
            reasoningTokens: 0,
            totalTokens: 110
          }
        };
      })
    };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: bound.value,
      provider
    });

    const result = await service.aggregate({
      ...baseInput(),
      evidence: [{
        handle: "i0",
        occurredFrom: "2026-01-03T00:00:00.000Z",
        occurredTo: null,
        sourceKind: "HISTORY",
        text: "The user completed release Alpha."
      }, {
        handle: "i1",
        occurredFrom: "2026-01-04T00:00:00.000Z",
        occurredTo: null,
        sourceKind: "HISTORY",
        text: "A later chat also referenced release Alpha."
      }, {
        handle: "i2",
        occurredFrom: "2026-01-08T00:00:00.000Z",
        occurredTo: null,
        sourceKind: "HISTORY",
        text: "The user completed two Beta releases."
      }, {
        handle: "i3",
        occurredFrom: "2026-01-10T00:00:00.000Z",
        occurredTo: null,
        sourceKind: "HISTORY",
        text: "The user marked launch day."
      }],
      query: "How many releases were completed before launch day?"
    });

    expect(result).toEqual({
      bindingId: "binding-MEMORY_AGGREGATE",
      externalCallCount: 1,
      plan: {
        groups: [{
          itemHandles: ["i0", "i1"],
          occurrence: "release Alpha",
          quantity: 1,
          quantityEvidence: "release Alpha",
          role: "MEMBER"
        }, {
          itemHandles: ["i2"],
          occurrence: "two Beta releases",
          quantity: 2,
          quantityEvidence: "two Beta releases",
          role: "MEMBER"
        }, {
          itemHandles: ["i3"],
          occurrence: "launch day",
          quantity: 0,
          quantityEvidence: null,
          role: "BOUNDARY"
        }],
        operation: "COUNT",
        resolution: "RESOLVED"
      },
      status: "READY"
    });
    expect(bound.admission.bind).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ ordinal: 0, role: "MEMORY_AGGREGATE" })
    );
  });

  it("maps every oversized reader item and reduces the complete grounded set", async () => {
    const log: string[] = [];
    const bound = execution(log);
    const mappedHandles: string[] = [];
    const provider: MemoryRunUtilityProvider = {
      run: vi.fn(async (
        _evidence: Parameters<MemoryRunUtilityProvider["run"]>[0],
        input: Parameters<MemoryRunUtilityProvider["run"]>[1]
      ) => {
        if (!("kind" in input)) throw new Error("expected_aggregation_input");
        if (input.aggregationPhase === "REDUCE") {
          expect(input).toMatchObject({
            completeEvidenceView: true,
            kind: "AGGREGATE",
            role: "MEMORY_AGGREGATE"
          });
          expect(input.evidence.map(({ handle }) => handle)).toEqual(["g0", "g1"]);
          expect(input.evidence.every(({ text }) =>
            text.includes("mapped_status=APPLICABLE") &&
            !text.includes("mapped_resolution="))).toBe(true);
          return {
            providerResponseId: "response-reduced-aggregation",
            toolCalls: [{
              arguments: {
                groups: [{
                  item_handles: ["g0"],
                  occurrence: "release Alpha",
                  quantity: 1,
                  quantity_evidence: "release Alpha",
                  role: "MEMBER"
                }, {
                  item_handles: ["g1"],
                  occurrence: "release Beta",
                  quantity: 1,
                  quantity_evidence: "release Beta",
                  role: "MEMBER"
                }],
                operation: "COUNT",
                resolution: "RESOLVED"
              },
              id: "call-reduced-aggregation",
              name: MEMORY_AGGREGATION_TOOL_NAME
            }],
            usage: {
              cachedInputTokens: 0,
              inputTokens: 80,
              outputTokens: 30,
              reasoningTokens: 0,
              totalTokens: 110
            }
          };
        }
        expect(input).toMatchObject({
          completeEvidenceView: false,
          kind: "AGGREGATE",
          role: "MEMORY_AGGREGATE"
        });
        mappedHandles.push(...input.evidence.map(({ handle }) => handle));
        const matching = input.evidence.find(({ text }) => text.includes("release "));
        if (!matching) throw new Error("expected_matching_map_evidence");
        const occurrence = matching.text.includes("Alpha")
          ? "release Alpha"
          : "release Beta";
        return {
          providerResponseId: `response-map-${matching.handle}`,
          toolCalls: [{
            arguments: {
              groups: [{
                item_handles: [matching.handle],
                occurrence,
                quantity: 1,
                quantity_evidence: occurrence,
                role: "MEMBER"
              }],
              operation: "COUNT",
              resolution: "PARTIAL"
            },
            id: `call-map-${matching.handle}`,
            name: MEMORY_AGGREGATION_TOOL_NAME
          }],
          usage: {
            cachedInputTokens: 0,
            inputTokens: 80,
            outputTokens: 30,
            reasoningTokens: 0,
            totalTokens: 110
          }
        };
      })
    };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: bound.value,
      provider
    });

    const result = await service.aggregate({
      ...baseInput(),
      evidence: Array.from({ length: MEMORY_AGGREGATION_MAX_EVIDENCE_ITEMS + 1 },
        (_, index) => ({
          handle: `i${index}`,
          occurredFrom: null,
          occurredTo: null,
          sourceKind: "HISTORY" as const,
          text: index === 0
            ? "The user completed release Alpha."
            : index === MEMORY_AGGREGATION_MAX_EVIDENCE_ITEMS
              ? "The user completed release Beta."
            : `Unrelated bounded evidence ${index}.`
        })),
      query: "How many releases were completed?"
    });

    expect(mappedHandles.sort()).toEqual(Array.from(
      { length: MEMORY_AGGREGATION_MAX_EVIDENCE_ITEMS + 1 },
      (_, index) => `i${index}`
    ).sort());
    expect(result).toMatchObject({
      externalCallCount: 3,
      plan: {
        groups: [{ itemHandles: ["i0"] }, {
          itemHandles: [`i${MEMORY_AGGREGATION_MAX_EVIDENCE_ITEMS}`]
        }],
        operation: "COUNT",
        resolution: "RESOLVED"
      },
      status: "READY"
    });
    expect(bound.admission.bind.mock.calls.map((call) => call[1].ordinal).sort())
      .toEqual([0, 2, 4]);
  });

  it("never reports a resolved aggregate when one evidence shard is unavailable", async () => {
    const bound = execution([]);
    const provider: MemoryRunUtilityProvider = {
      run: vi.fn(async (
        _evidence: Parameters<MemoryRunUtilityProvider["run"]>[0],
        input: Parameters<MemoryRunUtilityProvider["run"]>[1]
      ) => {
        if (!("kind" in input) || input.aggregationPhase !== "MAP") {
          throw new Error("unexpected_aggregation_phase");
        }
        const matching = input.evidence.find(({ text }) => text.includes("release "));
        if (matching?.text.includes("Beta")) {
          throw new Error("injected_map_provider_failure");
        }
        return {
          providerResponseId: "response-map-alpha",
          toolCalls: [{
            arguments: {
              groups: [{
                item_handles: ["i0"],
                occurrence: "release Alpha",
                quantity: 1,
                quantity_evidence: "release Alpha",
                role: "MEMBER"
              }],
              operation: "COUNT",
              resolution: "PARTIAL"
            },
            id: "call-map-alpha",
            name: MEMORY_AGGREGATION_TOOL_NAME
          }],
          usage: {
            cachedInputTokens: 0,
            inputTokens: 40,
            outputTokens: 20,
            reasoningTokens: 0,
            totalTokens: 60
          }
        };
      })
    };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: bound.value,
      provider
    });

    const result = await service.aggregate({
      ...baseInput(),
      evidence: Array.from({ length: MEMORY_AGGREGATION_MAX_EVIDENCE_ITEMS + 1 },
        (_, index) => ({
          handle: `i${index}`,
          occurredFrom: null,
          occurredTo: null,
          sourceKind: "HISTORY" as const,
          text: index === 0
            ? "The user completed release Alpha."
            : index === MEMORY_AGGREGATION_MAX_EVIDENCE_ITEMS
              ? "The user completed release Beta."
              : `Unrelated bounded evidence ${index}.`
        })),
      query: "How many releases were completed?"
    });

    expect(result).toEqual(expect.objectContaining({
      externalCallCount: 3,
      reason: "memory_run_utility_provider_failed",
      status: "UNAVAILABLE"
    }));
    expect(provider.run).toHaveBeenCalledTimes(3);
  });

  it("rejects a quantity that conflicts with its exact evidence and retries only that output", async () => {
    const executionService = {
      admission: {
        bind: vi.fn(async (_userId: string, input: { ordinal: number }) => ({
          id: `binding-${input.ordinal}`
        })),
        start: vi.fn(async (_userId: string, bindingId: string) => ({
          bindingId,
          snapshot: snapshot("MEMORY_AGGREGATE")
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
    const provider: MemoryRunUtilityProvider = {
      run: vi.fn(async () => ({
        providerResponseId: "response-invalid",
        toolCalls: [{
          arguments: {
            groups: [{
              item_handles: ["i0"],
              occurrence: "12 completed releases",
              quantity: 7,
              quantity_evidence: "12 completed releases",
              role: "MEMBER"
            }],
            operation: "COUNT",
            resolution: "RESOLVED"
          },
          id: "call-invalid",
          name: MEMORY_AGGREGATION_TOOL_NAME
        }],
        usage: {
          cachedInputTokens: 0,
          inputTokens: 20,
          outputTokens: 10,
          reasoningTokens: 0,
          totalTokens: 30
        }
      }))
    };
    const service = createMemoryRunUtilityService({
      embeddingRuntime: { resolve: vi.fn() } as never,
      execution: executionService,
      provider
    });

    const result = await service.aggregate({
      ...baseInput(),
      evidence: [{
        handle: "i0",
        occurredFrom: null,
        occurredTo: null,
        sourceKind: "HISTORY",
        text: "The user reported 12 completed releases."
      }],
      query: "How many releases were completed?"
    });

    expect(result).toMatchObject({
      reason: "memory_run_utility_output_invalid",
      status: "UNAVAILABLE"
    });
    expect(provider.run).toHaveBeenCalledTimes(MEMORY_AGGREGATION_MAX_ATTEMPTS);
    expect(executionService.admission.bind).toHaveBeenNthCalledWith(
      1,
      "user-1",
      expect.objectContaining({ ordinal: 0, role: "MEMORY_AGGREGATE" })
    );
    expect(executionService.admission.bind).toHaveBeenNthCalledWith(
      2,
      "user-1",
      expect.objectContaining({ ordinal: 1, role: "MEMORY_AGGREGATE" })
    );
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
    expect(peak).toBe(3);
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

  it("accepts valid broad-profile scores beside malformed entries for RRF fallback", async () => {
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
      decisions: [
        expect.objectContaining({ handle: "c0", relevanceScore: 0.95 })
      ],
      status: "READY"
    });
    expect(provider.run).toHaveBeenCalledOnce();
    expect(bound.lifecycle.settle).toHaveBeenCalledWith(
      "user-1",
      expect.any(String),
      expect.objectContaining({ errorCode: null, state: "SUCCEEDED" })
    );
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
    })).resolves.toEqual({
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
    })).resolves.toEqual({
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
    })).resolves.toEqual({
      reason: "memory_utility_input_blocked",
      status: "UNAVAILABLE"
    });
    expect(bound.admission.bind).not.toHaveBeenCalled();
    expect(provider.run).not.toHaveBeenCalled();
  });

  it("retries one invalid reranker result once, records both attempts, then fails closed", async () => {
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
          toolCalls: [],
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
      }],
      profileRequested: false,
      query: "How should I respond?"
    })).resolves.toEqual({
      bindingId: "binding-3",
      externalCallCount: 2,
      reason: "memory_run_utility_output_invalid",
      status: "UNAVAILABLE"
    });
    expect(MEMORY_RERANK_MAX_ATTEMPTS).toBe(3);
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
    })).resolves.toEqual({
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
      })).resolves.toEqual({
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

  it("preserves dedicated partial scores without inventing authority metadata", async () => {
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
    })).resolves.toEqual({
      bindingId: "binding-2",
      decisions: [{
        applicable: null,
        current: null,
        handle: "c2",
        reasonCode: "SCORE_ONLY",
        relevanceScore: 0.92
      }, {
        applicable: null,
        current: null,
        handle: "c0",
        reasonCode: "SCORE_ONLY",
        relevanceScore: 0.41
      }],
      status: "READY"
    });
    expect(harness.executionService.lifecycle.settle).toHaveBeenCalledWith(
      "user-1",
      "binding-2",
      expect.objectContaining({
        usage: expect.objectContaining({ completeness: "UNAVAILABLE" })
      })
    );
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

  it("backs off through two replay-safe transient rerank responses", async () => {
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
        bindingId: "binding-4",
        externalCallCount: 3,
        status: "READY"
      });
      expect(harness.rerank).toHaveBeenCalledTimes(3);
      expect(harness.bind.mock.calls.map((call) => call[1].ordinal))
        .toEqual([2, 3, 4]);
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
      expect(harness.executionService.lifecycle.settle).toHaveBeenNthCalledWith(
        3,
        "user-1",
        "binding-4",
        expect.objectContaining({ errorCode: null, state: "SUCCEEDED" })
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
    })).resolves.toEqual({
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
    })).resolves.toEqual({
      bindingId: "binding-2",
      reason: "memory_reranker_binding_invalid",
      status: "UNAVAILABLE"
    });
    expect(rerankerRuntime.resolve).not.toHaveBeenCalled();
    expect(provider.run).not.toHaveBeenCalled();
  });
});
