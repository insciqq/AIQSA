import { describe, expect, it } from "vitest";
import { defaultProviderModels } from "./catalog";
import {
  AGENT_FALLBACK_CONTEXT_WINDOW_TOKENS,
  admitAgentMaxOutputTokens,
  agentMaxOutputTokensLimit,
  agentMaxOutputTokensRefusalMessage,
  invalidRunParamsError,
  resolveAcceptedRunReasoningEffort,
  validateRunParams
} from "./runParams";

function openAiControls(modelId: string) {
  const model = defaultProviderModels.find(
    (entry) => entry.provider === "openai" && entry.modelId === modelId
  );
  if (!model) {
    throw new Error(`missing test model: ${modelId}`);
  }
  return model.parameterControls;
}

function modelControls(provider: string, modelId: string) {
  const model = defaultProviderModels.find(
    (entry) => entry.provider === provider && entry.modelId === modelId
  );
  if (!model) {
    throw new Error(`missing test model: ${provider}/${modelId}`);
  }
  return model.parameterControls;
}

describe("run parameter validation", () => {
  it("canonicalizes every accepted max-output-token alias", () => {
    const cases = [
      {
        aliases: ["maxOutputTokens", "maxTokens", "max_output_tokens", "max_tokens"],
        modelId: "fake-qsa",
        provider: "fake"
      },
      {
        aliases: ["maxOutputTokens", "maxTokens", "max_output_tokens", "max_tokens", "max_completion_tokens"],
        modelId: "gpt-5.5",
        provider: "openai"
      },
      {
        aliases: ["maxOutputTokens", "maxTokens", "max_output_tokens", "max_tokens"],
        modelId: "claude-opus-4-8",
        provider: "anthropic"
      },
      {
        aliases: ["maxOutputTokens", "maxTokens", "max_output_tokens", "max_tokens", "max_completion_tokens"],
        modelId: "gemini-3.6-flash",
        provider: "gemini"
      },
      {
        aliases: ["maxOutputTokens", "maxTokens", "max_output_tokens", "max_tokens", "max_completion_tokens"],
        modelId: "anthropic/claude-opus-4.8",
        provider: "openrouter"
      }
    ];

    for (const testCase of cases) {
      for (const alias of testCase.aliases) {
        expect(
          validateRunParams({
            controls: modelControls(testCase.provider, testCase.modelId),
            params: { [alias]: 2048 },
            provider: testCase.provider
          })
        ).toEqual({
          ok: true,
          params: { maxOutputTokens: 2048 }
        });
      }
    }
  });

  it("accepts Pro mode and max effort for GPT-5.6", () => {
    const params = {
      reasoning: {
        effort: "max",
        mode: "pro",
        summary: "auto"
      }
    };

    expect(
      validateRunParams({
        controls: openAiControls("gpt-5.6-sol"),
        params,
        provider: "openai"
      })
    ).toEqual({ ok: true, params });
  });

  it("rejects GPT-5.6-only reasoning controls for GPT-5.5", () => {
    for (const reasoning of [
      { effort: "max", summary: "auto" },
      { effort: "medium", mode: "pro", summary: "auto" }
    ]) {
      expect(
        validateRunParams({
          controls: openAiControls("gpt-5.5"),
          params: { reasoning },
          provider: "openai"
        })
      ).toEqual({ code: invalidRunParamsError, ok: false });
    }
  });

  it("accepts reviewed Gemini reasoning and rejects unsupported sampling params", () => {
    const controls = modelControls("gemini", "gemini-3.6-flash");
    expect(validateRunParams({
      controls,
      params: {
        maxTokens: 64,
        reasoning: { effort: "high" },
        stream: false
      },
      provider: "gemini"
    })).toEqual({
      ok: true,
      params: {
        maxOutputTokens: 64,
        reasoning: { effort: "high" },
        stream: false
      }
    });
    expect(validateRunParams({
      controls,
      params: { temperature: 0.2 },
      provider: "gemini"
    })).toEqual({ code: invalidRunParamsError, ok: false });
  });

  it("accepts only canonical bounded ordinary tool-search controls", () => {
    const searchModelControls = modelControls(
      "openrouter",
      "perplexity/sonar-pro-search"
    );
    const searchControls = {
      maxOutputTokens: searchModelControls.maxOutputTokens,
      temperature: searchModelControls.temperature
    };

    expect(
      validateRunParams({
        controls: openAiControls("gpt-5.5"),
        params: {
          search: {
            maxOutputTokens: 2048,
            temperature: 0.25
          }
        },
        provider: "openai",
        searchControls
      })
    ).toEqual({
      ok: true,
      params: {
        search: {
          maxOutputTokens: 2048,
          temperature: 0.25
        }
      }
    });

    for (const search of [
      { maxTokens: 2048 },
      { max_output_tokens: 2048 },
      { max_completion_tokens: 2048 },
      { maxOutputTokens: 8193 },
      { maxOutputTokens: 1024, unknown: true },
      { provider: { data_collection: "allow" } },
      { reasoning: { exclude: false } }
    ]) {
      expect(
        validateRunParams({
          controls: openAiControls("gpt-5.5"),
          params: { search },
          provider: "openai",
          searchControls
        })
      ).toEqual({ code: invalidRunParamsError, ok: false });
    }
  });

  it("rejects nested search controls when the selected strategy has no tool-search policy", () => {
    expect(
      validateRunParams({
        controls: openAiControls("gpt-5.5"),
        params: { search: {} },
        provider: "openai"
      })
    ).toEqual({ code: invalidRunParamsError, ok: false });
  });

  it("freezes the accepted reasoning control independently of provider dialect", () => {
    const openAi = openAiControls("gpt-5.5");
    expect(resolveAcceptedRunReasoningEffort({
      controls: openAi,
      params: { reasoning: { effort: "high" } },
      provider: "openai"
    })).toEqual({ ok: true, reasoningEffort: "high" });

    const anthropic = modelControls("anthropic", "claude-opus-4-8");
    expect(resolveAcceptedRunReasoningEffort({
      controls: anthropic,
      params: { outputConfig: { effort: "medium" } },
      provider: "anthropic"
    })).toEqual({ ok: true, reasoningEffort: "medium" });

    const openRouter = modelControls("openrouter", "anthropic/claude-opus-4.8");
    expect(resolveAcceptedRunReasoningEffort({
      controls: openRouter,
      params: {
        reasoning: { effort: "low", enabled: true },
        verbosity: "high"
      },
      provider: "openrouter"
    })).toEqual({ ok: true, reasoningEffort: "high" });
  });

  it("rejects conflicting accepted Anthropic effort aliases", () => {
    expect(resolveAcceptedRunReasoningEffort({
      controls: modelControls("anthropic", "claude-opus-4-8"),
      params: {
        output_config: { effort: "low" },
        outputConfig: { effort: "high" }
      },
      provider: "anthropic"
    })).toEqual({ code: invalidRunParamsError, ok: false });
  });
});

describe("Agent output cap", () => {
  it("allows at most half of the context window, assuming the Agent fallback window when unknown", () => {
    expect(agentMaxOutputTokensLimit(272_000)).toBe(136_000);
    expect(agentMaxOutputTokensLimit(131_071)).toBe(65_535);
    for (const unknown of [undefined, null, 0, -1, Number.NaN, 1.5]) {
      expect(agentMaxOutputTokensLimit(unknown)).toBe(AGENT_FALLBACK_CONTEXT_WINDOW_TOKENS / 2);
    }
  });

  it("refuses a chosen value above the limit and clamps a default or policy cap", () => {
    const defaults = { contextWindow: 272_000, defaultValue: 65_536 };
    expect(admitAgentMaxOutputTokens({ ...defaults, chosen: 500_000 }))
      .toEqual({ ok: false, contextWindow: 272_000, limit: 136_000, requested: 500_000 });
    expect(admitAgentMaxOutputTokens({ ...defaults, chosen: 136_001 })).toMatchObject({ ok: false });
    expect(admitAgentMaxOutputTokens({ ...defaults, chosen: 136_000 })).toEqual({ ok: true, maxOutputTokens: 136_000 });
    // A policy cap that brings the chosen value within the limit admits it.
    expect(admitAgentMaxOutputTokens({ ...defaults, chosen: 500_000, policyCap: 100_000 }))
      .toEqual({ ok: true, maxOutputTokens: 100_000 });
    expect(admitAgentMaxOutputTokens({ ...defaults, chosen: 500_000, policyCap: 200_000 })).toMatchObject({ ok: false });
    // The model default, sent or not, and a policy cap above the limit are clamped.
    const small = { contextWindow: 128_000, defaultValue: 65_536 };
    expect(admitAgentMaxOutputTokens(small)).toEqual({ ok: true, maxOutputTokens: 64_000 });
    expect(admitAgentMaxOutputTokens({ ...small, chosen: 65_536 })).toEqual({ ok: true, maxOutputTokens: 64_000 });
    expect(admitAgentMaxOutputTokens({ ...small, defaultValue: 200_000, policyCap: 100_000 }))
      .toEqual({ ok: true, maxOutputTokens: 64_000 });
    expect(admitAgentMaxOutputTokens({ ...small, chosen: 4_096 })).toEqual({ ok: true, maxOutputTokens: 4_096 });
  });

  it("names the control, the requested value and the allowed maximum", () => {
    expect(agentMaxOutputTokensRefusalMessage({ contextWindow: 272_000, limit: 136_000, requested: 500_000 }))
      .toBe("Max output tokens is 500,000, but Agent allows at most 136,000 with this model (half of its 272,000-token " +
        "context window). Lower Max output tokens in Model parameters or reset output settings, then send again.");
  });
});
