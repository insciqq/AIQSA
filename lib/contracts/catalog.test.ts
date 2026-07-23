import { describe, expect, it } from "vitest";
import { decodeCatalogResponse, type CatalogResponse } from "./catalog";

function validResponse(): CatalogResponse {
  return {
    catalog: {
      defaults: {
        controlValues: {},
        modelId: "gpt-test",
        promptPresetId: "prompt-1",
        provider: "openai",
        searchStrategyId: "search-disabled",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true,
      },
      models: [
        {
          capabilities: {
            background: true,
            documentInputMode: "none",
            imageInput: false,
            nativeWebSearch: false,
            openRouterPerplexitySearch: false,
            reasoning: true,
            streaming: true,
            text: true
          },
          contextWindow: 128_000,
          defaultParams: {},
          displayName: "GPT Test",
          modelId: "gpt-test",
          parameterControls: {
            background: { defaultValue: true, supported: true },
            maxOutputTokens: { defaultValue: 1024, maxValue: 4096 },
            reasoningEffort: {
              defaultValue: "medium",
              options: ["none", "low", "medium", "high"],
              supported: true
            },
            reasoningMode: {
              defaultValue: "standard",
              options: ["standard", "pro"],
              supported: true
            },
            stream: { defaultValue: false, supported: true },
            temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
          },
          provider: "openai",
          searchStrategyIds: ["search-disabled"]
        }
      ],
      promptPresets: [
        {
          developerPrompt: null,
          id: "prompt-1",
          isDefault: true,
          name: "Helpful Assistant",
          systemPrompt: "Help"
        }
      ],
      providers: [{ id: "openai", models: ["gpt-test"], name: "OpenAI" }],
      searchStrategies: [
        {
          config: {},
          description: "Direct answer",
          displayName: "No Search",
          kind: "none",
          provider: "system",
          strategyId: "search-disabled"
        }
      ]
    }
  };
}

describe("catalog wire contract", () => {
  it("decodes the complete catalog response", () => {
    expect(decodeCatalogResponse(validResponse())).toMatchObject({
      defaults: validResponse().catalog.defaults,
      models: [
        {
          capabilities: {
            documentInputMode: "none"
          },
          modelId: "gpt-test"
        }
      ],
      searchStrategies: [
        {
          displayName: "No Search",
          kind: "none",
          strategyId: "search-disabled"
        }
      ]
    });
  });

  it("rejects a malformed nested parameter control", () => {
    const response = validResponse();
    response.catalog.models[0].parameterControls.temperature.maxValue = Number.NaN;

    expect(decodeCatalogResponse(response)).toBeNull();
  });

  it("decodes model-specific reasoning modes and rejects malformed options", () => {
    const response = validResponse();

    expect(decodeCatalogResponse(response)?.models[0].parameterControls.reasoningMode).toEqual({
      defaultValue: "standard",
      options: ["standard", "pro"],
      supported: true
    });

    const malformedResponse = validResponse() as unknown as {
      catalog: { models: { parameterControls: { reasoningMode: { options: unknown[] } } }[] };
    };
    malformedResponse.catalog.models[0].parameterControls.reasoningMode.options = ["standard", 42];

    expect(decodeCatalogResponse(malformedResponse)).toBeNull();
  });

  it("rejects an unknown document input mode", () => {
    const response = validResponse() as unknown as {
      catalog: { models: { capabilities: { documentInputMode: string } }[] };
    };
    response.catalog.models[0].capabilities.documentInputMode = "provider_magic";

    expect(decodeCatalogResponse(response)).toBeNull();
  });

  it("rejects a malformed prompt default", () => {
    const response = validResponse() as unknown as {
      catalog: { defaults: { promptPresetId: unknown } };
    };
    response.catalog.defaults.promptPresetId = 42;

    expect(decodeCatalogResponse(response)).toBeNull();
  });

  it("requires the persisted tool activity default", () => {
    const response = validResponse() as unknown as {
      catalog: { defaults: Record<string, unknown> };
    };
    delete response.catalog.defaults.showToolActivity;

    expect(decodeCatalogResponse(response)).toBeNull();
  });

  it("validates provider routing data while keeping the shell projection narrow", () => {
    const response = validResponse();
    response.catalog.models[0].routeProviderPreferences = {
      allowFallbacks: false,
      dataCollection: "deny",
      order: ["openai"],
      only: ["OpenAI"],
      requireParameters: true,
      sort: "throughput",
      zdr: false
    };

    const decoded = decodeCatalogResponse(response);

    expect(decoded).not.toBeNull();
    expect(decoded?.models[0]).not.toHaveProperty("routeProviderPreferences");
    expect(decoded?.models[0].capabilities).not.toHaveProperty("text");
    expect(decoded?.searchStrategies[0]).toEqual({
      displayName: "No Search",
      kind: "none",
      strategyId: "search-disabled"
    });
  });

  it("accepts empty entitlement-derived catalog collections", () => {
    const response = validResponse();
    response.catalog.models = [];
    response.catalog.providers = [];
    response.catalog.searchStrategies = [];

    expect(decodeCatalogResponse(response)).toMatchObject({
      models: [],
      providers: [],
      searchStrategies: []
    });
  });

  it("tolerates additive wire fields without widening the shell projection", () => {
    const response = validResponse();
    const extendedResponse = {
      ...response,
      catalog: {
        ...response.catalog,
        catalogRevision: "future-revision",
        defaults: {
          ...response.catalog.defaults,
          futureDefault: true
        },
        models: response.catalog.models.map((model) => ({
          ...model,
          capabilities: {
            ...model.capabilities,
            futureCapability: true
          },
          futureModelField: "ignored"
        })),
        searchStrategies: response.catalog.searchStrategies.map((strategy) => ({
          ...strategy,
          futureStrategyField: "ignored"
        }))
      },
      requestId: "future-request-id"
    };

    expect(decodeCatalogResponse(extendedResponse)).toEqual(decodeCatalogResponse(response));
  });

  it("rejects a provider with a malformed model-id collection", () => {
    const response = validResponse();
    const malformedResponse = {
      catalog: {
        ...response.catalog,
        providers: [
          {
            ...response.catalog.providers[0],
            models: ["gpt-test", 42]
          }
        ]
      }
    };

    expect(decodeCatalogResponse(malformedResponse)).toBeNull();
  });

  it("rejects malformed optional search-strategy wire data", () => {
    const response = validResponse();
    const malformedResponse = {
      catalog: {
        ...response.catalog,
        searchStrategies: [
          {
            ...response.catalog.searchStrategies[0],
            config: []
          }
        ]
      }
    };

    expect(decodeCatalogResponse(malformedResponse)).toBeNull();
  });

  it.each([
    ["default model", (response: CatalogResponse) => (response.catalog.defaults.modelId = "")],
    ["model id", (response: CatalogResponse) => (response.catalog.models[0].modelId = "")],
    ["prompt name", (response: CatalogResponse) => (response.catalog.promptPresets[0].name = "")],
    ["provider id", (response: CatalogResponse) => (response.catalog.providers[0].id = "")],
    [
      "search strategy id",
      (response: CatalogResponse) => (response.catalog.searchStrategies[0].strategyId = "")
    ]
  ])("rejects an empty required %s", (_label, mutate) => {
    const response = validResponse();
    mutate(response);

    expect(decodeCatalogResponse(response)).toBeNull();
  });
});
