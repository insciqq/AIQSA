import { describe, expect, it, vi } from "vitest";
import { createAgentResponsesTransport, supportsAgentNativeWebSearch } from "./agentResponses";
import type { ProviderExecutionSnapshot } from "./runtimeFactory";

function snapshot(adapterKind: string, defaultParams = {}): ProviderExecutionSnapshot {
  return { connection: { apiRoot: "https://provider.example.test/v1/", authenticationMode: "bearer", responseTimeoutMs: 300000 },
    model: { adapterKind, defaultParams, upstreamModelId: "fixture-flash", responseTimeoutMs: 90000 }
  } as ProviderExecutionSnapshot;
}

describe("Agent native Responses transport", () => {
  it("requires both an admitted native-search capability and the supported search protocol", () => {
    for (const adapter of ["openai_responses_native", "openai_responses_compatible", "deepseek_responses_native", "openrouter_chat_completions"]) {
      for (const nativeSearch of [true, false]) {
        const base = snapshot(adapter);
        const value = { ...base, model: { ...base.model, capabilities: { nativeSearch } } } as ProviderExecutionSnapshot;
        expect(supportsAgentNativeWebSearch(value)).toBe(nativeSearch && adapter.startsWith("openai_responses_"));
      }
    }
  });

  it("enables standalone search only on its admitted capability and preserves the exact root", async () => {
    const base = snapshot("openai_responses_compatible");
    const value = { ...base, connection: { ...base.connection, apiRoot: "https://provider.example.test/backend-api/codex" },
      model: { ...base.model, capabilities: { nativeSearch: false, codexStandaloneWebSearch: true } } } as ProviderExecutionSnapshot;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}));
    const transport = createAgentResponsesTransport({ snapshot: value, secret: "synthetic-credential", fetch })!;
    await transport.search!({ model: "fixture-flash" }, new AbortController().signal);
    expect(fetch.mock.calls[0]![0]).toBe("https://provider.example.test/backend-api/codex/alpha/search");
    expect(createAgentResponsesTransport({ snapshot: base, secret: "synthetic-credential", fetch })!.search).toBeUndefined();
  });

  it("uses one exact Responses request and resolves the admitted credential at dispatch", async () => {
    const secret = vi.fn(async () => "synthetic-credential");
    const fetch = vi.fn(async () => new Response("", { status: 503 }));
    const transport = createAgentResponsesTransport({ snapshot: snapshot("deepseek_responses_native"), secret, fetch });
    expect((await transport!.request({ model: "fixture-flash", stream: true }, new AbortController().signal)).status).toBe(503);
    expect(secret).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://provider.example.test/v1/responses");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-credential");
  });

  it("translates the frozen OpenRouter routing and privacy policy instead of taking guest routing", async () => {
    const fetch = vi.fn(async () => new Response(""));
    const transport = createAgentResponsesTransport({ snapshot: snapshot("openrouter_chat_completions", {
      provider: { order: ["DeepSeek"], only: ["DeepSeek"], allowFallbacks: false, dataCollection: "deny", zdr: true }
    }), secret: "synthetic-credential", fetch });
    await transport!.request({ model: "fixture-flash", provider: { only: ["unadmitted"] } }, new AbortController().signal);
    const [, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).provider).toMatchObject({ only: ["DeepSeek"], order: ["DeepSeek"],
      allow_fallbacks: false, data_collection: "deny", zdr: true });
  });

  it("cannot dispatch a revoked credential or a non-Responses adapter", async () => {
    const fetch = vi.fn(async () => new Response(""));
    const transport = createAgentResponsesTransport({ snapshot: snapshot("openai_responses_compatible"), secret: null, fetch });
    await expect(transport!.request({}, new AbortController().signal)).rejects.toThrow("credential_revoked");
    expect(fetch).not.toHaveBeenCalled();
    expect(createAgentResponsesTransport({ snapshot: snapshot("anthropic_messages"), secret: null, fetch })).toBeUndefined();
  });
});
