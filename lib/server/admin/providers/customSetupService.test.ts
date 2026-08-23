import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES,
  type AdminProviderCustomSetupRequest
} from "../../../contracts/adminProviderCustomSetup";
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
    protocol: "chat_completions",
    responseTimeoutSeconds: 300,
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
  searchThrows?: boolean;
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
    ...(_plan.search ? {
      search: _plan.search.evidence.status === "available"
        ? "ready" as const
        : "needs_attention" as const
    } : {}),
    status: "ready" as const
  }));
  const searchTest = vi.fn(async () => {
    if (options.searchThrows) throw new Error("search unavailable");
    return { normalizedSourceCount: 2, status: "available" as const };
  });
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
    ...(options.searchThrows ? { searchTester: { test: searchTest } } : {}),
    tester: { test }
  });
  return { commit, encryptionKey, searchTest, service, test };
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
      providerModelId: "model-1",
      search: null
    });

    expect(test).toHaveBeenCalledOnce();
    expect(test).toHaveBeenCalledWith(expect.objectContaining({
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://llm.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
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
      pdf: true,
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

  it("plans one connection-scoped Responses Search without a Search probe", async () => {
    const { commit, searchTest, service, test } = harness();
    const result = await service.setup({
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
          nativeSearch: true,
          pdf: true
        })
      })
    }));
    expect(searchTest).not.toHaveBeenCalled();
    expect(commit.mock.calls[0]![0]).toMatchObject({
      search: {
        client: {
          draft: { providerModelId: "model-1" },
          id: "custom-web-search-client:connection-1"
        },
        displayName: "Custom · llm.example.test Search",
        evidence: {
          method: "configuration",
          normalizedSourceCount: 0,
          status: "available"
        },
        grantId: "search-grant-1",
        hosted: {
          draft: { providerModelId: null },
          id: "custom-web-search-hosted:connection-1"
        },
        optionId: "custom-web-search:connection-1",
        optionRowId: "custom-web-search-option:connection-1"
      }
    });
    expect(result.search).toEqual({
      displayName: "Custom · llm.example.test Search",
      status: "ready"
    });
    expect(JSON.stringify(commit.mock.calls[0]![0])).not.toContain("exact-secret");
  });

  it("does not let an optional Search diagnostic gate the declared Search source", async () => {
    const { commit, searchTest, service } = harness({ searchThrows: true });
    const result = await service.setup({
      actor: ACTOR,
      request: request({
        capabilities: {
          ...ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES,
          nativeSearch: true
        },
        protocol: "responses"
      })
    });

    expect(commit).toHaveBeenCalledOnce();
    expect(searchTest).not.toHaveBeenCalled();
    expect(commit.mock.calls[0]![0].search?.evidence).toMatchObject({
      normalizedSourceCount: 0,
      status: "available"
    });
    expect(result).toMatchObject({
      outcome: "ready",
      search: { status: "ready" }
    });
  });

  it("supports explicit no-auth Responses Search without a probe secret", async () => {
    const { commit, encryptionKey, searchTest, service, test } = harness();
    const result = await service.setup({
      actor: ACTOR,
      request: request({
        allowPrivateNetwork: true,
        apiRoot: "http://127.0.0.1:11434/v1",
        authenticationMode: "none",
        capabilities: {
          ...ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES,
          nativeSearch: true
        },
        protocol: "responses",
        secret: undefined
      })
    });

    expect(test).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({ adapterKind: "openai_responses_compatible" }),
      secret: null
    }));
    expect(searchTest).not.toHaveBeenCalled();
    expect(encryptionKey).not.toHaveBeenCalled();
    expect(commit.mock.calls[0]![0]).toMatchObject({
      credential: { secretEnvelope: null },
      search: {
        evidence: { method: "configuration", status: "available" }
      }
    });
    expect(result.search).toEqual({
      displayName: "Custom · 127.0.0.1 Search",
      status: "ready"
    });
  });

  it("normalizes one compatible reasoning override before test and commit", async () => {
    const { commit, service, test } = harness();
    await service.setup({
      actor: ACTOR,
      request: request({
        capabilities: {
          ...ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES,
          defaultReasoningEffort: "medium",
          defaultReasoningMode: "standard",
          reasoning: true,
          reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
          reasoningModes: ["standard", "pro"]
        },
        protocol: "responses",
        reasoningRequestMapping: {
          effortPath: "reason",
          modePath: "mode"
        }
      })
    });

    expect(test).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({
        reasoningRequestMapping: { effortPath: "reason", modePath: "mode" }
      })
    }));
    expect(commit.mock.calls[0]![0].models[0]!.configuration.reasoningRequestMapping)
      .toEqual({ effortPath: "reason", modePath: "mode" });
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
