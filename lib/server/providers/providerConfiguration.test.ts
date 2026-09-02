import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS,
  effectiveProviderResponseTimeoutMs,
  normalizeProviderConnectionConfiguration,
  normalizeProviderModelConfiguration as normalizeProviderModelConfigurationBase,
  providerAuthenticationMode,
  providerRequestEndpoint,
  ProviderConfigurationError
} from "./providerConfiguration";

function normalizeProviderModelConfiguration(value: Record<string, unknown>) {
  return normalizeProviderModelConfigurationBase({
    answerSelectable: true,
    modelClass: "answer",
    ...value
  });
}

const capabilities = {
  nativePdfInput: false,
  nativeSearch: false,
  pdf: false,
  reasoning: true,
  streaming: true,
  toolCalling: true,
  vision: false
};

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("Expected provider configuration to be rejected.");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderConfigurationError);
    expect(error).toMatchObject({ code, message: code });
  }
}

describe("provider connection configuration", () => {
  it("canonicalizes an HTTPS API root and derives reviewed terminal paths", () => {
    const configuration = normalizeProviderConnectionConfiguration({
      allowPrivateNetwork: false,
      apiRoot: "https://api.example.test/v1///",
      authenticationMode: "bearer",
      responseTimeoutMs: DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS
    });

    expect(configuration).toEqual({
      allowPrivateNetwork: false,
      apiRoot: "https://api.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS
    });
    expect(providerRequestEndpoint(configuration, "openai_responses_compatible"))
      .toBe("https://api.example.test/v1/responses");
    expect(providerRequestEndpoint(configuration, "openai_chat_completions_compatible"))
      .toBe("https://api.example.test/v1/chat/completions");
    expect(providerRequestEndpoint(configuration, "anthropic_messages"))
      .toBe("https://api.example.test/v1/messages");
    expect(providerRequestEndpoint(configuration, "gemini_interactions_native"))
      .toBe("https://api.example.test/v1/interactions");
    expect(providerRequestEndpoint(configuration, "openrouter_rerank"))
      .toBe("https://api.example.test/v1/rerank");
  });

  it("allows HTTP only for an explicit internal-network connection", () => {
    expect(
      normalizeProviderConnectionConfiguration({
        allowPrivateNetwork: true,
        apiRoot: "http://127.0.0.1:11434/v1",
        authenticationMode: "none",
        responseTimeoutMs: 300_000
      })
    ).toMatchObject({ apiRoot: "http://127.0.0.1:11434/v1" });

    expectCode(
      () => normalizeProviderConnectionConfiguration({
        allowPrivateNetwork: false,
        apiRoot: "http://127.0.0.1:11434/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      }),
      "provider_api_root_invalid"
    );
  });

  it("requires and preserves explicit authentication", () => {
    const bearer = normalizeProviderConnectionConfiguration({
      allowPrivateNetwork: false,
      apiRoot: "https://api.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: 300_000
    });
    const none = normalizeProviderConnectionConfiguration({
      allowPrivateNetwork: true,
      apiRoot: "http://127.0.0.1:11434/v1",
      authenticationMode: "none",
      responseTimeoutMs: 300_000
    });

    expectCode(
      () => normalizeProviderConnectionConfiguration({
        allowPrivateNetwork: false,
        apiRoot: "https://api.example.test/v1",
        responseTimeoutMs: 300_000
      }),
      "provider_authentication_mode_invalid"
    );
    expect(providerAuthenticationMode(bearer)).toBe("bearer");
    expect(bearer.authenticationMode).toBe("bearer");
    expect(none.authenticationMode).toBe("none");
  });

  it("requires response deadlines and accepts the inclusive configured range", () => {
    const configured = normalizeProviderConnectionConfiguration({
      allowPrivateNetwork: false,
      apiRoot: "https://api.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: 500_000
    });

    expectCode(
      () => normalizeProviderConnectionConfiguration({
        allowPrivateNetwork: false,
        apiRoot: "https://api.example.test/v1",
        authenticationMode: "bearer"
      }),
      "provider_response_timeout_invalid"
    );
    expect(configured.responseTimeoutMs).toBe(500_000);
    for (const responseTimeoutMs of [5_000, 900_000]) {
      expect(normalizeProviderConnectionConfiguration({
        allowPrivateNetwork: false,
        apiRoot: "https://api.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs
      }).responseTimeoutMs).toBe(responseTimeoutMs);
    }
  });

  it.each([4_999, 900_001, 5_000.5, "300000", null, {}])(
    "rejects invalid connection response deadline %#",
    (responseTimeoutMs) => {
      expectCode(
        () => normalizeProviderConnectionConfiguration({
          allowPrivateNetwork: false,
          apiRoot: "https://api.example.test/v1",
          authenticationMode: "bearer",
          responseTimeoutMs
        }),
        "provider_response_timeout_invalid"
      );
    }
  );

  it.each([
    { allowPrivateNetwork: false, apiRoot: "https://api.example.test/v1", authenticationMode: "none", responseTimeoutMs: 300_000 },
    { allowPrivateNetwork: true, apiRoot: "https://api.example.test/v1", authenticationMode: "none", responseTimeoutMs: 300_000 },
    { allowPrivateNetwork: true, apiRoot: "http://127.0.0.1:11434/v1", authenticationMode: "basic", responseTimeoutMs: 300_000 }
  ])("rejects an unsafe or unknown authentication contract", (configuration) => {
    expectCode(
      () => normalizeProviderConnectionConfiguration(configuration),
      "provider_authentication_mode_invalid"
    );
  });

  it.each([
    "ftp://api.example.test/v1",
    "https://user:pass@api.example.test/v1",
    "https://api.example.test/v1?key=secret",
    "https://api.example.test/v1#fragment"
  ])("rejects unsafe API root %s", (apiRoot) => {
    expectCode(
      () => normalizeProviderConnectionConfiguration({
        allowPrivateNetwork: false,
        apiRoot,
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      }),
      "provider_api_root_invalid"
    );
  });
});

describe("provider model configuration", () => {
  it("inherits the connection deadline or preserves a bounded model override", () => {
    const connection = normalizeProviderConnectionConfiguration({
      allowPrivateNetwork: false,
      apiRoot: "https://api.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: 500_000
    });
    const inherited = normalizeProviderModelConfiguration({
      adapterKind: "openai_responses_compatible",
      capabilities,
      defaultParams: {},
      upstreamModelId: "inherited"
    });
    const overridden = normalizeProviderModelConfiguration({
      adapterKind: "openai_responses_compatible",
      capabilities,
      defaultParams: {},
      responseTimeoutMs: 800_000,
      upstreamModelId: "overridden"
    });

    expect(inherited.responseTimeoutMs).toBeUndefined();
    expect(overridden.responseTimeoutMs).toBe(800_000);
    expect(effectiveProviderResponseTimeoutMs(connection, inherited)).toBe(500_000);
    expect(effectiveProviderResponseTimeoutMs(connection, overridden)).toBe(800_000);
  });

  it.each([4_999, 900_001, 5_000.5, "300000", null, {}])(
    "rejects invalid model response deadline %#",
    (responseTimeoutMs) => {
      expectCode(
        () => normalizeProviderModelConfiguration({
          adapterKind: "openai_responses_compatible",
          capabilities,
          defaultParams: {},
          responseTimeoutMs,
          upstreamModelId: "invalid-timeout"
        }),
        "provider_response_timeout_invalid"
      );
    }
  );

  it("preserves current answer-selectable and technical-only roles", () => {
    const answer = normalizeProviderModelConfiguration({
      adapterKind: "openai_responses_compatible",
      capabilities,
      defaultParams: {},
      upstreamModelId: "answer-model"
    });
    const technical = normalizeProviderModelConfiguration({
      adapterKind: "openai_responses_compatible",
      answerSelectable: false,
      capabilities,
      defaultParams: {},
      upstreamModelId: "search-runtime"
    });

    expect(answer.answerSelectable).toBe(true);
    expect(technical.answerSelectable).toBe(false);
    expectCode(
      () => normalizeProviderModelConfiguration({
        adapterKind: "openai_responses_compatible",
        answerSelectable: "false",
        capabilities,
        defaultParams: {},
        upstreamModelId: "invalid-runtime"
      }),
      "provider_answer_selection_invalid"
    );
  });

  it("normalizes bounded declared reasoning controls", () => {
    expect(normalizeProviderModelConfiguration({
      adapterKind: "openai_responses_compatible",
      capabilities: {
        ...capabilities,
        defaultReasoningEffort: "medium",
        defaultReasoningMode: "standard",
        reasoningEfforts: ["low", "medium", "high", "ultra"],
        reasoningModes: ["standard", "pro"]
      },
      defaultParams: {},
      upstreamModelId: "reasoning-model"
    }).capabilities).toMatchObject({
      defaultReasoningEffort: "medium",
      defaultReasoningMode: "standard",
      reasoningEfforts: ["low", "medium", "high", "ultra"],
      reasoningModes: ["standard", "pro"]
    });
  });

  it.each([
    {
      ...capabilities,
      defaultReasoningEffort: "medium",
      reasoningEfforts: ["low", "high"]
    },
    {
      ...capabilities,
      defaultReasoningMode: "standard"
    },
    {
      ...capabilities,
      reasoning: false,
      reasoningEfforts: ["low"]
    },
    {
      ...capabilities,
      reasoningEfforts: Array.from({ length: 17 }, (_value, index) => `level-${index}`)
    }
  ])("rejects inconsistent or unbounded reasoning metadata", (invalidCapabilities) => {
    expectCode(
      () => normalizeProviderModelConfiguration({
        adapterKind: "openai_responses_compatible",
        capabilities: invalidCapabilities,
        defaultParams: {},
        upstreamModelId: "reasoning-model"
      }),
      "provider_model_capabilities_invalid"
    );
  });

  it("round-trips an optional declared image-generation capability", () => {
    expect(normalizeProviderModelConfiguration({
      adapterKind: "openai_responses_compatible",
      capabilities: { ...capabilities, nativeImageGeneration: true },
      defaultParams: {},
      upstreamModelId: "image-capable-model"
    }).capabilities.nativeImageGeneration).toBe(true);
  });

  it("allows streaming usage only for compatible Chat Completions", () => {
    expect(normalizeProviderModelConfiguration({
      adapterKind: "openai_chat_completions_compatible",
      capabilities: { ...capabilities, streamUsage: true },
      defaultParams: {},
      upstreamModelId: "chat-usage-model"
    }).capabilities.streamUsage).toBe(true);

    for (const adapterKind of [
      "openai_responses_compatible",
      "openai_responses_native",
      "openrouter_chat_completions"
    ] as const) {
      expectCode(
        () => normalizeProviderModelConfiguration({
          adapterKind,
          capabilities: { ...capabilities, streamUsage: true },
          defaultParams: {},
          ...(adapterKind === "openrouter_chat_completions"
            ? { openRouterRouting: { mode: "automatic", providers: [] } }
            : {}),
          upstreamModelId: "invalid-stream-usage-model"
        }),
        "provider_model_capabilities_invalid"
      );
    }
  });

  it("accepts the explicit native Gemini Interactions adapter kind", () => {
    expect(normalizeProviderModelConfiguration({
      adapterKind: "gemini_interactions_native",
      capabilities,
      defaultParams: { maxTokens: 4096, stream: true },
      upstreamModelId: "gemini-3.6-flash"
    })).toMatchObject({
      adapterKind: "gemini_interactions_native",
      upstreamModelId: "gemini-3.6-flash"
    });
  });

  it("keeps only the explicit compatible Chat Completions contract", () => {
    expect(
      normalizeProviderModelConfiguration({
        adapterKind: "openai_chat_completions_compatible",
        capabilities,
        defaultParams: { maxTokens: 2048 },
        headers: { "x-secret": "must-not-survive" },
        upstreamModelId: "local-model"
      })
    ).toEqual({
      adapterKind: "openai_chat_completions_compatible",
      answerSelectable: true,
      capabilities,
      defaultParams: { maxTokens: 2048 },
      modelClass: "answer",
      reasoningRequestMapping: { effortPath: "reasoning_effort" },
      upstreamModelId: "local-model"
    });
  });

  it("defaults compatible reasoning mappings by protocol and preserves bounded overrides", () => {
    const responses = normalizeProviderModelConfiguration({
      adapterKind: "openai_responses_compatible",
      capabilities,
      defaultParams: {},
      upstreamModelId: "responses-model"
    });
    const overridden = normalizeProviderModelConfiguration({
      adapterKind: "openai_chat_completions_compatible",
      capabilities,
      defaultParams: {},
      reasoningRequestMapping: {
        effortPath: "reason.effort",
        modePath: "reason.mode"
      },
      upstreamModelId: "chat-model"
    });

    expect(responses.reasoningRequestMapping).toEqual({
      effortPath: "reasoning.effort",
      modePath: "reasoning.mode"
    });
    expect(overridden.reasoningRequestMapping).toEqual({
      effortPath: "reason.effort",
      modePath: "reason.mode"
    });
  });

  it.each([
    { effortPath: "model" },
    { effortPath: "stream_options" },
    { effortPath: "stream_options.include_usage" },
    { effortPath: "reasoning.__proto__.effort" },
    { effortPath: "reasoning..effort" },
    { effortPath: "one.two.three.four.five" },
    { effortPath: "reasoning", modePath: "reasoning.mode" },
    { effortPath: "reasoning.effort", modePath: "reasoning.effort" },
    { effortPath: "reasoning.effort", unexpected: "value" }
  ])("rejects unsafe or colliding compatible reasoning mapping %#", (reasoningRequestMapping) => {
    expectCode(
      () => normalizeProviderModelConfiguration({
        adapterKind: "openai_responses_compatible",
        capabilities,
        defaultParams: {},
        reasoningRequestMapping,
        upstreamModelId: "reasoning-model"
      }),
      "provider_reasoning_mapping_invalid"
    );
  });

  it("rejects mappings for disabled reasoning and native providers", () => {
    for (const configuration of [
      {
        adapterKind: "openai_chat_completions_compatible",
        capabilities: { ...capabilities, reasoning: false },
        defaultParams: {},
        reasoningRequestMapping: { effortPath: "effort" },
        upstreamModelId: "no-reasoning"
      },
      {
        adapterKind: "openai_responses_native",
        capabilities,
        defaultParams: {},
        reasoningRequestMapping: { effortPath: "effort" },
        upstreamModelId: "native"
      }
    ]) {
      expectCode(
        () => normalizeProviderModelConfiguration(configuration),
        "provider_reasoning_mapping_invalid"
      );
    }
  });

  it("accepts only Automatic or non-empty Only-selected OpenRouter routing", () => {
    const automatic = normalizeProviderModelConfiguration({
        adapterKind: "openrouter_chat_completions",
        capabilities,
        defaultParams: {
          provider: {
            allowFallbacks: false,
            dataCollection: "allow",
            only: ["untrusted"]
          }
        },
        openRouterRouting: { mode: "automatic", providers: [] },
        upstreamModelId: "openai/gpt-5"
      });
    expect(automatic.openRouterRouting).toEqual({ mode: "automatic", providers: [] });
    expect(automatic.defaultParams.provider).toEqual({
      allowFallbacks: true,
      dataCollection: "allow",
      only: [],
      order: [],
      requireParameters: false,
      sort: "throughput",
      zdr: false
    });

    const selected = normalizeProviderModelConfiguration({
        adapterKind: "openrouter_chat_completions",
        capabilities,
        defaultParams: {},
        openRouterRouting: { mode: "only_selected", providers: ["anthropic", "google"] },
        upstreamModelId: "openai/gpt-5"
      });
    expect(selected.openRouterRouting).toEqual({
      mode: "only_selected",
      providers: ["anthropic", "google"]
    });
    expect(selected.defaultParams.provider).toEqual({
      allowFallbacks: false,
      dataCollection: "deny",
      only: ["anthropic", "google"],
      order: ["anthropic", "google"],
      requireParameters: false,
      sort: "throughput",
      zdr: false
    });

    expectCode(
      () => normalizeProviderModelConfiguration({
        adapterKind: "openrouter_chat_completions",
        capabilities,
        defaultParams: {},
        openRouterRouting: { mode: "only_selected", providers: [] },
        upstreamModelId: "openai/gpt-5"
      }),
      "provider_routing_invalid"
    );
  });

  it("rejects routing fields for non-OpenRouter adapters", () => {
    expectCode(
      () => normalizeProviderModelConfiguration({
        adapterKind: "openai_responses_native",
        capabilities,
        defaultParams: {},
        openRouterRouting: { mode: "automatic", providers: [] },
        upstreamModelId: "gpt-5"
      }),
      "provider_routing_invalid"
    );
  });

  it("accepts ordered OpenRouter routing only for OpenRouter embedding deployments", () => {
    const inertCapabilities = {
      contextWindow: 32_768,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      toolCalling: false,
      vision: false
    };
    const embedding = {
      nativeDimension: 4_096,
      providerFamily: "openrouter" as const,
      queryInstructionTemplate: "Query: {text}",
      supportsMrl: true,
      targetDimension: 1_536
    };
    const routed = normalizeProviderModelConfigurationBase({
      adapterKind: "openai_embeddings_compatible",
      answerSelectable: false,
      capabilities: inertCapabilities,
      defaultParams: {},
      embedding,
      modelClass: "embedding",
      openRouterRouting: {
        mode: "only_selected",
        providers: ["nebius", "deepinfra"]
      },
      upstreamModelId: "qwen/qwen3-embedding-8b"
    });

    expect(routed.openRouterRouting).toEqual({
      mode: "only_selected",
      providers: ["nebius", "deepinfra"]
    });

    expectCode(() => normalizeProviderModelConfigurationBase({
      adapterKind: "openai_embeddings_compatible",
      answerSelectable: false,
      capabilities: inertCapabilities,
      defaultParams: {},
      embedding: { ...embedding, providerFamily: "openai" },
      modelClass: "embedding",
      openRouterRouting: { mode: "automatic", providers: [] },
      upstreamModelId: "text-embedding-3-large"
    }), "provider_routing_invalid");
  });

  it("keeps rerankers inert and isolated from answer and embedding classes", () => {
    const inertCapabilities = {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      toolCalling: false,
      vision: false
    };
    const valid = normalizeProviderModelConfigurationBase({
      adapterKind: "openrouter_rerank",
      answerSelectable: false,
      capabilities: inertCapabilities,
      defaultParams: {},
      modelClass: "reranker",
      openRouterRouting: { mode: "only_selected", providers: ["Together"] },
      upstreamModelId: "qwen/qwen3-reranker-8b"
    });
    expect(valid).toEqual({
      adapterKind: "openrouter_rerank",
      answerSelectable: false,
      capabilities: inertCapabilities,
      defaultParams: {},
      modelClass: "reranker",
      openRouterRouting: { mode: "only_selected", providers: ["Together"] },
      upstreamModelId: "qwen/qwen3-reranker-8b"
    });

    for (const change of [
      { answerSelectable: true },
      { capabilities: { ...inertCapabilities, toolCalling: true } },
      { defaultParams: { temperature: 0 } },
      { embedding: {
        nativeDimension: 1_024,
        providerFamily: "openrouter",
        queryInstructionTemplate: null,
        supportsMrl: false,
        targetDimension: 1_024
      } },
      { adapterKind: "openrouter_chat_completions" }
    ]) {
      expectCode(() => normalizeProviderModelConfigurationBase({
        adapterKind: "openrouter_rerank",
        answerSelectable: false,
        capabilities: inertCapabilities,
        defaultParams: {},
        modelClass: "reranker",
        openRouterRouting: { mode: "only_selected", providers: ["Together"] },
        upstreamModelId: "qwen/qwen3-reranker-8b",
        ...change
      }), "provider_model_class_invalid");
    }
    expectCode(() => normalizeProviderModelConfigurationBase({
      adapterKind: "openrouter_rerank",
      answerSelectable: false,
      capabilities: inertCapabilities,
      defaultParams: {},
      modelClass: "answer",
      openRouterRouting: { mode: "only_selected", providers: ["Together"] },
      upstreamModelId: "qwen/qwen3-reranker-8b"
    }), "provider_embedding_configuration_invalid");
  });
});
