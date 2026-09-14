import { describe, expect, it } from "vitest";
import { parameterControlsForModel } from "../../lib/domain/catalog";
import { validateRunParams } from "../../lib/domain/runParams";
import { longMemEvalAnswerParams } from "./answerParams";

describe("LongMemEval reader parameters", () => {
  it("accepts a UI catalog projection whose reasoning mode has no transport mapping", () => {
    const controls = parameterControlsForModel({ adapterKind: "openai_responses_compatible", provider: "openai",
      modelId: "gpt-5.6-sol", modelCapabilities: { reasoning: true, streaming: true, defaultMaxOutputTokens: 16384 },
      defaultParams: {}, supportsReasoningMode: false });
    const defaults = { maxOutputTokens: 16384, reasoning: { effort: "medium", mode: "standard" }, temperature: 1 };
    expect(validateRunParams({ provider: "openai", controls, params: defaults }).ok).toBe(false);
    const params = longMemEvalAnswerParams(defaults, 4096, "medium");
    expect(validateRunParams({ provider: "openai", controls, params }).ok).toBe(true);
    expect(params).toEqual({ maxOutputTokens: 4096, reasoning: { effort: "medium" }, temperature: 1 });
  });
  it("sends one output bound and leaves transport selection to the normal run path", () => {
    expect(longMemEvalAnswerParams({ maxTokens: 16384, max_output_tokens: 8192, background: true, stream: true }, 4096, "medium"))
      .toEqual({ maxOutputTokens: 4096, reasoning: { effort: "medium" } });
  });
});
