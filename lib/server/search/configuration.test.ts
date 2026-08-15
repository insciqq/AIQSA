import { describe, expect, it } from "vitest";
import {
  builtInSearchDraft,
  compatibleTechnicalAdapter,
  searchStrategyKind,
  normalizeSearchDraft,
  searchDraftHash,
  searchExecutionModes
} from "./configuration";

const clientDraft = {
  adapterKind: "provider_model_client",
  credentialMode: "provider_model",
  maxOutputTokens: 8_192,
  maxResults: 8,
  maxSearchCallsPerAnswer: 3,
  protocol: "openai_responses_web_search",
  providerModelId: "technical-model",
  queryMaxCharacters: 500,
  reasoningPolicy: "provider_default",
  timeoutMs: 15_000
} as const;

describe("Search adapter configuration", () => {
  it("normalizes a bounded provider-model client integration", () => {
    expect(normalizeSearchDraft(clientDraft)).toEqual(clientDraft);
    expect(normalizeSearchDraft({ ...clientDraft, timeoutMs: 300_000 }).timeoutMs).toBe(300_000);
    expect(searchExecutionModes(clientDraft.adapterKind)).toEqual(["all_selected", "model_choice"]);
  });

  it("requires every current execution field", () => {
    for (const key of [
      "maxOutputTokens",
      "maxResults",
      "maxSearchCallsPerAnswer",
      "providerModelId",
      "queryMaxCharacters",
      "reasoningPolicy",
      "timeoutMs"
    ] as const) {
      const incomplete = { ...clientDraft } as Record<string, unknown>;
      delete incomplete[key];
      expect(() => normalizeSearchDraft(incomplete)).toThrow("search_configuration_invalid");
    }
  });

  it("rejects arbitrary protocols, mismatched credential modes, and unsafe bounds", () => {
    expect(() => normalizeSearchDraft({ ...clientDraft, protocol: "http_template" })).toThrow(
      "search_configuration_invalid"
    );
    expect(() => normalizeSearchDraft({ ...clientDraft, credentialMode: "answer_provider" })).toThrow(
      "search_configuration_invalid"
    );
    expect(() => normalizeSearchDraft({ ...clientDraft, timeoutMs: 900_001 })).toThrow(
      "search_configuration_invalid"
    );
    expect(() => normalizeSearchDraft({ ...clientDraft, maxOutputTokens: 1_023 })).toThrow(
      "search_configuration_invalid"
    );
    expect(() => normalizeSearchDraft({ ...clientDraft, maxOutputTokens: 32_769 })).toThrow(
      "search_configuration_invalid"
    );
    expect(() => normalizeSearchDraft({ ...clientDraft, maxSearchCallsPerAnswer: 5 })).toThrow(
      "search_configuration_invalid"
    );
    expect(() => normalizeSearchDraft({ ...clientDraft, reasoningPolicy: "answer_default" })).toThrow(
      "search_configuration_invalid"
    );
  });

  it("uses a canonical fingerprint and protocol-owned technical adapter matrix", () => {
    expect(searchDraftHash(clientDraft)).toBe(searchDraftHash({ ...clientDraft }));
    expect(compatibleTechnicalAdapter("openai_responses_web_search", "openai_responses_compatible")).toBe(true);
    expect(compatibleTechnicalAdapter("openai_responses_web_search", "openai_chat_completions_compatible")).toBe(false);
  });

  it("normalizes Anthropic hosted and query-only Search without conflating their physical kinds", () => {
    const hosted = {
      adapterKind: "answer_provider_hosted",
      credentialMode: "answer_provider",
      maxOutputTokens: 4_096,
      maxResults: 8,
      maxSearchCallsPerAnswer: 2,
      protocol: "anthropic_web_search",
      providerModelId: null,
      queryMaxCharacters: 500,
      reasoningPolicy: "provider_default",
      timeoutMs: 300_000
    } as const;
    const client = {
      ...hosted,
      adapterKind: "provider_model_client",
      credentialMode: "provider_model",
      providerModelId: "anthropic-search-model",
      reasoningPolicy: "lowest_supported"
    } as const;

    expect(normalizeSearchDraft(hosted)).toEqual(hosted);
    expect(normalizeSearchDraft(client)).toEqual(client);
    expect(searchStrategyKind(hosted.protocol, hosted.adapterKind)).toBe(
      "anthropic_native_web_search"
    );
    expect(searchStrategyKind(client.protocol, client.adapterKind)).toBe(
      "provider_model_web_search"
    );
    expect(compatibleTechnicalAdapter(hosted.protocol, "anthropic_messages")).toBe(true);
    expect(compatibleTechnicalAdapter(hosted.protocol, "openai_responses_native")).toBe(false);
    expect(builtInSearchDraft({
      config: { tool: "web_search_20250305" },
      kind: "anthropic_native_web_search"
    })).toMatchObject({
      adapterKind: "answer_provider_hosted",
      credentialMode: "answer_provider",
      protocol: "anthropic_web_search",
      providerModelId: null
    });
  });
});
