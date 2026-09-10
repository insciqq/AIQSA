import { describe, expect, it } from "vitest";
import { fallbackParameterControls, parameterControlsForModel, resolveProviderModelParameterControls } from "./catalog";

describe("ordinary chat output defaults", () => {
  it.each([undefined, 8192, 131072])("uses a bounded default with ceiling %s without inventing an unknown limit", (limit) => {
    const expected = { defaultValue: limit === 8192 ? 8192 : 65536, ...(limit === undefined ? {} : { maxValue: limit }) };
    const catalog = resolveProviderModelParameterControls({ adapterKind: "openai_responses_compatible", providerFamily: "openai_compatible",
      upstreamModelId: "fixture", supportsReasoning: false, supportsStreaming: false, defaultParams: {}, maxOutputTokens: limit });
    const admission = parameterControlsForModel({ adapterKind: "openai_responses_compatible", provider: "openai_compatible",
      modelId: "fixture", modelCapabilities: { maxOutputTokens: limit } });
    expect(catalog.maxOutputTokens).toEqual(expected);
    expect(admission.maxOutputTokens).toEqual(expected);
    expect(catalog.temperature.defaultValue).toBe(1);
  });

  it.each(["maxOutputTokens", "maxTokens", "max_output_tokens", "max_tokens", "max_completion_tokens"])("preserves explicit %s and temperature", (alias) => {
    const controls = fallbackParameterControls({ provider: "openai_compatible", supportsReasoning: false,
      maxOutputTokens: 131072, defaultParams: { [alias]: 1024, temperature: 0.4 } });
    expect(controls.maxOutputTokens).toEqual({ defaultValue: 1024, maxValue: 131072 });
    expect(controls.temperature.defaultValue).toBe(0.4);
  });

  it("honors a configured default even for a built-in model and preserves ambiguous old defaults", () => {
    expect(parameterControlsForModel({ adapterKind: "openai_responses_native", provider: "openai", modelId: "gpt-6-astra",
      defaultParams: { maxOutputTokens: 96000, temperature: 0.7 } })).toMatchObject({
      maxOutputTokens: { defaultValue: 96000, maxValue: 128000 }, temperature: { defaultValue: 0.7 }
    });
    expect(parameterControlsForModel({ provider: "openai_compatible", modelId: "legacy",
      modelCapabilities: { defaultMaxOutputTokens: 1024 } }).maxOutputTokens).toEqual({ defaultValue: 1024 });
  });
});
