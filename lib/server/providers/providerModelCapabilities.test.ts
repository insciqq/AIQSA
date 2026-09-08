import { describe, expect, it } from "vitest";
import { lowestConfiguredReasoningEffort, resolveProviderModelCapabilities } from "./providerModelCapabilities";

const capabilities = {
  nativePdfInput: false,
  nativeSearch: false,
  pdf: false,
  reasoning: true,
  vision: false
};

describe("provider model capability resolution", () => {
  it.each([
    ["gpt-6-astra", "low"], ["gpt-5.6-terra", "none"]
  ])("uses the lowest supported effort for %s probes", (upstreamModelId, expected) => {
    expect(lowestConfiguredReasoningEffort({
      adapterKind: "openai_responses_native", answerSelectable: true,
      capabilities, defaultParams: {}, modelClass: "answer", upstreamModelId
    }, "openai")).toBe(expected);
  });

  it("enables AIQSA local PDF extraction without inventing Direct PDF support", () => {
    const resolved = resolveProviderModelCapabilities({
      adapterKind: "openai_responses_compatible",
      capabilities,
      providerFamily: "openai_compatible",
      upstreamModelId: "private/model"
    });

    expect(resolved.pdf).toBe(true);
    expect(resolved.nativePdfInput).toBe(false);
  });

  it("keeps an explicitly configured context window", () => {
    expect(
      resolveProviderModelCapabilities({
        adapterKind: "openai_responses_native",
        capabilities: { ...capabilities, contextWindow: 200_000 },
        providerFamily: "openai",
        upstreamModelId: "gpt-5.5"
      }).contextWindow
    ).toBe(200_000);
  });

  it("uses a code-owned model default when current capabilities omit the value", () => {
    expect(
      resolveProviderModelCapabilities({
        adapterKind: "openai_responses_native",
        capabilities,
        providerFamily: "openai",
        upstreamModelId: "gpt-5.5"
      }).contextWindow
    ).toBe(1_050_000);
  });

  it("does not invent a context window for an unknown deployment", () => {
    expect(
      resolveProviderModelCapabilities({
        adapterKind: "openai_responses_compatible",
        capabilities,
        providerFamily: "openai_compatible",
        upstreamModelId: "private/model"
      }).contextWindow
    ).toBeUndefined();
  });
});
