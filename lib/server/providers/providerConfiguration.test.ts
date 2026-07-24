import { describe, expect, it } from "vitest";
import {
  normalizeProviderConnectionConfiguration,
  normalizeProviderModelConfiguration,
  providerRequestEndpoint,
  ProviderConfigurationError
} from "./providerConfiguration";

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
      apiRoot: "https://api.example.test/v1///"
    });

    expect(configuration).toEqual({
      allowPrivateNetwork: false,
      apiRoot: "https://api.example.test/v1"
    });
    expect(providerRequestEndpoint(configuration, "openai_responses_compatible"))
      .toBe("https://api.example.test/v1/responses");
    expect(providerRequestEndpoint(configuration, "openai_chat_completions_compatible"))
      .toBe("https://api.example.test/v1/chat/completions");
    expect(providerRequestEndpoint(configuration, "anthropic_messages"))
      .toBe("https://api.example.test/v1/messages");
  });

  it("allows HTTP only for an explicit internal-network connection", () => {
    expect(
      normalizeProviderConnectionConfiguration({
        allowPrivateNetwork: true,
        apiRoot: "http://127.0.0.1:11434/v1"
      })
    ).toMatchObject({ apiRoot: "http://127.0.0.1:11434/v1" });

    expectCode(
      () => normalizeProviderConnectionConfiguration({
        allowPrivateNetwork: false,
        apiRoot: "http://127.0.0.1:11434/v1"
      }),
      "provider_api_root_invalid"
    );
  });

  it.each([
    "ftp://api.example.test/v1",
    "https://user:pass@api.example.test/v1",
    "https://api.example.test/v1?key=secret",
    "https://api.example.test/v1#fragment"
  ])("rejects unsafe API root %s", (apiRoot) => {
    expectCode(
      () => normalizeProviderConnectionConfiguration({ allowPrivateNetwork: false, apiRoot }),
      "provider_api_root_invalid"
    );
  });
});

describe("provider model configuration", () => {
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
      capabilities,
      defaultParams: { maxTokens: 2048 },
      upstreamModelId: "local-model"
    });
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
      dataCollection: "deny",
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
});
