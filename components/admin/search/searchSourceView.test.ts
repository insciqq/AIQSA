import type { AdminSearchCatalog, AdminSearchIntegration } from "@/lib/contracts/adminSearch";
import { describe, expect, it } from "vitest";
import {
  configurableModels,
  draftForModel,
  emptySearchForm,
  manuallyAddableModels,
  searchCheckSummary,
  searchDefaultOrderText,
  searchEngineCandidates,
  searchEngineRole,
  searchEngineRoleLabel,
  searchEngineSetupDetail,
  searchExecutionValidation,
  searchFormFrom,
  searchHeaderStatus,
  searchModelOptionKey,
  searchModelOptionLabel,
  searchSourceStatus,
  selectedSearchModel,
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
      protocol: "anthropic_web_search",
      providerModelId: "model-haiku",
      queryMaxCharacters: 500,
      reasoningPolicy: "lowest_supported",
      timeoutMs: 300_000
    },
    configurationActive: true,
    description: "Web search through Anthropic.",
    displayName: "Anthropic Search",
    draftDirty: false,
    draftTestEvidence: null,
    draftVersion: 1,
    enabled: true,
    executionModes: ["all_selected", "model_choice"],
    id: "source-anthropic",
    kind: "web_search",
    providerModel: {
      connectionDisplayName: "Anthropic",
      connectionId: "conn-anthropic",
      displayName: "Claude Haiku 5.5",
      id: "model-haiku"
    },
    ready: true,
    readiness: "ready",
    sourceConnectionId: "conn-anthropic",
    strategyId: "anthropic-search",
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
        protocol: "anthropic_web_search",
        status: "unavailable"
      }
    });
    expect(searchSourceStatus(checked).label).toBe("Working");
    expect(searchCheckSummary(checked, NOW)).toMatchObject({ tone: "warn" });
  });
});

describe("the installation's engine", () => {
  const policy = (overrides: Partial<AdminSearchCatalog["policy"]> = {}): AdminSearchCatalog["policy"] => ({
    backupOptionId: null,
    defaultPlan: { mode: "all_selected", optionIds: [] },
    engineOptionId: null,
    inAnswerSearch: true,
    resolved: { automatic: true, backupOptionId: null, engineOptionId: "anthropic-search", reason: null },
    updatedAt: NOW.toISOString(),
    version: 1,
    ...overrides
  });

  it("offers as engine or backup only turned-on sources that search for every model", () => {
    const catalog: AdminSearchCatalog = {
      integrations: [
        source(),
        source({ enabled: false, id: "off", strategyId: "off" }),
        source({ archivedAt: NOW.toISOString(), id: "archived", strategyId: "archived" }),
        // OpenAI search inside GPT answers only: no Search model of its own.
        source({ executionModes: ["model_choice"], id: "hosted", kind: "web_search", strategyId: "hosted" })
      ],
      policy: policy(),
      providerModels: []
    };
    expect(searchEngineCandidates(catalog).map(({ id }) => id)).toEqual(["source-anthropic"]);
  });

  it("names the engine the order picked, the chosen engine and the backup", () => {
    expect(searchEngineRole(source(), policy())).toBe("engine");
    expect(searchEngineRoleLabel("engine", policy())).toBe("Engine (automatic)");
    const chosen = policy({ backupOptionId: "anthropic-search", engineOptionId: "deepseek" });
    expect(searchEngineRole(source(), chosen)).toBe("backup");
    expect(searchEngineRole(source({ strategyId: "deepseek" }), chosen)).toBe("engine");
    expect(searchEngineRoleLabel("engine", chosen)).toBe("Engine");
    expect(searchEngineRole(source({ strategyId: "other" }), chosen)).toBeNull();
    expect(searchEngineRoleLabel(null, chosen)).toBeNull();
    // An older server without the resolution: nothing is named.
    expect(searchEngineRole(source(), { defaultPlan: { mode: "all_selected", optionIds: [] }, updatedAt: "", version: 1 })).toBeNull();
  });

  it("writes the default order in words", () => {
    expect(searchDefaultOrderText()).toBe(
      "OpenAI web search, OpenRouter with Perplexity, DeepSeek Search API, Gemini Google Search, Anthropic web search"
    );
  });

  it("points a source that cannot be the engine at the action that exists for it", () => {
    const unready = { executionModes: [], ready: false, readiness: "setup_required" as const };
    expect(searchEngineSetupDetail(source())).toBeNull();
    expect(searchEngineSetupDetail(source(unready))).toContain("in Configure");
    expect(searchEngineSetupDetail(source({ ...unready, configurable: false, kind: "deepseek_search_api" })))
      .toBe("Adding a key on its provider page sets it up. Add source can also set it up with one of that connection's models.");
    expect(searchEngineSetupDetail(source({ ...unready, configurable: false, kind: "web_search" })))
      .toBe("Adding a key on its provider page sets it up.");
    expect(searchEngineSetupDetail(source({ executionModes: ["model_choice"], kind: "web_search" })))
      .toContain("Only GPT answers on this connection can search with it now.");
    expect(searchEngineSetupDetail(source({ enabled: false, ...unready }))).toBeNull();
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
        protocol: "anthropic_web_search",
        status: "available"
      }
    });
    const summary = searchCheckSummary(checked, NOW);
    expect(summary.tone).toBe("ok");
    expect(summary.detail).toMatch(/^Checked today \d{1,2}:\d{2} · working, 3 sources found$/u);
    expect(searchHeaderStatus(checked, NOW)).toMatch(/^Working · Claude Haiku 5.5 on Anthropic · checked today \d{1,2}:\d{2}$/u);
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
        protocol: "anthropic_web_search",
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
        connectionDisplayName: "Anthropic",
        connectionId: "conn-anthropic",
        displayName: "Claude Haiku 5.5",
        enabled: true,
        id: "model-haiku",
        searchKind: "anthropic_web_search",
        searchReasoningSupported: false
      },
      {
        connectionDisplayName: "OpenRouter EU",
        connectionId: "conn-openrouter-eu",
        displayName: "GPT-6 Luna",
        enabled: true,
        id: "model-luna-eu",
        searchKind: "openrouter_web_search",
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

  it("offers a manual source only on an OpenRouter or DeepSeek model without a live source", () => {
    expect(manuallyAddableModels(catalog).map(({ id }) => id)).toEqual(["model-luna-eu"]);
  });

  it("lets Configure pick only models on the source's own connection and kind", () => {
    expect(configurableModels(source(), catalog.providerModels).map(({ id }) => id)).toEqual(["model-haiku"]);
    expect(configurableModels({ kind: "web_search", sourceConnectionId: "conn-openai" }, catalog.providerModels)
      .map(({ id }) => id)).toEqual(["model-terra"]);
  });

  it("validates the advanced execution inputs as typed", () => {
    const form = searchFormFrom(source());
    expect(searchExecutionValidation(form).valid).toBe(true);
    expect(searchExecutionValidation({
      ...form,
      executionInputs: { maxOutputTokens: "12" }
    })).toEqual({
      maxOutputTokens: "Enter a whole number of at least 16, or leave blank for Auto.",
      valid: false
    });
    expect(searchExecutionValidation({ ...form,
      executionInputs: { maxOutputTokens: "8193" }
    }).valid).toBe(true);
  });

  it("starts new sources with research-capable defaults and preserves saved settings when changing models", () => {
    const fresh = emptySearchForm();
    expect(fresh.draft).toMatchObject({ maxOutputTokens: null,
      queryMaxCharacters: 1_000, timeoutMs: 120_000 });
    const saved = searchFormFrom(source());
    expect(saved.draft).toMatchObject({ maxOutputTokens: 4_096,
      queryMaxCharacters: 500, timeoutMs: 300_000 });
    expect(draftForModel(catalog.providerModels[0]!, saved.draft)).toMatchObject({
      maxOutputTokens: 4_096, queryMaxCharacters: 500, timeoutMs: 300_000
    });
  });
});

describe("OpenRouter web search choices", () => {
  const technical = {
    connectionDisplayName: "OpenRouter", connectionId: "conn-openrouter", displayName: "DeepSeek V4.1 Flash", enabled: true,
    id: "model-flash", searchKind: "openrouter_web_search", searchReasoningSupported: false
  } as const;

  it("offers OpenRouter web search on a connection without a web source and keys each choice by kind", () => {
    const catalog: AdminSearchCatalog = {
      integrations: [source()],
      policy: { defaultPlan: { mode: "all_selected", optionIds: [] }, updatedAt: NOW.toISOString(), version: 1 },
      providerModels: [technical]
    };
    // The OpenRouter connection has no web source yet.
    expect(manuallyAddableModels(catalog).map(searchModelOptionKey)).toEqual(["openrouter_web_search:model-flash"]);
    const withWeb = { ...catalog, integrations: [source(),
      source({ id: "web", kind: "web_search", sourceConnectionId: "conn-openrouter", strategyId: "web" })] };
    expect(manuallyAddableModels(withWeb)).toEqual([]);
    expect(searchModelOptionLabel(technical)).toBe("OpenRouter web search · DeepSeek V4.1 Flash");
    expect(sourceIdentityFor(technical)).toEqual({
      description: "Web results with source links through OpenRouter web search.",
      displayName: "OpenRouter Web Search"
    });
    // A model listed for another Search kind too is chosen under the configuration's own protocol.
    const sameModel = { ...technical, searchKind: "deepseek_search_api" } as const;
    expect(selectedSearchModel({ protocol: "openrouter_web_search", providerModelId: "model-flash" }, [sameModel, technical]))
      .toBe(technical);
  });

  it("hides the reply limit and drafts it as Auto", () => {
    const form = searchFormFrom(source({ configuration: { ...draftForModel(technical), maxOutputTokens: null } }));
    expect(draftForModel(technical, { ...emptySearchForm().draft, maxOutputTokens: 4_096 }).maxOutputTokens).toBeNull();
    expect(searchExecutionValidation({ ...form, executionInputs: { maxOutputTokens: "12" } }))
      .toEqual({ maxOutputTokens: null, valid: true });
  });

  it("lets Configure switch the technical model of the connection's web source and keeps its engine", () => {
    expect(configurableModels({ kind: "web_search", sourceConnectionId: "conn-openrouter" }, [technical])).toEqual([technical]);
    expect(draftForModel(technical, { ...emptySearchForm().draft, openRouterWebSearch: { engine: "exa", mode: "deep" } })).toMatchObject({
      openRouterWebSearch: { engine: "exa", mode: "deep" }, protocol: "openrouter_web_search", providerModelId: "model-flash"
    });
    expect(draftForModel(technical).openRouterWebSearch).toEqual({ engine: "perplexity", mode: null });
  });
});

describe("DeepSeek Search API choices", () => {
  const carrier = {
    connectionDisplayName: "DeepSeek", connectionId: "conn-deepseek", displayName: "DeepSeek V4 Flash", enabled: true,
    id: "model-flash", searchKind: "deepseek_search_api", searchReasoningSupported: false
  } as const;
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
    providerModels: [carrier]
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
    // A key carrier configures only the API source.
    expect(configurableModels(apiSource, [carrier])).toEqual([carrier]);
    expect(configurableModels({ kind: "web_search", sourceConnectionId: "conn-deepseek" }, [carrier])).toEqual([]);
  });

  it("hides the model-reply limit", () => {
    expect(searchHeaderStatus(apiSource, NOW)).toBe("Working · DeepSeek Search API, key via DeepSeek V4 Flash · not checked yet");
    const form = searchFormFrom(apiSource);
    expect(searchExecutionValidation({ ...form, executionInputs: { ...form.executionInputs, maxOutputTokens: "12" } }))
      .toEqual({ maxOutputTokens: null, valid: true });
  });
});
