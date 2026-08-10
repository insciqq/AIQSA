import { describe, expect, it, vi } from "vitest";
import type { MemorySecretFreeExecutionSnapshot } from "../execution";
import type { PrismaMemoryExecutionService } from "../execution";
import {
  createMemoryRunUtilityService,
  type MemoryRunUtilityService
} from "./runUtilities";
import {
  MemoryRunUtilityProviderCallError,
  MEMORY_QUERY_EXPANSION_TOOL_NAME,
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
  providerModelId: "embedding-model-1",
  retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  vectorSpaceFingerprint: "b".repeat(64)
});

function snapshot(
  role: "MEMORY_QUERY_EMBED" | "MEMORY_QUERY_EXPAND" | "MEMORY_RERANK"
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
    qualificationId: "qualification-1",
    qualificationRequirement: {
      configFingerprint: embedding ? profile.configurationFingerprint : "f".repeat(64),
      corpusHash: "1".repeat(64),
      corpusVersion: "corpus-v1",
      deploymentFingerprint: "2".repeat(64),
      language: "EN",
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
      scorerVersion: "scorer-v1",
      suiteVersion: "suite-v1",
      vectorSpaceFingerprint: embedding ? profile.vectorSpaceFingerprint : null
    },
    requiresStrictStructuredOutput: false,
    schemaVersion: 1,
    utilityPolicyVersion: "memory-utility-egress-v1"
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
    bind: vi.fn(async (_userId: string, input: { role: Parameters<typeof snapshot>[0] }) => {
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
    signal: new AbortController().signal,
    userId: "user-1"
  };
}

describe("Memory run utility execution", () => {
  it("binds and starts before a query embedding call, then settles usage once", async () => {
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
  });

  it("accepts only bounded structured expansion output after durable binding", async () => {
    const log: string[] = [];
    const bound = execution(log);
    const provider: MemoryRunUtilityProvider = {
      run: vi.fn(async () => {
        log.push("provider");
        return {
          providerResponseId: "response-1",
          toolCalls: [{
            arguments: { terms: ["postgres migration", "schema change"] },
            id: "call-1",
            name: MEMORY_QUERY_EXPANSION_TOOL_NAME
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
    const result = await service.expandQuery({
      ...baseInput(),
      intent: "PAST_HISTORY",
      language: "EN",
      query: "what did we discuss last time"
    });
    expect(result).toEqual({
      bindingId: "binding-MEMORY_QUERY_EXPAND",
      status: "READY",
      terms: ["postgres migration", "schema change"]
    });
    expect(log).toEqual([
      "bind:MEMORY_QUERY_EXPAND",
      "start",
      "provider",
      "settle",
      "authorize"
    ]);
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
    const uncertain = await service.expandQuery({
      ...baseInput(),
      intent: "PAST_HISTORY",
      language: "EN",
      query: "what did we discuss last time"
    });
    expect(uncertain).toMatchObject({
      bindingId: "binding-MEMORY_QUERY_EXPAND",
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
        handle: "c0",
        text: "API key sk-abcdefghijklmnopqrstuvwxyz123456"
      }],
      intent: "PAST_HISTORY",
      language: "EN",
      query: "previous chat"
    });
    expect(blocked).toEqual({
      reason: "memory_utility_input_blocked",
      status: "UNAVAILABLE"
    });
    expect(provider.run).toHaveBeenCalledOnce();
  });
});
