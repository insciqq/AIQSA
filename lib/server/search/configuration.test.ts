import { describe, expect, it } from "vitest";
import {
  compatibleTechnicalAdapter,
  normalizeSearchDraft,
  searchDraftHash,
  searchExecutionModes
} from "./configuration";

const clientDraft = {
  adapterKind: "provider_model_client",
  credentialMode: "provider_model",
  maxResults: 8,
  protocol: "openai_responses_web_search",
  providerModelId: "technical-model",
  queryMaxCharacters: 500,
  timeoutMs: 15_000
} as const;

describe("Search adapter configuration", () => {
  it("normalizes a bounded provider-model client integration", () => {
    expect(normalizeSearchDraft(clientDraft)).toEqual(clientDraft);
    expect(searchExecutionModes(clientDraft.adapterKind)).toEqual(["all_selected", "model_choice"]);
  });

  it("rejects arbitrary protocols, mismatched credential modes, and unsafe bounds", () => {
    expect(() => normalizeSearchDraft({ ...clientDraft, protocol: "http_template" })).toThrow(
      "search_configuration_invalid"
    );
    expect(() => normalizeSearchDraft({ ...clientDraft, credentialMode: "answer_provider" })).toThrow(
      "search_configuration_invalid"
    );
    expect(() => normalizeSearchDraft({ ...clientDraft, timeoutMs: 300_000 })).toThrow(
      "search_configuration_invalid"
    );
  });

  it("uses a canonical fingerprint and protocol-owned technical adapter matrix", () => {
    expect(searchDraftHash(clientDraft)).toBe(searchDraftHash({ ...clientDraft }));
    expect(compatibleTechnicalAdapter("openai_responses_web_search", "openai_responses_compatible")).toBe(true);
    expect(compatibleTechnicalAdapter("openai_responses_web_search", "openai_chat_completions_compatible")).toBe(false);
  });
});
