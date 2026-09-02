import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { applySystemModelReasoningEffort } from "../../providerRuntime/systemModelRole";
import type {
  ProviderAdmissionRole,
  RerankerProviderAdmissionRole
} from "../../providerRuntime/admission";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import type { ProviderModelConfiguration } from "../../providers/providerConfiguration";
import {
  memoryProviderSnapshotVectorSpaceFingerprint,
  memoryVectorSpaceFingerprint,
  requireMemoryPolicyTarget,
  resolveCurrentMemoryUtilityPolicy,
  type ResolvedMemoryExecutionTarget
} from "./policy";

function snapshot(defaultParams: Record<string, unknown>): ProviderExecutionSnapshot {
  return {
    model: { defaultParams }
  } as unknown as ProviderExecutionSnapshot;
}

describe("Memory system-model execution policy", () => {
  it("adds the selected reasoning effort without mutating the admitted snapshot", () => {
    const admitted = snapshot({
      reasoning: { summary: "auto" },
      temperature: 0.2
    });

    const execution = applySystemModelReasoningEffort(admitted, "xhigh");

    expect(execution).not.toBe(admitted);
    expect(execution.model.defaultParams).toEqual({
      reasoning: { effort: "xhigh", summary: "auto" },
      temperature: 0.2
    });
    expect(admitted.model.defaultParams).toEqual({
      reasoning: { summary: "auto" },
      temperature: 0.2
    });
  });

  it("preserves the exact admitted snapshot for provider-default reasoning", () => {
    const admitted = snapshot({ temperature: 0.2 });
    expect(applySystemModelReasoningEffort(admitted, null)).toBe(admitted);
  });
});

describe("Memory embedding vector-space identity", () => {
  const model: ProviderModelConfiguration = {
    adapterKind: "openai_embeddings_compatible",
    answerSelectable: false,
    capabilities: {
      contextWindow: 32_768,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      toolCalling: false,
      vision: false
    },
    defaultParams: {},
    embedding: {
      nativeDimension: 4_096,
      providerFamily: "openrouter",
      queryInstructionTemplate: "Query: {text}",
      supportsMrl: true,
      targetDimension: 1_536
    },
    modelClass: "embedding",
    openRouterRouting: {
      mode: "only_selected",
      providers: ["nebius", "deepinfra"]
    },
    upstreamModelId: "qwen/qwen3-embedding-8b"
  };
  const target = (
    overrides: Partial<ProviderModelConfiguration> = {}
  ) => ({
    snapshot: {
      model: { ...model, ...overrides },
      providerModelId: "qwen-embedding-deployment"
    }
  }) as ResolvedMemoryExecutionTarget;

  it("does not require vector regeneration when only OpenRouter routing changes", () => {
    expect(memoryVectorSpaceFingerprint(target())).toBe(
      memoryVectorSpaceFingerprint(target({
        openRouterRouting: {
          mode: "only_selected",
          providers: ["deepinfra", "nebius"]
        }
      }))
    );
  });

  it("keeps provider query transforms outside the stored document-vector identity", () => {
    expect(memoryVectorSpaceFingerprint(target())).toBe(
      memoryVectorSpaceFingerprint(target({
        embedding: {
          ...model.embedding!,
          queryInstructionTemplate: "Instruct: New query policy\nQuery: {text}"
        }
      }))
    );
  });

  it("changes identity when the model or document-vector shape changes", () => {
    const original = memoryVectorSpaceFingerprint(target());
    expect(memoryVectorSpaceFingerprint(target({
      upstreamModelId: "qwen/qwen3-embedding-4b"
    }))).not.toBe(original);
    expect(memoryVectorSpaceFingerprint(target({
      embedding: { ...model.embedding!, targetDimension: 1_024 }
    }))).not.toBe(original);
  });

  it("can canonicalize an immutable historical provider snapshot", () => {
    const current = target().snapshot;
    expect(memoryProviderSnapshotVectorSpaceFingerprint(current)).toBe(
      memoryVectorSpaceFingerprint(target())
    );
  });
});

function executionSnapshot(modelClass: "answer" | "reranker"): ProviderExecutionSnapshot {
  const reranker = modelClass === "reranker";
  return {
    connection: {
      allowPrivateNetwork: false,
      apiRoot: reranker
        ? "https://openrouter.ai/api/v1"
        : "https://answer.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: 30_000
    },
    connectionDisplayName: reranker ? "OpenRouter" : "Answer provider",
    connectionId: reranker ? "reranker-connection" : "answer-connection",
    credentialId: reranker ? "reranker-credential" : "answer-credential",
    credentialVersionId: reranker
      ? "reranker-credential-version"
      : "answer-credential-version",
    model: reranker
      ? {
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
          openRouterRouting: { mode: "only_selected", providers: ["Together"] },
          upstreamModelId: "qwen/qwen3-reranker-8b"
        }
      : {
          adapterKind: "openai_responses_compatible",
          answerSelectable: true,
          capabilities: {
            nativePdfInput: false,
            nativeSearch: false,
            pdf: false,
            reasoning: false,
            streaming: true,
            structuredOutput: true,
            toolCalling: true,
            vision: false
          },
          defaultParams: {},
          modelClass: "answer",
          upstreamModelId: "utility-answer"
        },
    modelDisplayName: reranker ? "Qwen reranker" : "Utility answer",
    providerFamily: reranker ? "openrouter" : "openai_compatible",
    providerModelId: reranker ? "reranker-model" : "answer-model",
    version: 1
  };
}

function authority(snapshot: ProviderExecutionSnapshot) {
  return {
    connectionId: snapshot.connectionId,
    connectionVersion: 2,
    credentialId: snapshot.credentialId!,
    credentialVersionId: snapshot.credentialVersionId!,
    modelVersion: 3,
    providerModelId: snapshot.providerModelId
  };
}

function systemRole(): ProviderAdmissionRole {
  const admitted = executionSnapshot("answer");
  return {
    authority: authority(admitted),
    credentialSource: "default",
    modelConfiguration: {
      adapterKind: "openai_responses_compatible",
      capabilities: admitted.model.capabilities,
      defaultParams: {}
    },
    snapshot: admitted
  };
}

function rerankerRole(
  providerModelId = "reranker-model",
  upstreamModelId = "qwen/qwen3-reranker-8b"
): RerankerProviderAdmissionRole {
  const base = executionSnapshot("reranker");
  const admitted = {
    ...base,
    model: { ...base.model, upstreamModelId },
    providerModelId
  };
  return {
    authority: authority(admitted),
    configuration: admitted.model as ProviderModelConfiguration,
    credentialSource: "default",
    provider: "openrouter",
    snapshot: admitted
  };
}

const policyDb = {} as Prisma.TransactionClient;

describe("Memory dedicated reranker policy", () => {
  it("binds reranking to the dedicated class without an aggregation destination", async () => {
    const policy = await resolveCurrentMemoryUtilityPolicy(
      policyDb as never,
      "user-1",
      { embeddingProviderModelId: null },
      {
        resolveRerankerRole: async () => ({
          credentialScope: "installation",
          ok: true,
          policyVersion: 7,
          providerModelId: "reranker-model",
          role: rerankerRole()
        }),
        resolveSystemRole: async () => ({
          credentialScope: "installation",
          ok: true,
          policyVersion: 7,
          providerModelId: "answer-model",
          reasoningEffort: null,
          role: systemRole()
        })
      }
    );

    expect(policy.targets.get("MEMORY_RERANK")?.snapshot.model)
      .toMatchObject({ modelClass: "reranker" });
    expect(policy.targets.has("MEMORY_QUERY_RESOLVE")).toBe(false);
    expect(policy.destinations.some(({ role }) => role === "MEMORY_QUERY_RESOLVE"))
      .toBe(false);
    expect(policy.targets.has("MEMORY_AGGREGATE")).toBe(false);
    expect(policy.destinations.some(({ role }) => role === "MEMORY_AGGREGATE"))
      .toBe(false);
    expect(policy.targets.get("MEMORY_RERANK")?.policyRevision).toBe(7);
  });

  it("uses the system model only when the dedicated role is explicitly absent", async () => {
    const policy = await resolveCurrentMemoryUtilityPolicy(
      policyDb as never,
      "user-1",
      { embeddingProviderModelId: null },
      {
        resolveRerankerRole: async () => ({
          code: "reranker_model_absent",
          ok: false,
          selectedProviderModelId: null
        }),
        resolveSystemRole: async () => ({
          credentialScope: "installation",
          ok: true,
          policyVersion: 8,
          providerModelId: "answer-model",
          reasoningEffort: null,
          role: systemRole()
        })
      }
    );

    expect(policy.targets.get("MEMORY_RERANK")?.snapshot.model)
      .toMatchObject({ modelClass: "answer" });
  });

  it("fingerprints and resolves every ordered dedicated fallback target", async () => {
    const primary = rerankerRole("reranker-primary", "voyageai/rerank-2.5");
    const fallback = rerankerRole("reranker-fallback", "cohere/rerank-4-pro");
    const policy = await resolveCurrentMemoryUtilityPolicy(
      policyDb as never,
      "user-1",
      { embeddingProviderModelId: null },
      {
        resolveRerankerRole: async () => ({
          credentialScope: "installation",
          ok: true,
          policyVersion: 11,
          providerModelId: "reranker-primary",
          role: primary,
          routes: [
            { providerModelId: "reranker-primary", role: primary },
            { providerModelId: "reranker-fallback", role: fallback }
          ],
          selectedProviderModelId: "reranker-primary"
        }),
        resolveSystemRole: async () => ({
          credentialScope: "installation",
          ok: true,
          policyVersion: 11,
          providerModelId: "answer-model",
          reasoningEffort: null,
          role: systemRole()
        })
      }
    );

    expect(policy.rerankerTargets?.map((target) =>
      target.authority.providerModelId)).toEqual([
      "reranker-primary",
      "reranker-fallback"
    ]);
    expect(requireMemoryPolicyTarget(
      policy,
      "MEMORY_RERANK",
      "reranker-fallback"
    ).snapshot.model.upstreamModelId).toBe("cohere/rerank-4-pro");
  });

  it("does not substitute the system model for a configured broken reranker", async () => {
    const policy = await resolveCurrentMemoryUtilityPolicy(
      policyDb as never,
      "user-1",
      { embeddingProviderModelId: null },
      {
        resolveRerankerRole: async () => ({
          code: "reranker_model_unavailable",
          ok: false,
          selectedProviderModelId: "reranker-model"
        }),
        resolveSystemRole: async () => ({
          credentialScope: "installation",
          ok: true,
          policyVersion: 9,
          providerModelId: "answer-model",
          reasoningEffort: null,
          role: systemRole()
        })
      }
    );

    expect(policy.targets.has("MEMORY_RERANK")).toBe(false);
    expect(policy.destinations).toContainEqual({
      code: "reranker_model_unavailable",
      kind: "UNAVAILABLE",
      role: "MEMORY_RERANK",
      selectedProviderModelId: "reranker-model"
    });
    expect(policy.targets.has("MEMORY_AGGREGATE")).toBe(false);
  });
});
