import { describe, expect, it } from "vitest";
import {
  compatibleTechnicalAdapter,
  normalizeSearchDraft,
  searchDraftHash,
  searchExecutionModes
} from "./configuration";

const legacyClientDraft = {
  adapterKind: "provider_model_client",
  credentialMode: "provider_model",
  maxResults: 8,
  protocol: "openai_responses_web_search",
  providerModelId: "technical-model",
  queryMaxCharacters: 500,
  timeoutMs: 15_000
} as const;

const clientDraft = {
  ...legacyClientDraft,
  maxOutputTokens: 8_192,
  maxSearchCallsPerAnswer: 3,
  reasoningPolicy: "provider_default"
} as const;

describe("Search adapter configuration", () => {
  it("normalizes a bounded provider-model client integration", () => {
    expect(normalizeSearchDraft(clientDraft)).toEqual(clientDraft);
    expect(normalizeSearchDraft({ ...clientDraft, timeoutMs: 300_000 }).timeoutMs).toBe(300_000);
    expect(searchExecutionModes(clientDraft.adapterKind)).toEqual(["all_selected", "model_choice"]);
  });

  it("synthesizes conservative execution defaults for existing revisions", () => {
    expect(normalizeSearchDraft(legacyClientDraft)).toEqual({
      ...legacyClientDraft,
      maxOutputTokens: 4_096,
      maxSearchCallsPerAnswer: 2,
      reasoningPolicy: "lowest_supported"
    });
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
});
