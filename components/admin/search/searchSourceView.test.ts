import type { AdminSearchCatalog, AdminSearchIntegration } from "@/lib/contracts/adminSearch";
import { describe, expect, it } from "vitest";
import {
  configurableModels,
  draftForModel,
  emptySearchForm,
  manuallyAddableModels,
  searchCheckSummary,
  searchExecutionValidation,
  searchFormFrom,
  searchHeaderStatus,
  searchModelOptionLabel,
  searchModelsReach,
  searchModelsReachDetail,
  searchSourceStatus,
  selectablePlanSources,
  sourceIdentityFor
} from "./searchSourceView";

const NOW = new Date("2026-09-07T12:51:00.000Z");

function source(overrides: Partial<AdminSearchIntegration> = {}): AdminSearchIntegration {
  return {
    archivedAt: null,
    broaderModelSetup: "ready",
    configurable: true,
    configuration: {
      adapterKind: "provider_model_client",
      credentialMode: "provider_model",
      maxOutputTokens: 4_096,
      maxResults: 8,
      maxSearchCallsPerAnswer: 2,
      protocol: "openrouter_perplexity_chat",
      providerModelId: "model-sonar",
      queryMaxCharacters: 500,
      reasoningPolicy: "lowest_supported",
      timeoutMs: 300_000
    },
    configurationActive: true,
    description: "Web search through OpenRouter.",
    displayName: "Perplexity Search",
    draftDirty: false,
    draftTestEvidence: null,
    draftVersion: 1,
    enabled: true,
    executionModes: ["all_selected", "model_choice"],
    id: "source-perplexity",
    kind: "perplexity_search",
    providerModel: {
      connectionDisplayName: "OpenRouter",
      connectionId: "conn-openrouter",
      displayName: "Sonar",
      id: "model-sonar"
    },
    ready: true,
    readiness: "ready",
    sourceConnectionId: "conn-openrouter",
    strategyId: "perplexity-search",
    system: false,
    ...overrides
  };
}

describe("searchSourceStatus", () => {
  it("uses one status word per source in priority order", () => {
    expect(searchSourceStatus(source()).label).toBe("Working");
    expect(searchSourceStatus(source({ readiness: "setup_required", ready: false })).label).toBe("Setup needed");
    expect(searchSourceStatus(source({ configurationActive: false })).label).toBe("Setup needed");
    expect(searchSourceStatus(source({ readiness: "source_unavailable", ready: false })).label).toBe("Source unavailable");
    expect(searchSourceStatus(source({ enabled: false, readiness: "source_unavailable", ready: false })).label).toBe("Disabled");
    expect(searchSourceStatus(source({ archivedAt: "2026-09-01T00:00:00.000Z", enabled: false })).label).toBe("Archived");
    expect(searchSourceStatus(source({ readiness: "source_unavailable", ready: false })).tone).toBe("critical");
  });

  it("does not turn a source off because its last check found nothing", () => {
    const checked = source({
      draftTestEvidence: {
        checkedAt: NOW.toISOString(),
        method: "provider_search",
        normalizedSourceCount: 0,
        protocol: "openrouter_perplexity_chat",
        status: "unavailable"
      }
    });
    expect(searchSourceStatus(checked).label).toBe("Working");
    expect(searchCheckSummary(checked, NOW)).toMatchObject({ tone: "warn" });
  });
});

describe("searchModelsReach", () => {
  it("names the chat models a source can serve", () => {
    expect(searchModelsReach(source())).toBe("All chat models");
    expect(searchModelsReach(source({ kind: "web_search", broaderModelSetup: "ready" }))).toBe("All chat models");
    expect(searchModelsReach(source({ kind: "web_search", broaderModelSetup: "setup_required" }))).toBe("This provider's models");
    expect(searchModelsReach(source({ kind: "web_search", broaderModelSetup: "setup_required", ready: false, readiness: "setup_required" }))).toBe("No Search model yet");
    expect(searchModelsReach(source({ kind: "gemini_google_search", broaderModelSetup: "not_applicable" }))).toBe("Gemini models");
  });

  it("points a source that is not set up at the action that exists for it", () => {
    const unready = { ready: false, readiness: "setup_required" as const };
    expect(searchModelsReachDetail(source(unready))).toContain("in Configure");
    expect(searchModelsReachDetail(source({ ...unready, configurable: false, kind: "deepseek_search_api" })))
      .toBe("Adding a key on its provider page sets it up. Add source can also set it up with one of that connection's models.");
    expect(searchModelsReachDetail(source({ ...unready, configurable: false, kind: "web_search" })))
      .toBe("Adding a key on its provider page sets it up.");
  });
});

describe("searchCheckSummary and searchHeaderStatus", () => {
  it("describes the last check in plain words", () => {
    expect(searchCheckSummary(source(), NOW)).toEqual({ checkedAt: null, detail: "Not checked yet", tone: "neutral" });
    const checked = source({
      draftTestEvidence: {
        checkedAt: NOW.toISOString(),
        method: "provider_search",
        normalizedSourceCount: 3,
        protocol: "openrouter_perplexity_chat",
        status: "available"
      }
    });
    const summary = searchCheckSummary(checked, NOW);
    expect(summary.tone).toBe("ok");
    expect(summary.detail).toMatch(/^Checked today \d{1,2}:\d{2} · working, 3 sources found$/u);
    expect(searchHeaderStatus(checked, NOW)).toMatch(/^Working · Sonar on OpenRouter · checked today \d{1,2}:\d{2}$/u);
    expect(searchHeaderStatus(source({ providerModel: null, configurable: false }), NOW))
      .toBe("Working · Managed with its provider · not checked yet");
    for (const text of [summary.detail, searchHeaderStatus(checked, NOW)]) {
      expect(text).not.toMatch(/draft|revision|probe|evidence|version|pending/iu);
    }
  });

  it("ignores configuration-only records that never reached the provider", () => {
    const configured = source({
      draftTestEvidence: {
        checkedAt: NOW.toISOString(),
        method: "configuration",
        normalizedSourceCount: 0,
        protocol: "openrouter_perplexity_chat",
        status: "available"
      }
    });
    expect(searchCheckSummary(configured, NOW).detail).toBe("Not checked yet");
  });
});

describe("plan and form helpers", () => {
  const catalog: AdminSearchCatalog = {
    integrations: [
      source(),
      source({ enabled: false, id: "source-off", strategyId: "off" }),
      source({ id: "source-archived", archivedAt: "2026-09-01T00:00:00.000Z", strategyId: "archived" }),
      source({ id: "source-not-ready", ready: false, readiness: "setup_required", strategyId: "not-ready" })
    ],
    policy: { defaultPlan: { mode: "all_selected", optionIds: [] }, updatedAt: NOW.toISOString(), version: 1 },
    providerModels: [
      {
        connectionDisplayName: "OpenRouter",
        connectionId: "conn-openrouter",
        displayName: "Sonar",
        enabled: true,
        id: "model-sonar",
        searchKind: "perplexity_search",
        searchReasoningSupported: false
      },
      {
        connectionDisplayName: "OpenRouter EU",
        connectionId: "conn-openrouter-eu",
        displayName: "Sonar Pro",
        enabled: true,
        id: "model-sonar-eu",
        searchKind: "perplexity_search",
        searchReasoningSupported: false
      },
      {
        connectionDisplayName: "OpenAI",
        connectionId: "conn-openai",
        displayName: "GPT-5.6 Terra",
        enabled: true,
        id: "model-terra",
        searchKind: "web_search",
        searchReasoningSupported: true
      }
    ]
  };

  it("offers only enabled, working, unarchived sources to the recommended plan", () => {
    expect(selectablePlanSources(catalog).map(({ id }) => id)).toEqual(["source-perplexity"]);
  });

  it("offers a manual source only on a Perplexity model without a live source", () => {
    expect(manuallyAddableModels(catalog).map(({ id }) => id)).toEqual(["model-sonar-eu"]);
  });

  it("lets Configure pick only models on the source's own connection and kind", () => {
    expect(configurableModels(source(), catalog.providerModels).map(({ id }) => id)).toEqual(["model-sonar"]);
    expect(configurableModels({ kind: "web_search", sourceConnectionId: "conn-openai" }, catalog.providerModels)
      .map(({ id }) => id)).toEqual(["model-terra"]);
  });

  it("validates the advanced execution inputs as typed", () => {
    const form = searchFormFrom(source());
    expect(searchExecutionValidation(form).valid).toBe(true);
    expect(searchExecutionValidation({
      ...form,
      executionInputs: { maxOutputTokens: "12", maxSearchCallsPerAnswer: "33" }
    })).toEqual({
      maxOutputTokens: "Enter a whole number of at least 16, or leave blank for Auto.",
      maxSearchCallsPerAnswer: "Enter a whole number from 1 to 32.",
      valid: false
    });
    expect(searchExecutionValidation({ ...form,
      executionInputs: { maxOutputTokens: "8193", maxSearchCallsPerAnswer: "32" }
    }).valid).toBe(true);
  });

  it("starts new sources with research-capable defaults and preserves saved settings when changing models", () => {
    const fresh = emptySearchForm();
    expect(fresh.draft).toMatchObject({ maxOutputTokens: null, maxSearchCallsPerAnswer: 8,
      queryMaxCharacters: 1_000, timeoutMs: 120_000 });
    const saved = searchFormFrom(source());
    expect(saved.draft).toMatchObject({ maxOutputTokens: 4_096, maxSearchCallsPerAnswer: 2,
      queryMaxCharacters: 500, timeoutMs: 300_000 });
    expect(draftForModel(catalog.providerModels[0]!, saved.draft)).toMatchObject({
      maxOutputTokens: 4_096, maxSearchCallsPerAnswer: 2, queryMaxCharacters: 500, timeoutMs: 300_000
    });
  });
});

describe("DeepSeek Search API choices", () => {
  const hosted = {
    connectionDisplayName: "DeepSeek", connectionId: "conn-deepseek", displayName: "DeepSeek V4 Flash", enabled: true,
    id: "model-flash", searchKind: "deepseek_web_search", searchReasoningSupported: true
  } as const;
  const carrier = { ...hosted, searchKind: "deepseek_search_api", searchReasoningSupported: false } as const;
  const apiSource = source({
    broaderModelSetup: "not_applicable",
    configuration: { ...source().configuration!, maxOutputTokens: null, protocol: "deepseek_search_api",
      providerModelId: "model-flash", queryMaxCharacters: 128 },
    description: "Web results with source links from the DeepSeek Search API.",
    displayName: "DeepSeek Search API",
    id: "source-deepseek-api",
    kind: "deepseek_search_api",
    providerModel: { connectionDisplayName: "DeepSeek", connectionId: "conn-deepseek", displayName: "DeepSeek V4 Flash", id: "model-flash" },
    sourceConnectionId: "conn-deepseek",
    strategyId: "deepseek-search-api"
  });
  const catalog = (integrations: AdminSearchIntegration[]): AdminSearchCatalog => ({
    integrations,
    policy: { defaultPlan: { mode: "all_selected", optionIds: [] }, updatedAt: NOW.toISOString(), version: 1 },
    providerModels: [hosted, carrier]
  });

  it("offers the API on a DeepSeek connection until it has a live API source", () => {
    expect(manuallyAddableModels(catalog([])).map(({ id, searchKind }) => `${searchKind}:${id}`))
      .toEqual(["deepseek_search_api:model-flash"]);
    expect(manuallyAddableModels(catalog([apiSource]))).toEqual([]);
    // A built-in that setup skipped (switched off before the key) has no route
    // to configure: Add source completes it instead of leaving it stuck.
    const skipped = { ...apiSource, configurable: false, configuration: null, enabled: false, providerModel: null,
      ready: false, readiness: "setup_required" as const, system: true };
    expect(manuallyAddableModels(catalog([skipped])).map(({ id }) => id)).toEqual(["model-flash"]);
    expect(searchModelOptionLabel(carrier)).toBe("DeepSeek Search API · key via DeepSeek V4 Flash");
    expect(sourceIdentityFor(carrier)).toEqual({
      description: "Web results with source links from the DeepSeek Search API.",
      displayName: "DeepSeek Search API"
    });
  });

  it("drafts the raw results protocol within the API's query bound and keeps each source to its own choice", () => {
    expect(draftForModel(carrier, { ...emptySearchForm().draft, maxOutputTokens: 4_096 })).toMatchObject({
      maxOutputTokens: null, protocol: "deepseek_search_api", providerModelId: "model-flash", queryMaxCharacters: 128
    });
    // The same model is listed for its hosted Search and as an API key carrier.
    expect(configurableModels(apiSource, [hosted, carrier])).toEqual([carrier]);
    expect(configurableModels({ kind: "web_search", sourceConnectionId: "conn-deepseek" }, [hosted, carrier]))
      .toEqual([hosted]);
  });

  it("reaches every chat model and hides the model-reply limit", () => {
    expect(searchModelsReach(apiSource)).toBe("All chat models");
    expect(searchHeaderStatus(apiSource, NOW)).toBe("Working · DeepSeek Search API, key via DeepSeek V4 Flash · not checked yet");
    const form = searchFormFrom(apiSource);
    expect(searchExecutionValidation({ ...form, executionInputs: { ...form.executionInputs, maxOutputTokens: "12" } }))
      .toEqual({ maxOutputTokens: null, maxSearchCallsPerAnswer: null, valid: true });
  });
});
