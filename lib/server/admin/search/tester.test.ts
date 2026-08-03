import { describe, expect, it } from "vitest";
import type { AdminSearchDraft } from "../../../contracts/adminSearch";
import type { ProviderModelCapabilities } from "../../providers/types";
import { adminSearchProviderPolicy } from "./tester";

const capabilities: ProviderModelCapabilities = {
  nativePdfInput: false,
  nativeSearch: true,
  pdf: false,
  reasoning: true,
  reasoningEfforts: ["low", "medium", "high"],
  streaming: true,
  toolCalling: true,
  vision: false
};

function draft(protocol: AdminSearchDraft["protocol"]): AdminSearchDraft {
  return {
    adapterKind: "provider_model_client",
    credentialMode: "provider_model",
    maxOutputTokens: 4_096,
    maxResults: 8,
    maxSearchCallsPerAnswer: 2,
    protocol,
    providerModelId: "technical-model",
    queryMaxCharacters: 500,
    reasoningPolicy: "lowest_supported",
    timeoutMs: 300_000
  };
}

describe("admin Search diagnostic policies", () => {
  it("builds the query-only Gemini policy from the exact draft and model", () => {
    expect(adminSearchProviderPolicy({
      capabilities,
      defaultParams: {},
      draft: draft("gemini_google_search"),
      modelId: "gemini-3.6-flash",
      provider: "gemini"
    })).toEqual({
      maxOutputTokens: 4_096,
      modelCapabilities: capabilities,
      modelId: "gemini-3.6-flash",
      provider: "gemini",
      reasoningPolicy: "lowest_supported",
      strategyId: "gemini-google-search"
    });
  });

  it("keeps OpenAI and Perplexity diagnostics on their typed client policies", () => {
    expect(adminSearchProviderPolicy({
      capabilities,
      defaultParams: {},
      draft: draft("openai_responses_web_search"),
      modelId: "gpt-5.6-terra",
      provider: "openai"
    })).toMatchObject({
      modelId: "gpt-5.6-terra",
      provider: "openai",
      strategyId: "openai-responses-web-search"
    });
    expect(adminSearchProviderPolicy({
      capabilities,
      defaultParams: { routing: "private" },
      draft: draft("openrouter_perplexity_chat"),
      modelId: "perplexity/sonar-pro-search",
      provider: "openrouter"
    })).toMatchObject({
      defaultParams: {
        maxOutputTokens: 4_096,
        routing: "private",
        stream: false,
        temperature: 0
      },
      modelId: "perplexity/sonar-pro-search",
      provider: "openrouter",
      strategyId: "perplexity-tool-search"
    });
  });

  it("rejects a protocol on the wrong provider family", () => {
    expect(() => adminSearchProviderPolicy({
      capabilities,
      defaultParams: {},
      draft: draft("gemini_google_search"),
      modelId: "not-gemini",
      provider: "openai"
    })).toThrow("search_protocol_not_supported");
  });
});
