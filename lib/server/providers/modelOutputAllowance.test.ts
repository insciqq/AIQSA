import { describe, expect, it } from "vitest";
import { modelOutputAllowance } from "./modelOutputAllowance";

function binding(): Parameters<typeof modelOutputAllowance>[0] {
  return { providerFamily: "openai_compatible", model: { adapterKind: "openai_responses_compatible",
    upstreamModelId: "fixture", defaultParams: {},
    capabilities: { reasoning: true, nativeSearch: false, nativePdfInput: false, pdf: false, vision: false } } };
}

describe("utility model output allowance", () => {
  it("uses configuration, then the actual ceiling, then the unknown-model fallback", () => {
    const target = binding();
    expect(modelOutputAllowance(target, "input")).toBe(65_536);
    target.model.capabilities.maxOutputTokens = 131_072;
    target.model.capabilities.defaultMaxOutputTokens = 4_096;
    expect(modelOutputAllowance(target, "input")).toBe(131_072);
    target.model.defaultParams.maxOutputTokens = 100_000;
    expect(modelOutputAllowance(target, "input")).toBe(100_000);
    expect(modelOutputAllowance(target, "input", 200_000)).toBe(131_072);
    delete target.model.capabilities.maxOutputTokens;
    expect(modelOutputAllowance(target, "input")).toBe(100_000);
  });

  it("accounts for the full input and safety headroom without weakening the real model ceiling", () => {
    const target = binding();
    target.model.capabilities.contextWindow = 10_000;
    expect(modelOutputAllowance(target, "x".repeat(4_000))).toBe(8_000);
    target.model.capabilities.maxOutputTokens = 2_000;
    expect(modelOutputAllowance(target, "x".repeat(4_000))).toBe(2_000);
    expect(() => modelOutputAllowance(target, "x".repeat(36_000))).toThrow("provider_context_limit_exceeded");
    try { modelOutputAllowance(target, "x".repeat(36_000)); }
    catch (error) { expect(error).toMatchObject({ code: "provider_context_limit_exceeded" }); }
  });
});
