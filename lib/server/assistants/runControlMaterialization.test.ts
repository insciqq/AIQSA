import { describe, expect, it } from "vitest";
import type { ModelParameterControls } from "../../contracts/catalog";
import { materializeAssistantRunParams } from "./runControlMaterialization";

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

describe("materializeAssistantRunParams", () => {
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
});
