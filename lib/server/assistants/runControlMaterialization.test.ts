import { describe, expect, it } from "vitest";
import type { ModelParameterControls } from "../../contracts/catalog";
import { buildOpenRouterChatRequest } from "../providers/openRouterChatRequest";
import {
  assistantRunControlIssue,
  materializeAssistantRunParams
} from "./runControlMaterialization";

function controls(overrides: Partial<ModelParameterControls> = {}): ModelParameterControls {
  return {
    background: { defaultValue: false, supported: true },
    maxOutputTokens: { defaultValue: 4096, maxValue: 128_000 },
    reasoningEffort: {
      defaultValue: "medium",
      options: ["low", "medium", "high"],
      supported: true
    },
    reasoningMode: { defaultValue: "standard", options: ["standard", "pro"], supported: true },
    stream: { defaultValue: false, supported: true },
    temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true },
    ...overrides
  };
}

function openRouterWire(params: Record<string, unknown>) {
  return buildOpenRouterChatRequest({
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "Hello", type: "text" }] },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
    modelId: "vendor/model",
    params,
    prompt: { developer: null, system: null },
    provider: "openrouter",
    searchPlan: { mode: "all_selected", options: [] },
    toolMode: "auto"
  });
}

describe("materializeAssistantRunParams", () => {
  it.each([
    [{ backgroundMode: true }, { control: "backgroundMode" }],
    [{ streamMode: true }, { control: "streamMode" }],
    [{ reasoningEffort: "ultra" }, { control: "reasoningEffort" }],
    [{ reasoningMode: "ultra" }, { control: "reasoningMode" }]
  ] as const)("identifies the exact unsupported run-control field", (runControls, expected) => {
    expect(assistantRunControlIssue(
      runControls,
      controls({
        background: { defaultValue: false, supported: false },
        stream: { defaultValue: false, supported: false }
      })
    )).toEqual(expected);
  });

  it("returns the violated numeric model limit", () => {
    expect(assistantRunControlIssue(
      { maxOutputTokens: 128_001 },
      controls()
    )).toEqual({ control: "maxOutputTokens", limit: 128_000 });
    expect(assistantRunControlIssue(
      { temperature: -1 },
      controls()
    )).toEqual({ control: "temperature", limit: 0 });
  });

  it("builds exact OpenAI dialect params from saved controls", () => {
    const result = materializeAssistantRunParams({
      baseParams: { reasoning: { summary: "auto" } },
      controls: controls(),
      parameterProvider: "openai",
      runControls: {
        backgroundMode: true,
        maxOutputTokens: 9000,
        reasoningEffort: "high",
        reasoningMode: "pro",
        streamMode: true,
        temperature: 0.4
      }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params).toMatchObject({
        background: true,
        maxOutputTokens: 9000,
        reasoning: { effort: "high", mode: "pro", summary: "auto" },
        stream: true,
        temperature: 0.4
      });
    }
  });

  it("uses model defaults for absent controls without clamping saved values", () => {
    const result = materializeAssistantRunParams({
      baseParams: {},
      controls: controls(),
      parameterProvider: "openai",
      runControls: {}
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params).toMatchObject({
        maxOutputTokens: 4096,
        reasoning: { effort: "medium" },
        temperature: 1
      });
    }
  });

  it("builds the Anthropic dialect with thinking and outputConfig", () => {
    const result = materializeAssistantRunParams({
      baseParams: {},
      controls: controls({ background: { defaultValue: false, supported: false } }),
      parameterProvider: "anthropic",
      runControls: { maxOutputTokens: 2048, reasoningEffort: "high" }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // validateRunParams canonicalizes the Anthropic maxTokens alias.
      expect(result.params).toMatchObject({
        maxOutputTokens: 2048,
        outputConfig: { effort: "high" },
        thinking: { budgetTokens: 0, enabled: true, type: "adaptive" }
      });
    }
  });

  it("fails closed instead of clamping an out-of-range saved value", () => {
    expect(
      materializeAssistantRunParams({
        baseParams: {},
        controls: controls(),
        parameterProvider: "openai",
        runControls: { maxOutputTokens: 999_999 }
      }).ok
    ).toBe(false);
    expect(
      materializeAssistantRunParams({
        baseParams: {},
        controls: controls(),
        parameterProvider: "openai",
        runControls: { temperature: 5 }
      }).ok
    ).toBe(false);
  });

  it("fails closed when a saved control is no longer supported by the model", () => {
    const unsupported = controls({
      background: { defaultValue: false, supported: false },
      reasoningEffort: { defaultValue: "none", options: [], supported: false },
      stream: { defaultValue: false, supported: false },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: false }
    });

    expect(
      materializeAssistantRunParams({
        baseParams: {},
        controls: unsupported,
        parameterProvider: "openai",
        runControls: { backgroundMode: true }
      }).ok
    ).toBe(false);
    expect(
      materializeAssistantRunParams({
        baseParams: {},
        controls: unsupported,
        parameterProvider: "openai",
        runControls: { streamMode: false }
      }).ok
    ).toBe(false);
    expect(
      materializeAssistantRunParams({
        baseParams: {},
        controls: unsupported,
        parameterProvider: "openai",
        runControls: { temperature: 1 }
      }).ok
    ).toBe(false);
    expect(
      materializeAssistantRunParams({
        baseParams: {},
        controls: unsupported,
        parameterProvider: "openai",
        runControls: { reasoningEffort: "high" }
      }).ok
    ).toBe(false);
  });

  it("accepts effort none when the model has no reasoning support", () => {
    const result = materializeAssistantRunParams({
      baseParams: {},
      controls: controls({
        reasoningEffort: { defaultValue: "none", options: [], supported: false },
        reasoningMode: undefined
      }),
      parameterProvider: "openai",
      runControls: { reasoningEffort: "none" }
    });

    expect(result.ok).toBe(true);
  });

  it("fails closed when a saved reasoning mode is not offered by the model", () => {
    expect(
      materializeAssistantRunParams({
        baseParams: {},
        controls: controls({ reasoningMode: undefined }),
        parameterProvider: "openai",
        runControls: { reasoningMode: "pro" }
      }).ok
    ).toBe(false);
  });

  it("builds the Gemini dialect without temperature", () => {
    const result = materializeAssistantRunParams({
      baseParams: { temperature: 0.7 },
      controls: controls({
        background: { defaultValue: false, supported: false },
        reasoningMode: undefined,
        temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: false }
      }),
      parameterProvider: "gemini",
      runControls: { maxOutputTokens: 512, reasoningEffort: "low", streamMode: true }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params).toMatchObject({
        maxOutputTokens: 512,
        reasoning: { effort: "low" },
        stream: true
      });
      expect(result.params.temperature).toBeUndefined();
    }
  });

  it("removes an OpenRouter verbosity default when reasoning is disabled", () => {
    const result = materializeAssistantRunParams({
      baseParams: {
        reasoning: { effort: "medium" },
        verbosity: "medium"
      },
      controls: controls({
        reasoningEffort: {
          defaultValue: "medium",
          options: ["none", "low", "medium", "high"],
          supported: true
        }
      }),
      parameterProvider: "openrouter",
      runControls: { reasoningEffort: "none" }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params.verbosity).toBeUndefined();
      expect(result.params.reasoning).toMatchObject({ enabled: false });
    }
  });

  it.each([{}, { reasoningEffort: "none" }])("leaves OpenRouter reasoning unset without a reasoning control %j", (runControls) => {
    const result = materializeAssistantRunParams({
      baseParams: { provider: { dataCollection: "deny" } },
      controls: controls({
        reasoningEffort: { defaultValue: "none", options: ["none"], supported: false },
        reasoningMode: undefined
      }),
      parameterProvider: "openrouter",
      runControls
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params).not.toHaveProperty("reasoning");
      expect(openRouterWire(result.params)).not.toHaveProperty("reasoning");
    }
  });

  it("keeps a saved OpenRouter none as an explicit Off on the wire", () => {
    const reasoningControls = controls({
      reasoningEffort: { defaultValue: "high", options: ["none", "low", "high"], supported: true },
      reasoningMode: undefined
    });
    const materialize = (reasoningEffort: string) => materializeAssistantRunParams({
      baseParams: { reasoning: { enabled: true, effort: "high" } },
      controls: reasoningControls,
      parameterProvider: "openrouter",
      runControls: { reasoningEffort }
    });
    const off = materialize("none");
    const low = materialize("low");

    expect(off.ok && low.ok).toBe(true);
    if (off.ok && low.ok) {
      expect(openRouterWire(off.params).reasoning).toEqual({ enabled: false, effort: "none" });
      expect(openRouterWire(low.params).reasoning).toEqual({ enabled: true, effort: "low" });
    }
  });
});
