import { describe, expect, it } from "vitest";
import { validateRunParams } from "../../../domain/runParams";
import { assistantRunControlIssue } from "../../assistants/runControlMaterialization";
import {
  normalizeProviderModelConfiguration,
  type ProviderModelConfiguration
} from "../../providers/providerConfiguration";
import { configuredModelParameterControls } from "../../providers/providerModelCapabilities";
import { listedReasoningMandatory, withListedReasoningRequirement } from "./openRouterReasoning";

function openRouterModel(
  upstreamModelId = "z-ai/glm-5.3",
  overrides: Partial<ProviderModelConfiguration> = {}
): ProviderModelConfiguration {
  return normalizeProviderModelConfiguration({
    adapterKind: "openrouter_chat_completions",
    answerSelectable: true,
    capabilities: { nativePdfInput: false, nativeSearch: false, pdf: true, reasoning: true, streaming: true,
      toolCalling: true, vision: false },
    defaultParams: {},
    modelClass: "answer",
    openRouterRouting: { mode: "automatic", providers: [] },
    upstreamModelId,
    ...overrides
  });
}

const efforts = (configuration: ProviderModelConfiguration) =>
  configuredModelParameterControls(configuration, "openrouter").reasoningEffort;

describe("OpenRouter mandatory reasoning from the models listing", () => {
  it("reads the exact model's flag and keeps a missing model or flag unknown", () => {
    const listing = [
      { id: "z-ai/glm-5.3", reasoningMandatory: true },
      { id: "z-ai/glm-5.2", reasoningMandatory: false },
      { id: "z-ai/glm-5.1" }
    ];
    expect(listedReasoningMandatory(listing, "z-ai/glm-5.3")).toBe(true);
    expect(listedReasoningMandatory(listing, "z-ai/glm-5.2")).toBe(false);
    expect(listedReasoningMandatory(listing, "z-ai/glm-5.1")).toBeUndefined();
    expect(listedReasoningMandatory(listing, "z-ai/glm-6")).toBeUndefined();
    expect(listedReasoningMandatory(undefined, "z-ai/glm-5.3")).toBeUndefined();
  });

  it("never offers Off for a model that always reasons and keeps the other levels and the default", () => {
    const before = openRouterModel();
    expect(efforts(before)).toMatchObject({ defaultValue: "medium", options: ["none", "low", "medium", "high"] });
    const narrowed = withListedReasoningRequirement(before, true);
    expect(narrowed.capabilities).toMatchObject({ defaultReasoningEffort: "medium", reasoningEfforts: ["low", "medium", "high"] });
    expect(efforts(narrowed)).toEqual({ defaultValue: "medium", options: ["low", "medium", "high"], supported: true });
    // The narrowed capabilities are a valid saved shape and stable on the next check.
    expect(normalizeProviderModelConfiguration(narrowed)).toEqual(narrowed);
    expect(withListedReasoningRequirement(narrowed, true)).toBe(narrowed);
  });

  it("moves an Off default to medium and keeps an administrator's other saved levels", () => {
    const offDefault = openRouterModel(undefined, { defaultParams: { reasoning: { effort: "none" } } });
    expect(efforts(offDefault).defaultValue).toBe("none");
    expect(efforts(withListedReasoningRequirement(offDefault, true)).defaultValue).toBe("medium");

    const saved = openRouterModel(undefined, { capabilities: { ...openRouterModel().capabilities,
      defaultReasoningEffort: "none", reasoningEfforts: ["none", "high", "max"] } });
    expect(efforts(withListedReasoningRequirement(saved, true)))
      .toEqual({ defaultValue: "high", options: ["high", "max"], supported: true });
  });

  it("offers Off again when the listing later says reasoning is optional, but only for its own narrowing", () => {
    const original = openRouterModel();
    const restored = withListedReasoningRequirement(withListedReasoningRequirement(original, true), false);
    expect(restored).toEqual(original);
    expect(efforts(restored).options).toContain("none");

    const administrator = openRouterModel(undefined, { capabilities: { ...original.capabilities,
      defaultReasoningEffort: "high", reasoningEfforts: ["high"] } });
    expect(withListedReasoningRequirement(administrator, false)).toBe(administrator);
    expect(withListedReasoningRequirement(original, false)).toBe(original);
  });

  it("changes nothing without a listing flag, for models without reasoning, other adapters or a reviewed template", () => {
    const original = openRouterModel();
    expect(withListedReasoningRequirement(original, undefined)).toBe(original);
    const noReasoning = openRouterModel(undefined, { capabilities: { ...original.capabilities, reasoning: false } });
    expect(withListedReasoningRequirement(noReasoning, true)).toBe(noReasoning);
    const template = openRouterModel("anthropic/claude-opus-4.8");
    expect(withListedReasoningRequirement(template, true)).toBe(template);
    const deepSeek = normalizeProviderModelConfiguration({ ...original, adapterKind: "deepseek_responses_native",
      openRouterRouting: undefined, upstreamModelId: "deepseek-v4-flash" });
    expect(withListedReasoningRequirement(deepSeek, true)).toBe(deepSeek);
  });

  it("keeps a held Off from reaching the provider: admission refuses it and an Assistant row reports it", () => {
    const controls = configuredModelParameterControls(withListedReasoningRequirement(openRouterModel(), true), "openrouter");
    const params = (effort: string) => ({ reasoning: { effort, enabled: effort !== "none" } });
    expect(validateRunParams({ controls, params: params("none"), provider: "openrouter" }).ok).toBe(false);
    expect(validateRunParams({ controls, params: params("medium"), provider: "openrouter" }).ok).toBe(true);
    // The Assistant row resolver turns this issue into its visible fallback to the user's default.
    expect(assistantRunControlIssue({ reasoningEffort: "none" }, controls)).toEqual({ control: "reasoningEffort" });
  });
});
