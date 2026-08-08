import { describe, expect, it } from "vitest";
import {
  decodeCatalogResponse,
  type CatalogResponse,
  type OpenRouterRoutePreferences
} from "./catalog";

function validResponse(): CatalogResponse {
  return {
    catalog: {
      defaults: {
        controlValues: {},
        hasPersonalModelDefault: true,
        modelId: "deployment-test",
        modelPreferenceSource: "personal",
        organizationModelDefault: null,
        organizationSearchPlan: { mode: "all_selected", optionIds: [] },
        personalModelDefault: {
          modelId: "deployment-test",
          provider: "connection-test"
        },
        provider: "connection-test",
        searchStrategyId: "search-disabled",
        searchPreferenceSource: "personal",
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
            text: true,
            toolCalling: true
          },
          contextWindow: 128_000,
          defaultParams: {},
          displayName: "GPT Test",
          modelId: "deployment-test",
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
          provider: "connection-test",
          providerFamily: "openai",
          searchStrategyIds: ["search-disabled"],
          upstreamModelId: "gpt-test"
        }
      ],
      providers: [{ family: "openai", id: "connection-test", models: ["deployment-test"], name: "OpenAI" }],
      searchStrategies: [
        {
          displayName: "No Search",
          kind: "none",
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
            documentInputMode: "none",
            toolCalling: true
          },
          modelId: "deployment-test",
          provider: "connection-test",
          providerFamily: "openai",
          upstreamModelId: "gpt-test"
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

  it("preserves a null personal default when the effective model is the organization default", () => {
    const response = validResponse();
    response.catalog.defaults.hasPersonalModelDefault = false;
    response.catalog.defaults.modelPreferenceSource = "organization";
    response.catalog.defaults.organizationModelDefault = {
      modelId: "deployment-test",
      provider: "connection-test"
    };
    response.catalog.defaults.personalModelDefault = null;

    expect(decodeCatalogResponse(response)?.defaults).toMatchObject({
      hasPersonalModelDefault: false,
      modelId: "deployment-test",
      modelPreferenceSource: "organization",
      organizationModelDefault: {
        modelId: "deployment-test",
        provider: "connection-test"
      },
      personalModelDefault: null,
      provider: "connection-test"
    });
  });

  it.each([
    "hasPersonalModelDefault",
    "modelPreferenceSource",
    "organizationModelDefault",
    "personalModelDefault"
  ])("rejects a catalog that omits current model-default provenance: %s", (field) => {
    const response = validResponse() as unknown as {
      catalog: { defaults: Record<string, unknown> };
    };
    delete response.catalog.defaults[field];

    expect(decodeCatalogResponse(response)).toBeNull();
  });

  it("strictly decodes privacy-safe client-tool Search compatibility", () => {
    const response = validResponse();
    response.catalog.models[0]!.searchOptionCompatibility = {
      "company-search": {
        clientToolCompatible: true,
        executionModes: ["all_selected", "model_choice"]
      }
    };

    expect(
      decodeCatalogResponse(response)?.models[0].searchOptionCompatibility
    ).toEqual(response.catalog.models[0]!.searchOptionCompatibility);

    const missingCompatibilityBit = structuredClone(response) as unknown as {
      catalog: { models: Array<{ searchOptionCompatibility: Record<string, object> }> };
    };
    missingCompatibilityBit.catalog.models[0]!.searchOptionCompatibility["company-search"] = {
      executionModes: ["all_selected", "model_choice"]
    };
    expect(decodeCatalogResponse(missingCompatibilityBit)).toBeNull();
  });

  it("strictly decodes the optional attachment-limit projection", () => {
    const response = validResponse();
    response.catalog.attachmentLimits = {
      maxCount: 20,
      maxEncodedBytes: 100_663_296,
      maxMaterializedBytes: 67_108_864
    };

    expect(decodeCatalogResponse(response)?.attachmentLimits).toEqual({
      maxCount: 20,
      maxEncodedBytes: 100_663_296,
      maxMaterializedBytes: 67_108_864
    });

    const extended = structuredClone(response) as CatalogResponse & {
      catalog: {
        attachmentLimits: CatalogResponse["catalog"]["attachmentLimits"] & {
          readConcurrency: number;
        };
      };
    };
    extended.catalog.attachmentLimits.readConcurrency = 2;
    expect(decodeCatalogResponse(extended)?.attachmentLimits).toEqual({
      maxCount: 20,
      maxEncodedBytes: 100_663_296,
      maxMaterializedBytes: 67_108_864
    });
  });

  it.each([
    ["missing field", { maxCount: 20, maxMaterializedBytes: 67_108_864 }],
    ["zero", { maxCount: 0, maxEncodedBytes: 100_663_296, maxMaterializedBytes: 67_108_864 }],
    ["fraction", { maxCount: 1.5, maxEncodedBytes: 100_663_296, maxMaterializedBytes: 67_108_864 }],
    ["unsafe integer", {
      maxCount: 20,
      maxEncodedBytes: Number.MAX_SAFE_INTEGER + 1,
      maxMaterializedBytes: 67_108_864
    }],
    ["count above the client ceiling", {
      maxCount: 101,
      maxEncodedBytes: 100_663_296,
      maxMaterializedBytes: 67_108_864
    }],
    ["encoded bytes above the client ceiling", {
      maxCount: 20,
      maxEncodedBytes: 402_653_185,
      maxMaterializedBytes: 67_108_864
    }],
    ["materialized bytes above the client ceiling", {
      maxCount: 20,
      maxEncodedBytes: 100_663_296,
      maxMaterializedBytes: 268_435_457
    }]
  ])("rejects malformed attachment limits: %s", (_label, attachmentLimits) => {
    const response = validResponse() as unknown as {
      catalog: { attachmentLimits: unknown };
    };
    response.catalog.attachmentLimits = attachmentLimits;

    expect(decodeCatalogResponse(response)).toBeNull();
  });

  it("decodes the native Gemini Google Search strategy", () => {
    const response = validResponse();
    response.catalog.searchStrategies = [{
      displayName: "Google Search",
      kind: "gemini_google_search",
      strategyId: "gemini-google-search"
    }];

    expect(decodeCatalogResponse(response)?.searchStrategies).toEqual([{
      displayName: "Google Search",
      kind: "gemini_google_search",
      strategyId: "gemini-google-search"
    }]);
  });

  it("decodes the Anthropic hosted Search route metadata", () => {
    const response = validResponse();
    response.catalog.searchStrategies = [{
      adapterKind: "answer_provider_hosted",
      displayName: "Anthropic Search",
      executionModes: ["model_choice"],
      kind: "anthropic_native_web_search",
      privacy: "answer_provider",
      protocol: "anthropic_web_search",
      revisionId: "anthropic-web-search:configuration-revision:1",
      strategyId: "anthropic-web-search"
    }];

    expect(decodeCatalogResponse(response)?.searchStrategies).toEqual(
      response.catalog.searchStrategies
    );
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

  it("requires the model tool-calling capability", () => {
    const response = validResponse() as unknown as {
      catalog: { models: { capabilities: Record<string, unknown> }[] };
    };
    delete response.catalog.models[0].capabilities.toolCalling;

    expect(decodeCatalogResponse(response)).toBeNull();
  });

  it("requires the persisted tool activity default", () => {
    const response = validResponse() as unknown as {
      catalog: { defaults: Record<string, unknown> };
    };
    delete response.catalog.defaults.showToolActivity;

    expect(decodeCatalogResponse(response)).toBeNull();
  });

  it("keeps unexpected provider routing data out of the shell projection", () => {
    const response = validResponse() as unknown as {
      catalog: CatalogResponse["catalog"] & {
        models: Array<CatalogResponse["catalog"]["models"][number] & {
          routeProviderPreferences: OpenRouterRoutePreferences;
        }>;
      };
    };
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

  it("accepts an explicit empty selection when no deployment is available", () => {
    const response = validResponse();
    response.catalog.defaults.modelId = "";
    response.catalog.defaults.provider = "";
    response.catalog.models = [];
    response.catalog.providers = [];

    expect(decodeCatalogResponse(response)?.defaults).toMatchObject({
      modelId: "",
      provider: ""
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

  it("keeps unexpected technical search-strategy data out of the decoded projection", () => {
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

    expect(decodeCatalogResponse(malformedResponse)?.searchStrategies[0]).toEqual({
      displayName: "No Search",
      kind: "none",
      strategyId: "search-disabled"
    });
  });

  it.each([
    ["model id", (response: CatalogResponse) => (response.catalog.models[0].modelId = "")],
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
