import { createHash } from "node:crypto";
import type { ProviderAdmissionRole } from "../../lib/server/providerRuntime/admission";
import { describe, expect, it, vi } from "vitest";
import {
  createKnowledgeSemanticGroundingCandidatePool,
  knowledgeSemanticCandidateImplementationForDigest
} from "./semanticGroundingCandidates";
import {
  createLocalSemanticGroundingExecutor,
  KNOWLEDGE_SEMANTIC_LOCAL_RUNNER_PROTOCOL_VERSION,
  KNOWLEDGE_SEMANTIC_SYSTEM_PROMPT,
  KNOWLEDGE_SEMANTIC_SYSTEM_RUNNER_PROTOCOL_VERSION,
  resolveSystemModelSemanticGroundingExecutor
} from "./semanticGroundingRunners";

function localConfig() {
  return {
    endpoint: "http://127.0.0.1:8766/validate",
    hardware: "cpu" as const,
    modelId: "multilingual-nli-test",
    profile: "multilingual-nli-test-v1",
    resources: { cpuLogicalCores: 4, gpuDevice: null },
    revision: "sha256-test-revision",
    timeoutMs: 1_000,
    validatorVersion: 1,
    version: KNOWLEDGE_SEMANTIC_LOCAL_RUNNER_PROTOCOL_VERSION
  };
}

function systemRole(): ProviderAdmissionRole {
  return {
    credentialSource: "default",
    modelConfiguration: {
      adapterKind: "openai_responses_compatible",
      capabilities: {
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        structuredOutput: true,
        vision: false
      },
      defaultParams: {},
      modelClass: "answer",
      upstreamModelId: "system-semantic-test"
    },
    snapshot: {
      connection: { apiRoot: "https://provider.invalid/v1", responseTimeoutMs: 30_000 },
      connectionDisplayName: "System provider",
      connectionId: "connection-system",
      credentialId: "credential-system",
      credentialVersionId: "credential-system-v1",
      model: {
        adapterKind: "openai_responses_compatible",
        capabilities: {
          nativePdfInput: false,
          nativeSearch: false,
          pdf: false,
          reasoning: false,
          structuredOutput: true,
          vision: false
        },
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: "system-semantic-test"
      },
      modelDisplayName: "System model",
      providerFamily: "compatible",
      providerModelId: "provider-model-system",
      version: 1
    }
  } as unknown as ProviderAdmissionRole;
}

function oneEvidenceCandidateInput() {
  const entry = createKnowledgeSemanticGroundingCandidatePool().entries.find((candidate) =>
    candidate.input.evidence.length === 1 &&
    candidate.input.scopeEvidence.readiness.readySources === 1);
  if (!entry) throw new Error("one_evidence_candidate_missing");
  return entry.input;
}

describe("Knowledge semantic candidate runners", () => {
  it("executes the bounded loopback-only local protocol without credentials", async () => {
    const candidateInput = oneEvidenceCandidateInput();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        claim: { text: string };
        evidence: readonly { handle: string; text: string }[];
        expectedIdentity: { modelId: string; profile: string; validatorVersion: number };
        language: string;
        scopeEvidence: { coverage: { mode: string }; readiness: { readySources: number } };
        version: string;
      };
      expect(request.claim).not.toHaveProperty("ordinal");
      expect(request.evidence.map((entry) => entry.handle)).toEqual(["e1"]);
      expect(request.expectedIdentity).toMatchObject({
        modelId: "multilingual-nli-test",
        profile: "multilingual-nli-test-v1",
        validatorVersion: 1
      });
      expect(request.scopeEvidence).toMatchObject({
        coverage: { mode: "partial" },
        readiness: { readySources: 1 }
      });
      expect(request.language).toMatch(/^(?:en|ru)$/u);
      expect(request.version).toBe(KNOWLEDGE_SEMANTIC_LOCAL_RUNNER_PROTOCOL_VERSION);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.redirect).toBe("error");
      return Response.json({
        attributableEvidenceHandles: ["e1"],
        decisionScores: {
          contradicted: 0.02,
          supported: 0.94,
          uncertain: 0.03,
          unsupported: 0.01
        },
        identity: {
          modelId: "multilingual-nli-test",
          profile: "multilingual-nli-test-v1",
          resources: { cpuLogicalCores: 4, gpuDevice: null },
          revision: "sha256-test-revision",
          validatorVersion: 1
        },
        reasonFamily: "entailed",
        usage: {
          costMicros: 0,
          inputTokens: 80,
          peakGpuMemoryBytes: null,
          peakRssBytes: 300_000_000
        },
        version: KNOWLEDGE_SEMANTIC_LOCAL_RUNNER_PROTOCOL_VERSION
      });
    });
    const executor = createLocalSemanticGroundingExecutor(localConfig(), { fetchFn });
    const implementation = knowledgeSemanticCandidateImplementationForDigest(executor);

    expect(implementation).toMatchObject({
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      executorImplementationSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      inputProjectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      protocolSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      responseSchemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      supportingImplementationSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      version: "knowledge-semantic-executor-contract-v1"
    });
    const timeoutDrift = createLocalSemanticGroundingExecutor({
      ...localConfig(),
      timeoutMs: 2_000
    }, { fetchFn });
    const driftBinding = knowledgeSemanticCandidateImplementationForDigest(timeoutDrift);
    expect(driftBinding.protocolSha256).not.toBe(implementation.protocolSha256);
    expect(driftBinding.promptSha256).toBe(implementation.promptSha256);
    expect(driftBinding.responseSchemaSha256).toBe(implementation.responseSchemaSha256);

    await expect(executor.validate(candidateInput)).resolves.toMatchObject({
      attributableHandles: ["K1"],
      costMicros: 0,
      decisionScores: { supported: 0.94 },
      inputTokens: 80,
      resourceUsage: { peakGpuMemoryBytes: null, peakRssBytes: 300_000_000 }
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("rejects non-loopback endpoints, resource mismatches, and foreign handles", async () => {
    expect(() => createLocalSemanticGroundingExecutor({
      ...localConfig(),
      endpoint: "https://nli.example/validate"
    })).toThrow("knowledge_semantic_local_endpoint_invalid");
    expect(() => createLocalSemanticGroundingExecutor({
      ...localConfig(),
      hardware: "gpu"
    })).toThrow("knowledge_semantic_local_resource_profile_invalid");

    const executor = createLocalSemanticGroundingExecutor(localConfig(), {
      fetchFn: async () => Response.json({
        attributableEvidenceHandles: ["e2"],
        decisionScores: {
          contradicted: 0,
          supported: 1,
          uncertain: 0,
          unsupported: 0
        },
        identity: {
          modelId: "multilingual-nli-test",
          profile: "multilingual-nli-test-v1",
          resources: { cpuLogicalCores: 4, gpuDevice: null },
          revision: "sha256-test-revision",
          validatorVersion: 1
        },
        reasonFamily: "entailed",
        usage: {
          costMicros: 0,
          inputTokens: null,
          peakGpuMemoryBytes: null,
          peakRssBytes: 1
        },
        version: KNOWLEDGE_SEMANTIC_LOCAL_RUNNER_PROTOCOL_VERSION
      })
    });
    await expect(executor.validate(
      oneEvidenceCandidateInput()
    )).rejects.toThrow("knowledge_semantic_runner_response_invalid");
  });

  it("returns typed System Model unavailability without exact admitted capability", async () => {
    const executeStructuredOutput = vi.fn();
    const absent = await resolveSystemModelSemanticGroundingExecutor({
      executeStructuredOutput,
      resolveSystemModel: async () => ({ code: "system_model_absent", ok: false })
    });
    expect(absent).toEqual({ reason: "system_model_not_authorized", status: "unavailable" });
    expect(executeStructuredOutput).not.toHaveBeenCalled();

    const role = systemRole();
    const unsupported = await resolveSystemModelSemanticGroundingExecutor({
      executeStructuredOutput,
      resolveSystemModel: async () => ({
        credentialScope: "installation",
        ok: true,
        policyVersion: 1,
        providerModelId: "provider-model-system",
        reasoningEffort: null,
        role: {
          ...role,
          modelConfiguration: {
            ...role.modelConfiguration,
            capabilities: {
              ...role.modelConfiguration.capabilities,
              structuredOutput: false
            }
          }
        }
      })
    });
    expect(unsupported).toEqual({
      reason: "system_model_structured_output_unavailable",
      status: "unavailable"
    });
  });

  it("adapts the exact System Model through strict opaque-handle output", async () => {
    const executeStructuredOutput = vi.fn().mockImplementation(
      async (_role, request, options) => {
        expect(request.name).toBe("knowledge_semantic_grounding_v1");
        expect(request.userPrompt).toContain('"handle":"e1"');
        expect(request.schema).toMatchObject({
          properties: {
            decisionScores: {
              required: ["contradicted", "supported", "uncertain", "unsupported"]
            }
          }
        });
        options.onUsage({
          estimatedCostMicros: 250,
          inputTokens: 120,
          outputTokens: 20,
          reasoningTokens: 0,
          totalTokens: 140
        });
        return {
          attributableEvidenceHandles: ["e1"],
          decisionScores: {
            contradicted: 0.01,
            supported: 0.96,
            uncertain: 0.02,
            unsupported: 0.01
          },
          reasonFamily: "entailed"
        };
      }
    );
    const resolution = await resolveSystemModelSemanticGroundingExecutor({
      executeStructuredOutput,
      resolveSystemModel: async () => ({
        credentialScope: "installation",
        ok: true,
        policyVersion: 7,
        providerModelId: "provider-model-system",
        reasoningEffort: "low",
        role: systemRole()
      })
    });
    if (resolution.status !== "available") throw new Error("expected_available");

    expect(resolution.executor.identity).toMatchObject({
      authorization: "evaluation_only",
      egress: "external",
      hardware: "provider_managed",
      profile: "system-model-semantic-v1",
      revision: expect.stringMatching(/^installation-policy-7-model-[a-f0-9]{16}$/u)
    });
    const implementation = knowledgeSemanticCandidateImplementationForDigest(
      resolution.executor
    );
    const localImplementation = knowledgeSemanticCandidateImplementationForDigest(
      createLocalSemanticGroundingExecutor(localConfig())
    );
    expect(KNOWLEDGE_SEMANTIC_SYSTEM_PROMPT).toContain("opaque evidence handles");
    expect(KNOWLEDGE_SEMANTIC_SYSTEM_RUNNER_PROTOCOL_VERSION)
      .toBe("knowledge-semantic-system-runner-v1");
    expect(implementation.promptSha256).toBe(createHash("sha256").update(JSON.stringify({
      systemPrompt: KNOWLEDGE_SEMANTIC_SYSTEM_PROMPT
    }), "utf8").digest("hex"));
    expect(implementation.promptSha256).not.toBe(localImplementation.promptSha256);
    expect(implementation.protocolSha256).not.toBe(localImplementation.protocolSha256);
    expect(implementation.responseSchemaSha256).not.toBe(
      localImplementation.responseSchemaSha256
    );
    await expect(resolution.executor.validate(
      createKnowledgeSemanticGroundingCandidatePool().entries[0]!.input
    )).resolves.toMatchObject({
      attributableHandles: ["K1"],
      costMicros: 250,
      inputTokens: 120,
      resourceUsage: null
    });
  });
});
