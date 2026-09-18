import { describe, expect, it } from "vitest";
import { resolveOpenRouterNativeProvider } from "./openRouterNativeRouting";

describe("OpenRouter native provider selection", () => {
  it.each([
    ["anthropic/claude-opus-5", "anthropic"], ["deepseek/deepseek-v4.1-flash", "deepseek"],
    ["openai/gpt-6-astra", "openai"], ["google/gemini-3.8-flash", "google-ai-studio"],
    ["qwen/qwen3-embedding-8b", "alibaba"], ["voyageai/rerank-2.5", "voyageai"]
  ])("requires an exact discovered native endpoint for %s", (modelId, provider) => {
    expect(resolveOpenRouterNativeProvider({ modelId, endpoints: [{ tag: "third-party", supportedParameters: [] }] }))
      .toEqual({ available: false, reason: "native_unavailable" });
    expect(resolveOpenRouterNativeProvider({ modelId, endpoints: [{ tag: provider, supportedParameters: ["tools"] }] }))
      .toEqual({ available: true, provider });
  });

  it("retains the exact native variant and refuses lookalikes or unknown publishers", () => {
    const endpoints = [{ tag: "deepseek-impostor", supportedParameters: [] }, { tag: "deepseek/fp8", supportedParameters: [] }];
    expect(resolveOpenRouterNativeProvider({ modelId: "deepseek/example", endpoints })).toEqual({ available: true, provider: "deepseek/fp8" });
    expect(resolveOpenRouterNativeProvider({ modelId: "unmapped/example", endpoints })).toEqual({ available: false, reason: "publisher_unknown" });
    expect(resolveOpenRouterNativeProvider({ modelId: "constructor/example", endpoints })).toEqual({ available: false, reason: "publisher_unknown" });
    expect(resolveOpenRouterNativeProvider({ modelId: "__proto__/example", endpoints })).toEqual({ available: false, reason: "publisher_unknown" });
    expect(resolveOpenRouterNativeProvider({ modelId: "deepseek/example", endpoints: endpoints.slice(0, 1) })).toEqual({ available: false, reason: "native_unavailable" });
  });

  it("checks the requested parameters and known output ceiling before choosing among native endpoints", () => {
    const endpoints = [
      { tag: "google-ai-studio", supportedParameters: ["tools"], maxCompletionTokens: 1024 },
      { tag: "google-vertex", supportedParameters: ["tools", "response_format"], maxCompletionTokens: 8192 },
      { tag: "unrelated", supportedParameters: ["tools", "response_format"], maxCompletionTokens: 32768 }
    ];
    expect(resolveOpenRouterNativeProvider({ modelId: "google/example", endpoints, requiredParameters: ["tools", "response_format"], maxOutputTokens: 8192 }))
      .toEqual({ available: true, provider: "google-vertex" });
    expect(resolveOpenRouterNativeProvider({ modelId: "google/example", endpoints, requiredParameters: ["unknown"] }))
      .toMatchObject({ available: false, reason: "native_incompatible", mismatch: { provider: "google-ai-studio", missingParameters: ["unknown"] } });
  });

  it("does not treat ordinary tools as proof of forced tool choice on a native route", () => {
    const endpoints = [{ tag: "deepseek", supportedParameters: ["tools", "tool_choice"],
      supportsToolChoice: { required: false, function: false } }];
    expect(resolveOpenRouterNativeProvider({ modelId: "deepseek/fixture", endpoints, requiredParameters: ["tools"] }))
      .toEqual({ available: true, provider: "deepseek" });
    expect(resolveOpenRouterNativeProvider({ modelId: "deepseek/fixture", endpoints, requiredParameters: ["tools"], requireForcedToolChoice: true }))
      .toMatchObject({ available: false, reason: "native_incompatible", mismatch: { provider: "deepseek", forcedToolChoice: true } });
  });
});
