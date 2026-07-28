import { describe, expect, it, vi } from "vitest";
import type { AdminProviderCustomSetupRequest } from "../../../contracts/adminProviderCustomSetup";
import {
  AdminProviderCustomSetupServiceError,
  createAdminProviderCustomSetupService
} from "./customSetupService";
import type { AdminProviderCustomSetupCommitPlan } from "./customSetupRepositoryContract";

const ACTOR = { sessionId: "session-1", userId: "admin-1" };
const CHECKED_AT = new Date("2026-07-26T10:00:00.000Z");
const COMMITTED_AT = new Date("2026-07-26T10:00:01.000Z");

function request(
  overrides: Partial<AdminProviderCustomSetupRequest> = {}
): AdminProviderCustomSetupRequest {
  return {
    allowPrivateNetwork: false,
    apiRoot: "https://llm.example.test/v1/",
    authenticationMode: "bearer",
    confirmPaidRequest: true,
    modelId: "vendor/model-1",
    secret: "exact-secret",
    ...overrides
  };
}

function harness(options: {
  commit?: "catalog_unavailable" | "forbidden" | "stale" | {
    defaultChanged: boolean;
    status: "ready";
  };
  testStatus?: "available" | "unavailable";
  unavailableModelId?: string;
} = {}) {
  const test = vi.fn(async (input: { model: { upstreamModelId: string } }) => ({
    evidence: {
      detail: options.testStatus === "unavailable" ||
        options.unavailableModelId === input.model.upstreamModelId
        ? "model_missing" as const
        : "ok" as const,
      method: "tiny_generation" as const,
      selectedProviders: [],
      upstreamModelId: input.model.upstreamModelId
    },
    status: options.testStatus === "unavailable" ||
      options.unavailableModelId === input.model.upstreamModelId
      ? "unavailable" as const
      : "available" as const
  }));
  const commit = vi.fn(async (_plan: AdminProviderCustomSetupCommitPlan) => options.commit ?? ({
    defaultChanged: true,
    status: "ready" as const
  }));
  const encryptionKey = vi.fn(() => Buffer.alloc(32, 9));
  const ids = [
    "connection-1",
    "model-1",
    "credential-1",
    "version-1",
    "grant-1",
    "search-grant-1",
    "extra-grant-1"
  ];
  const times = [CHECKED_AT, COMMITTED_AT];
  const service = createAdminProviderCustomSetupService({
    encryptionKey,
    idFactory: () => ids.shift()!,
    now: () => times.shift()!,
    repository: { commit },
    tester: { test }
  });
  return { commit, encryptionKey, service, test };
}

describe("custom OpenAI-compatible provider setup service", () => {
  it("tests once, then commits an active personal bearer graph", async () => {
    const { commit, service, test } = harness();

    await expect(service.setup({ actor: ACTOR, request: request() })).resolves.toEqual({
      authenticationMode: "bearer",
      checkedAt: CHECKED_AT.toISOString(),
      connectionDisplayName: "Custom · llm.example.test",
      connectionId: "connection-1",
      defaultChanged: true,
      modelDisplayName: "vendor/model-1",
      models: [{
        modelDisplayName: "vendor/model-1",
        providerModelId: "model-1"
      }],
      outcome: "ready",
      providerModelId: "model-1"
    });

    expect(test).toHaveBeenCalledOnce();
    expect(test).toHaveBeenCalledWith(expect.objectContaining({
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://llm.example.test/v1",
        authenticationMode: "bearer"
      },
      model: expect.objectContaining({
        adapterKind: "openai_chat_completions_compatible",
        upstreamModelId: "vendor/model-1"
      }),
      secret: "exact-secret"
    }));
    expect(commit).toHaveBeenCalledOnce();
    const plan = commit.mock.calls[0]![0];
    expect(plan.credential.secretEnvelope).toEqual(expect.any(String));
    expect(plan.credential.secretEnvelope).not.toContain("exact-secret");
    expect(plan.models[0]!.configuration.capabilities).toMatchObject({
      contextWindow: 8_192,
      defaultMaxOutputTokens: 1_024,
      toolCalling: false
    });
  });

  it("accepts an explicit keyless HTTP private setup without creating ciphertext", async () => {
    const { commit, encryptionKey, service, test } = harness({
      commit: { defaultChanged: false, status: "ready" }
    });
    const keyless = request({
      allowPrivateNetwork: true,
      apiRoot: "http://127.0.0.1:11434/v1",
      authenticationMode: "none",
      secret: undefined
    });

    await expect(service.setup({ actor: ACTOR, request: keyless })).resolves.toMatchObject({
      authenticationMode: "none",
      defaultChanged: false,
      outcome: "ready"
    });
    expect(test).toHaveBeenCalledWith(expect.objectContaining({ secret: null }));
    expect(encryptionKey).not.toHaveBeenCalled();
    expect(commit.mock.calls[0]![0]).toMatchObject({
      connection: {
        configuration: {
          allowPrivateNetwork: true,
          apiRoot: "http://127.0.0.1:11434/v1",
          authenticationMode: "none"
        }
      },
      credential: {
        label: "No authentication",
        secretEnvelope: null
      }
    });
  });

  it("maps Responses and declared hosted web search into runnable configuration and entitlement", async () => {
    const { commit, service, test } = harness();
    await service.setup({
      actor: ACTOR,
      request: request({
        capabilities: {
          contextWindow: 16_384,
          nativeImageGeneration: true,
          nativePdfInput: false,
          nativeSearch: true,
          pdf: false,
          reasoning: false,
          streaming: true,
          vision: false
        },
        protocol: "responses"
      })
    });

    expect(test).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({
        adapterKind: "openai_responses_compatible",
        capabilities: expect.objectContaining({
          nativeImageGeneration: true,
          nativeSearch: true
        })
      })
    }));
    expect(commit.mock.calls[0]![0]).toMatchObject({
      searchGrantId: "search-grant-1"
    });
  });

  it.each([
    request({
      capabilities: {
        nativePdfInput: false,
        nativeSearch: true,
        pdf: false,
        reasoning: false,
        vision: false
      },
      protocol: "chat_completions"
    }),
    request({
      allowPrivateNetwork: true,
      apiRoot: "http://127.0.0.1:11434/v1",
      authenticationMode: "none",
      protocol: "responses",
      secret: undefined
    })
  ])("rejects protocol/tool combinations the runtime cannot honor", async (candidate) => {
    const { commit, service, test } = harness();
    await expect(service.setup({ actor: ACTOR, request: candidate })).rejects.toBeInstanceOf(Error);
    expect(test).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    request({ authenticationMode: "none", secret: undefined }),
    request({
      allowPrivateNetwork: true,
      apiRoot: "https://127.0.0.1/v1",
      authenticationMode: "none",
      secret: undefined
    }),
    request({ authenticationMode: "none" }),
    request({ secret: undefined })
  ])("rejects an invalid authentication shape before remote or database work", async (candidate) => {
    const { commit, service, test } = harness();
    await expect(service.setup({ actor: ACTOR, request: candidate })).rejects.toBeInstanceOf(Error);
    expect(test).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    request({ modelIds: ["vendor/a"] }),
    request({ modelId: undefined, modelIds: [] }),
    request({ modelId: undefined, modelIds: ["vendor/a", "vendor/a"] }),
    request({
      modelId: undefined,
      modelIds: Array.from({ length: 33 }, (_, index) => `vendor/${index}`)
    }),
    request({
      modelDisplayName: "Ambiguous name",
      modelId: undefined,
      modelIds: ["vendor/a", "vendor/b"]
    })
  ])("rejects an invalid multi-model shape before remote or database work", async (candidate) => {
    const { commit, service, test } = harness();
    await expect(service.setup({ actor: ACTOR, request: candidate })).rejects.toBeInstanceOf(Error);
    expect(test).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("never commits when the exact tiny generation is unavailable", async () => {
    const { commit, service } = harness({ testStatus: "unavailable" });
    await expect(service.setup({ actor: ACTOR, request: request() })).rejects.toMatchObject({
      code: "provider_custom_setup_test_failed"
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("tests every selected model in order and commits the complete graph once", async () => {
    const { commit, service, test } = harness();

    const result = await service.setup({
      actor: ACTOR,
      request: request({ modelId: undefined, modelIds: ["vendor/a", "vendor/b"] })
    });

    expect(test).toHaveBeenCalledTimes(2);
    expect(test.mock.calls.map(([input]) => input.model.upstreamModelId)).toEqual([
      "vendor/a",
      "vendor/b"
    ]);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]![0].models.map((model) =>
      model.configuration.upstreamModelId)).toEqual(["vendor/a", "vendor/b"]);
    expect(result.models).toEqual([
      { modelDisplayName: "vendor/a", providerModelId: "model-1" },
      { modelDisplayName: "vendor/b", providerModelId: "credential-1" }
    ]);
    expect(result.providerModelId).toBe("model-1");
  });

  it("writes nothing when any selected model fails its exact test", async () => {
    const { commit, service, test } = harness({ unavailableModelId: "vendor/b" });

    await expect(service.setup({
      actor: ACTOR,
      request: request({ modelId: undefined, modelIds: ["vendor/a", "vendor/b"] })
    })).rejects.toMatchObject({ code: "provider_custom_setup_test_failed" });

    expect(test).toHaveBeenCalledTimes(2);
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    ["catalog_unavailable", "provider_custom_setup_catalog_unavailable"],
    ["forbidden", "provider_custom_setup_stale"],
    ["stale", "provider_custom_setup_stale"]
  ] as const)("maps %s commit refusal without returning partial Ready", async (commitResult, code) => {
    const { service } = harness({ commit: commitResult });
    let failure: unknown;
    try {
      await service.setup({ actor: ACTOR, request: request() });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AdminProviderCustomSetupServiceError);
    expect(failure).toMatchObject({ code });
  });
});
