import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { applySystemModelReasoningEffort } from "../../providerRuntime/systemModelRole";
import type {
  ProviderAdmissionRole,
  RerankerProviderAdmissionRole
} from "../../providerRuntime/admission";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import type { ProviderModelConfiguration } from "../../providers/providerConfiguration";
import { resolveCurrentMemoryUtilityPolicy } from "./policy";

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

function rerankerRole(): RerankerProviderAdmissionRole {
  const admitted = executionSnapshot("reranker");
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
  it("binds reranking to the dedicated class while aggregation stays generative", async () => {
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
    expect(policy.targets.get("MEMORY_AGGREGATE")?.snapshot.model)
      .toMatchObject({ modelClass: "answer" });
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
    expect(policy.targets.get("MEMORY_AGGREGATE")?.snapshot.model)
      .toMatchObject({ modelClass: "answer" });
  });
});
