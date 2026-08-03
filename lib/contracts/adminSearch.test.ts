import { describe, expect, it } from "vitest";
import {
  decodeAdminSearchCatalog,
  decodeAdminSearchDraft
} from "./adminSearch";

const legacyDraft = {
  adapterKind: "provider_model_client",
  credentialMode: "provider_model",
  maxResults: 8,
  protocol: "openai_responses_web_search",
  providerModelId: "search-model-1",
  queryMaxCharacters: 500,
  timeoutMs: 300_000
};

function catalog(configuration: unknown, providerModels: unknown[] = []) {
  return {
    search: {
      integrations: [{
        archivedAt: null,
        broaderModelSetup: "ready",
        configurable: true,
        configuration,
        configurationActive: true,
        description: "Web evidence",
        displayName: "OpenAI Search",
        draftDirty: false,
        draftTestEvidence: null,
        draftVersion: 1,
        enabled: true,
        executionModes: ["all_selected", "model_choice"],
        id: "source-1",
        kind: "web_search",
        providerModel: {
          connectionDisplayName: "OpenAI",
          connectionId: "connection-1",
          displayName: "Search model",
          id: "search-model-1"
        },
        ready: true,
        readiness: "ready",
        sourceConnectionId: "connection-1",
        strategyId: "openai-native-web-search",
        system: true
      }],
      policy: {
        defaultPlan: { mode: "all_selected", optionIds: [] },
        updatedAt: "2026-08-03T12:00:00.000Z",
        version: 1
      },
      providerModels
    }
  };
}

describe("administrator Search contract", () => {
  it("synthesizes execution defaults when an existing revision omits them", () => {
    expect(decodeAdminSearchDraft(legacyDraft)).toEqual({
      ...legacyDraft,
      maxOutputTokens: 4_096,
      maxSearchCallsPerAnswer: 2,
      reasoningPolicy: "lowest_supported"
    });
    expect(decodeAdminSearchCatalog(catalog(legacyDraft))?.integrations[0]?.configuration)
      .toMatchObject({
        maxOutputTokens: 4_096,
        maxSearchCallsPerAnswer: 2,
        reasoningPolicy: "lowest_supported"
      });
    expect(decodeAdminSearchCatalog(catalog(legacyDraft, [{
      connectionDisplayName: "OpenAI",
      connectionId: "connection-1",
      displayName: "Search model",
      enabled: true,
      id: "search-model-1",
      searchKind: "web_search"
    }]))?.providerModels[0]).toMatchObject({ searchReasoningSupported: false });
  });

  it("accepts bounded explicit controls and rejects invalid execution policy", () => {
    expect(decodeAdminSearchDraft({
      ...legacyDraft,
      maxOutputTokens: 32_768,
      maxSearchCallsPerAnswer: 4,
      reasoningPolicy: "provider_default"
    })).toMatchObject({
      maxOutputTokens: 32_768,
      maxSearchCallsPerAnswer: 4,
      reasoningPolicy: "provider_default"
    });
    expect(decodeAdminSearchDraft({ ...legacyDraft, maxOutputTokens: 1_023 })).toBeNull();
    expect(decodeAdminSearchDraft({ ...legacyDraft, maxSearchCallsPerAnswer: 5 })).toBeNull();
    expect(decodeAdminSearchDraft({ ...legacyDraft, reasoningPolicy: "answer_default" })).toBeNull();
    expect(decodeAdminSearchCatalog(catalog({
      ...legacyDraft,
      maxOutputTokens: 32_769
    }))).toBeNull();
    expect(decodeAdminSearchCatalog(catalog(legacyDraft, [{
      connectionDisplayName: "OpenAI",
      connectionId: "connection-1",
      displayName: "Search model",
      enabled: true,
      id: "search-model-1",
      searchKind: "web_search",
      searchReasoningSupported: true
    }]))?.providerModels[0]).toMatchObject({ searchReasoningSupported: true });
  });
});
