import { describe, expect, it, vi } from "vitest";
import type { MemorySecretFreeExecutionSnapshot } from "../execution";
import type { PrismaMemoryExecutionService } from "../execution";
import {
  createMemoryRunUtilityService,
  MEMORY_AGGREGATION_MAX_ATTEMPTS,
  MEMORY_RERANK_AGGREGATION_MAX_BATCHES,
  MEMORY_RERANK_AGGREGATION_BATCH_SIZE,
  MEMORY_RERANK_MAX_ATTEMPTS,
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
    utilityPolicyVersion: "memory-utility-egress-v1",
    version: 2
  } as unknown as MemorySecretFreeExecutionSnapshot;
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
      input: { inputHash: string; role: Parameters<typeof snapshot>[0] }
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

describe("Memory run utility execution", () => {
  it.each([
    { ordinal: 1, purpose: "RETRIEVAL" as const },
    { ordinal: 3, purpose: "ACTION_TARGET" as const }
  ])("binds ordinal $ordinal before a $purpose embedding and settles usage once", async ({
    ordinal,
    purpose
  }) => {
    const log: string[] = [];
    const bound = execution(log);
    const embeddingRuntime = {
      resolve: vi.fn(async () => ({
        adapter: {
          embed: vi.fn(async () => {
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
          })
        }
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
      query: "what did we discuss about postgres"
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
        expect(input).toMatchObject({ kind: "AGGREGATE", role: "MEMORY_RERANK" });
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
      bindingId: "binding-MEMORY_RERANK",
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
      expect.objectContaining({ ordinal: 8, role: "MEMORY_RERANK" })
    );
  });

  it("rejects a quantity that conflicts with its exact evidence and retries only that output", async () => {
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
      expect.objectContaining({ ordinal: 8 })
    );
    expect(executionService.admission.bind).toHaveBeenNthCalledWith(
      2,
      "user-1",
      expect.objectContaining({ ordinal: 9 })
    );
  });

  it("reranks a broad history aggregation in three concurrent governed batches", async () => {
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
    const candidates = Array.from({ length: 60 }, (_, index) => ({
      ...currentHistoryRerankCandidate,
      authorityLevel: "PAST_CHAT" as const,
      current: true,
      handle: `c${index}`,
      occurredFrom: null,
      occurredTo: null,
      sensitivityClass: "NORMAL" as const,
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
    expect(providerRun).toHaveBeenCalledTimes(3);
    expect(providerRun.mock.calls.map((call) => rerankInput(call[1]).candidates.length))
      .toEqual([
        MEMORY_RERANK_AGGREGATION_BATCH_SIZE,
        MEMORY_RERANK_AGGREGATION_BATCH_SIZE,
        MEMORY_RERANK_AGGREGATION_BATCH_SIZE
      ]);
    expect(bind).toHaveBeenCalledTimes(3);
    expect(bind.mock.calls.map((call) => call[1].ordinal))
      .toEqual([2, 4, 6]);
    expect(peak).toBe(3);
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
      .toEqual(promptSizes.map((_, index) => {
        const denseOrdinal = 2 + index * MEMORY_RERANK_MAX_ATTEMPTS;
        return denseOrdinal >= 8
          ? denseOrdinal + MEMORY_AGGREGATION_MAX_ATTEMPTS
          : denseOrdinal;
      }));
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

  it("rejects a broad-profile result that drops a supplied current fact", async () => {
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
              relevance_score: 0.2
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
        sourceKind: "FACT",
        text: "The user lives in Rostov."
      }],
      profileRequested: true,
      retrievalMode: "CURRENT_PROFILE",
      query: "What do you know about me?"
    })).resolves.toMatchObject({
      reason: "memory_run_utility_output_invalid",
      status: "UNAVAILABLE"
    });
    expect(provider.run).toHaveBeenCalledTimes(MEMORY_RERANK_MAX_ATTEMPTS);
    expect(bound.lifecycle.settle).toHaveBeenCalledTimes(MEMORY_RERANK_MAX_ATTEMPTS);
    for (const call of bound.lifecycle.settle.mock.calls) {
      expect(call[2]).toMatchObject({
        errorCode: "memory_run_utility_output_invalid",
        state: "FAILED"
      });
    }
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
        sourceKind: "HISTORY",
        text: "We discussed PostgreSQL migrations."
      }],
      profileRequested: false,
      query: "what did we discuss last time"
    });
    expect(uncertain).toMatchObject({
      bindingId: "binding-MEMORY_RERANK",
      reason: "memory_run_utility_outcome_unknown",
      status: "UNAVAILABLE"
    });
    expect(bound.lifecycle.settle.mock.calls[0]?.[2]).toMatchObject({
      state: "OUTCOME_UNKNOWN",
      usage: { completeness: "UNAVAILABLE" }
    });

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
    expect(provider.run).toHaveBeenCalledOnce();
  });

  it("blocks a thirty-first rerank candidate before binding or provider I/O", async () => {
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
      candidates: Array.from({ length: 31 }, (_, index) => ({
        ...currentFactRerankCandidate,
        authorityLevel: "SAVED" as const,
        current: true,
        handle: `c${index}`,
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL" as const,
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

  it("blocks a sixty-first aggregation candidate before binding or provider I/O", async () => {
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
      candidates: Array.from({ length: 61 }, (_, index) => ({
        ...currentHistoryRerankCandidate,
        authorityLevel: "PAST_CHAT" as const,
        current: true,
        handle: `c${index}`,
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL" as const,
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
        sourceKind: "FACT",
        text: "The user prefers concise replies."
      }],
      profileRequested: false,
      query: "How should I respond?"
    })).resolves.toEqual({
      bindingId: "binding-3",
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
                    handle: "c0",
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
    "rejects contradictory %s rerank flags and exhausts only the one safe retry",
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
          sourceKind: "FACT",
          text: "The user prefers concise replies."
        }],
        profileRequested: false,
        query: "How should I respond?"
      })).resolves.toEqual({
        bindingId: "binding-3",
        reason: "memory_run_utility_output_invalid",
        status: "UNAVAILABLE"
      });
      expect(provider.run).toHaveBeenCalledTimes(2);
      expect(executionService.lifecycle.settle).toHaveBeenCalledTimes(2);
      expect(executionService.lifecycle.settle).toHaveBeenNthCalledWith(
        1,
        "user-1",
        "binding-2",
        expect.objectContaining({ state: "FAILED" })
      );
      expect(executionService.lifecycle.settle).toHaveBeenNthCalledWith(
        2,
        "user-1",
        "binding-3",
        expect.objectContaining({ state: "FAILED" })
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
});
