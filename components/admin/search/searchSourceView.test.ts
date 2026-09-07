import type { AdminSearchCatalog, AdminSearchIntegration } from "@/lib/contracts/adminSearch";
import { describe, expect, it } from "vitest";
import {
  configurableModels,
  manuallyAddableModels,
  searchCheckSummary,
  searchExecutionValidation,
  searchFormFrom,
  searchHeaderStatus,
  searchModelsReach,
  searchSourceStatus,
  selectablePlanSources
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
      executionInputs: { maxOutputTokens: "12", maxSearchCallsPerAnswer: "9" }
    })).toEqual({
      maxOutputTokens: "Enter a whole number from 1,024 to 32,768.",
      maxSearchCallsPerAnswer: "Enter a whole number from 1 to 4.",
      valid: false
    });
  });
});
