import type { ProviderAdmissionRole } from "../../lib/server/providerRuntime/admission";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalCrossEncoderRerankerExecutor,
  KNOWLEDGE_RERANKER_RUNNER_PROTOCOL_VERSION,
  resolveSystemModelRerankerExecutor
} from "./rerankerRunners";

const passages = [
  { id: "passage-a", text: "A substantive synthetic passage for runner protocol verification." },
  { id: "passage-b", text: "Another substantive synthetic passage for runner protocol verification." }
];

function localConfig() {
  return {
    endpoint: "http://127.0.0.1:8765/rerank",
    hardware: "cpu" as const,
    modelId: "multilingual-cross-encoder-test",
    resources: {
      cpuLogicalCores: 4,
      gpuDevice: null
    },
    revision: "sha256-test-revision",
    timeoutMs: 1_000,
    version: KNOWLEDGE_RERANKER_RUNNER_PROTOCOL_VERSION
  };
}

function systemRole(): ProviderAdmissionRole {
  return {
    credentialSource: "default",
    modelConfiguration: {
      adapterKind: "openai_responses_compatible",
      capabilities: { structuredOutput: true },
      defaultParams: {},
      modelClass: "answer",
      upstreamModelId: "system-model-test"
    },
    snapshot: {
      connection: {
        apiRoot: "https://provider.invalid/v1",
        responseTimeoutMs: 30_000
      },
      connectionDisplayName: "System provider",
      connectionId: "connection-system",
      credentialId: "credential-system",
      credentialVersionId: "credential-system-v1",
      model: {
        adapterKind: "openai_responses_compatible",
        capabilities: { structuredOutput: true },
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: "system-model-test"
      },
      modelDisplayName: "System model",
      providerFamily: "compatible",
      providerModelId: "provider-model-system",
      version: 1
    }
  } as unknown as ProviderAdmissionRole;
}

describe("Knowledge reranker runtime adapters", () => {
  it("executes a bounded loopback-only local cross-encoder protocol", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        expectedIdentity: {
          modelId: string;
          resources: { cpuLogicalCores: number; gpuDevice: string | null };
          revision: string;
        };
        passages: typeof passages;
        query: string;
        version: string;
      };
      expect(request).toEqual({
        expectedIdentity: {
          modelId: "multilingual-cross-encoder-test",
          resources: { cpuLogicalCores: 4, gpuDevice: null },
          revision: "sha256-test-revision"
        },
        passages,
        query: "Which passage is relevant?",
        version: KNOWLEDGE_RERANKER_RUNNER_PROTOCOL_VERSION
      });
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({
        identity: {
          modelId: "multilingual-cross-encoder-test",
          resources: { cpuLogicalCores: 4, gpuDevice: null },
          revision: "sha256-test-revision"
        },
        scores: [
          { passageId: "passage-a", score: 0.9 },
          { passageId: "passage-b", score: 0.1 }
        ],
        usage: {
          costMicros: 0,
          inputTokens: 27,
          peakGpuMemoryBytes: null,
          peakRssBytes: 512_000_000
        },
        version: KNOWLEDGE_RERANKER_RUNNER_PROTOCOL_VERSION
      });
    });
    const executor = createLocalCrossEncoderRerankerExecutor(localConfig(), { fetchFn });
    expect(executor.identity.resources).toEqual({
      cpuLogicalCores: 4,
      gpuDevice: null,
      scope: "isolated_runner"
    });

    await expect(executor.rerank({ passages, query: "Which passage is relevant?" }))
      .resolves.toMatchObject({
        costMicros: 0,
        inputTokens: 27,
        resourceUsage: { peakGpuMemoryBytes: null, peakRssBytes: 512_000_000 },
        scores: [
          { passageId: "passage-a", score: 0.9 },
          { passageId: "passage-b", score: 0.1 }
        ]
      });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("rejects non-loopback local endpoints and incomplete score sets", async () => {
    expect(() => createLocalCrossEncoderRerankerExecutor({
      ...localConfig(),
      endpoint: "https://reranker.example/rerank"
    })).toThrow("knowledge_reranker_local_endpoint_invalid");
    expect(() => createLocalCrossEncoderRerankerExecutor({
      ...localConfig(),
      hardware: "gpu"
    })).toThrow("knowledge_reranker_local_resource_profile_invalid");

    const executor = createLocalCrossEncoderRerankerExecutor(localConfig(), {
      fetchFn: async () => Response.json({
        identity: {
          modelId: "multilingual-cross-encoder-test",
          resources: { cpuLogicalCores: 4, gpuDevice: null },
          revision: "sha256-test-revision"
        },
        scores: [{ passageId: "passage-a", score: 0.9 }],
        usage: {
          costMicros: 0,
          inputTokens: null,
          peakGpuMemoryBytes: null,
          peakRssBytes: 1
        },
        version: KNOWLEDGE_RERANKER_RUNNER_PROTOCOL_VERSION
      })
    });
    await expect(executor.rerank({ passages, query: "Which passage is relevant?" }))
      .rejects.toThrow("knowledge_reranker_local_runner_response_invalid");
  });

  it("returns typed System Model unavailability without a configured role", async () => {
    const executeStructuredOutput = vi.fn();
    const result = await resolveSystemModelRerankerExecutor({
      executeStructuredOutput,
      resolveSystemModel: async () => ({ code: "system_model_absent", ok: false })
    });

    expect(result).toEqual({
      reason: "system_model_not_authorized",
      status: "unavailable"
    });
    expect(executeStructuredOutput).not.toHaveBeenCalled();
  });

  it("adapts the admitted System Model through strict opaque-handle output", async () => {
    const role = systemRole();
    const executeStructuredOutput = vi.fn().mockImplementation(
      async (_role, request, options) => {
        expect(request.userPrompt).toContain('"handle":"p1"');
        expect(request.userPrompt).not.toContain("passage-a");
        expect(request.schema).toMatchObject({
          properties: { scores: { maxItems: 2, minItems: 2 } }
        });
        options.onUsage({
          estimatedCostMicros: 345,
          inputTokens: 123,
          outputTokens: 17,
          reasoningTokens: 0,
          totalTokens: 140
        });
        return {
          scores: [
            { handle: "p2", score: 0.25 },
            { handle: "p1", score: 0.75 }
          ]
        };
      }
    );
    const resolution = await resolveSystemModelRerankerExecutor({
      executeStructuredOutput,
      resolveSystemModel: async () => ({
        credentialScope: "installation",
        ok: true,
        policyVersion: 7,
        providerModelId: "provider-model-system",
        reasoningEffort: "low",
        role
      })
    });
    if (resolution.status !== "available") throw new Error("expected_available");

    expect(resolution.executor.identity).toMatchObject({
      authorization: "evaluation_only",
      egress: "external",
      hardware: "provider_managed",
      modelId: "system-model-test",
      resources: {
        cpuLogicalCores: null,
        gpuDevice: null,
        scope: "provider_managed"
      },
      revision: expect.stringMatching(/^installation-policy-7-model-[a-f0-9]{16}$/u)
    });
    await expect(resolution.executor.rerank({
      passages,
      query: "Which passage is relevant?"
    })).resolves.toEqual({
      costMicros: 345,
      inputTokens: 123,
      resourceUsage: null,
      scores: [
        { passageId: "passage-b", score: 0.25 },
        { passageId: "passage-a", score: 0.75 }
      ]
    });
  });

  it("keeps System Model cost evidence unavailable when the provider emits no usage", async () => {
    const resolution = await resolveSystemModelRerankerExecutor({
      executeStructuredOutput: async () => ({
        scores: [
          { handle: "p1", score: 0.75 },
          { handle: "p2", score: 0.25 }
        ]
      }),
      resolveSystemModel: async () => ({
        credentialScope: "installation",
        ok: true,
        policyVersion: 7,
        providerModelId: "provider-model-system",
        reasoningEffort: null,
        role: systemRole()
      })
    });
    if (resolution.status !== "available") throw new Error("expected_available");

    await expect(resolution.executor.rerank({
      passages,
      query: "Which passage is relevant?"
    })).resolves.toMatchObject({
      costMicros: null,
      inputTokens: null
    });
  });
});
