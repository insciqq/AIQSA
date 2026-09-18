import { describe, expect, it, vi } from "vitest";
import { normalizeProviderModelConfiguration } from "../../providers/providerConfiguration";
import { adminProviderQuickSetupPolicy } from "./quickSetupPolicy";
import { applyNativeRoute, discoverNativeRoute, nativeRouteMissingCapabilities, nativeRoutePreservesCapabilities } from "./nativeRouting";
import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";

const model = normalizeProviderModelConfiguration({ ...adminProviderQuickSetupPolicy("openrouter").candidates[0]!.configuration,
  capabilities: { pdf: false, nativePdfInput: false, nativeSearch: false, reasoning: false, vision: false, toolCalling: false, streaming: false },
  defaultParams: { maxOutputTokens: 2048 }, openRouterRouting: { mode: "automatic", providers: [] } });

describe("native OpenRouter defaults", () => {
  it("serializes only/order without fallback and preserves a custom route", () => {
    const routed = applyNativeRoute(model, { available: true, provider: "anthropic" });
    expect(routed.openRouterRouting).toEqual({ mode: "only_selected", providers: ["anthropic"] });
    expect(routed.defaultParams.provider).toMatchObject({ only: ["anthropic"], order: ["anthropic"], allowFallbacks: false });
    const custom = normalizeProviderModelConfiguration({ ...model, openRouterRouting: { mode: "only_selected", providers: ["amazon-bedrock"] } });
    expect(applyNativeRoute(custom, { available: true, provider: "anthropic" })).toBe(custom);
    expect(applyNativeRoute(model, { available: false, reason: "native_unavailable" })).toBe(model);
  });

  it("requires live endpoint and output-budget support, retaining automatic on discovery failure", async () => {
    const listModelEndpoints = vi.fn(async () => [{ tag: "anthropic", name: "Anthropic", providerName: "Anthropic", supportedParameters: [], maxCompletionTokens: 1024 }]);
    await expect(discoverNativeRoute({ listModelEndpoints }, model)).resolves.toMatchObject({ available: false, reason: "native_incompatible",
      diagnostic: { stage: "catalog", provider: "anthropic", missing: ["maxOutputTokens"] } });
    listModelEndpoints.mockRejectedValueOnce(new Error("private provider failure"));
    await expect(discoverNativeRoute({ listModelEndpoints }, model)).resolves.toMatchObject({ available: false, reason: "verification_required" });
    const aborted = AbortSignal.abort();
    listModelEndpoints.mockRejectedValueOnce(new Error("aborted"));
    await expect(discoverNativeRoute({ listModelEndpoints }, model, aborted)).rejects.toThrow();
  });

  it("explains contradictory legacy flags and output limits without changing operator requirements", async () => {
    const sonar = normalizeProviderModelConfiguration({ ...model, upstreamModelId: "perplexity/sonar-pro-search",
      capabilities: { ...model.capabilities, toolCalling: true, parallelToolCalls: true }, defaultParams: { maxTokens: 8192 } });
    const previous: AdminProviderTestEvidence = { method: "tiny_generation", detail: "ok", upstreamModelId: sonar.upstreamModelId,
      selectedProviders: [], compatibility: { probeVersion: 1, modelAccess: "verified", directPdf: "not_supported", streaming: "not_supported",
        structuredOutput: "not_supported", usage: "verified", toolCalling: "not_supported", parallelToolCalls: "not_supported" },
      capabilitySetup: { policyVersion: 2, activation: "preserve", checks: { modelAccess: "verified", toolCalling: "unsupported", parallelToolCalls: "unsupported" } } };
    const before = structuredClone(sonar);
    const route = await discoverNativeRoute({ listModelEndpoints: async () => [{ tag: "perplexity", name: "Perplexity", providerName: "Perplexity",
      supportedParameters: [], maxCompletionTokens: 8000 }] }, sonar, undefined, previous);
    expect(route).toMatchObject({ available: false, reason: "native_incompatible", diagnostic: {
      servingMode: "automatic", stage: "catalog", provider: "perplexity",
      missing: ["toolCalling", "parallelToolCalls", "maxOutputTokens"], previouslyUnverified: ["toolCalling", "parallelToolCalls"]
    } });
    expect(nativeRouteMissingCapabilities(sonar, previous, previous)).toEqual(["toolCalling", "parallelToolCalls"]);
    expect(sonar).toEqual(before);
  });

  it("requires a verified PDF capability independently of successful model access", () => {
    const configured = normalizeProviderModelConfiguration({ ...model, capabilities: { ...model.capabilities, nativePdfInput: true } });
    const fresh: AdminProviderTestEvidence = { method: "tiny_generation", detail: "ok", upstreamModelId: configured.upstreamModelId,
      selectedProviders: ["anthropic"], compatibility: { probeVersion: 1, modelAccess: "verified", directPdf: "not_supported", streaming: "not_supported",
        structuredOutput: "not_supported", usage: "verified" } };
    expect(nativeRouteMissingCapabilities(configured, undefined, fresh)).toEqual(["directPdf"]);
  });

  it("refuses a route that loses a previously verified Memory capability", async () => {
    const proof = { adapterKind: "openrouter_chat_completions" as const, probeVersion: 1 as const, upstreamModelId: model.upstreamModelId, verified: true as const };
    const previous: AdminProviderTestEvidence = { method: "tiny_generation", detail: "ok", selectedProviders: [], upstreamModelId: model.upstreamModelId,
      compatibility: { probeVersion: 1, modelAccess: "verified", structuredOutput: "verified", forcedToolCall: "verified",
        streaming: "not_supported", directPdf: "not_supported", usage: "not_supported" },
      structuredOutput: { ...proof, probeVersion: 2 }, forcedToolCall: proof };
    const fresh = { ...previous, selectedProviders: ["anthropic"] };
    expect(nativeRoutePreservesCapabilities(model, previous, fresh)).toBe(true);
    expect(nativeRoutePreservesCapabilities(model, previous, { ...fresh, forcedToolCall: undefined,
      compatibility: { ...fresh.compatibility!, forcedToolCall: "not_supported" } })).toBe(false);
    await expect(discoverNativeRoute({ listModelEndpoints: async () => [{ tag: "anthropic", name: "Anthropic", providerName: "Anthropic",
      supportedParameters: ["tools"], supportsToolChoice: { required: false, function: false } }] }, model, undefined, previous))
      .resolves.toMatchObject({ available: false, reason: "native_incompatible", diagnostic: { missing: ["forcedToolCall"] } });
  });
});
