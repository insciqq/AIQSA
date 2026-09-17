import { describe, expect, it, vi } from "vitest";
import { normalizeProviderModelConfiguration } from "../../providers/providerConfiguration";
import { adminProviderQuickSetupPolicy } from "./quickSetupPolicy";
import { applyNativeRoute, discoverNativeRoute, nativeRoutePreservesCapabilities } from "./nativeRouting";
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
    await expect(discoverNativeRoute({ listModelEndpoints }, model)).resolves.toEqual({ available: false, reason: "native_incompatible" });
    listModelEndpoints.mockRejectedValueOnce(new Error("private provider failure"));
    await expect(discoverNativeRoute({ listModelEndpoints }, model)).resolves.toEqual({ available: false, reason: "verification_required" });
    const aborted = AbortSignal.abort();
    listModelEndpoints.mockRejectedValueOnce(new Error("aborted"));
    await expect(discoverNativeRoute({ listModelEndpoints }, model, aborted)).rejects.toThrow();
  });

  it("refuses a route that loses a previously verified Memory capability", () => {
    const proof = { adapterKind: "openrouter_chat_completions" as const, probeVersion: 1 as const, upstreamModelId: model.upstreamModelId, verified: true as const };
    const previous: AdminProviderTestEvidence = { method: "tiny_generation", detail: "ok", selectedProviders: [], upstreamModelId: model.upstreamModelId,
      compatibility: { probeVersion: 1, modelAccess: "verified", structuredOutput: "verified", forcedToolCall: "verified",
        streaming: "not_supported", directPdf: "not_supported", usage: "not_supported" },
      structuredOutput: { ...proof, probeVersion: 2 }, forcedToolCall: proof };
    const fresh = { ...previous, selectedProviders: ["anthropic"] };
    expect(nativeRoutePreservesCapabilities(model, previous, fresh)).toBe(true);
    expect(nativeRoutePreservesCapabilities(model, previous, { ...fresh, forcedToolCall: undefined,
      compatibility: { ...fresh.compatibility!, forcedToolCall: "not_supported" } })).toBe(false);
  });
});
