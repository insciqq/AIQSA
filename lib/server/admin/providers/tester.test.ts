import { describe, expect, it, vi } from "vitest";
import type { OpenRouterDiscoveryClient } from "../../providers/openRouterDiscovery";
import {
  createAdminProviderDraftTester,
  type AdminProviderDraftTesterInput
} from "./tester";

function input(
  overrides: Partial<AdminProviderDraftTesterInput> = {}
): AdminProviderDraftTesterInput {
  return {
    connection: {
      allowPrivateNetwork: false,
      apiRoot: "https://openrouter.ai/api/v1"
    },
    connectionDisplayName: "OpenRouter",
    connectionId: "connection-1",
    credentialId: "credential-1",
    credentialVersionIdentity: "draft:1",
    mode: "account_catalog",
    model: {
      adapterKind: "openrouter_chat_completions",
      capabilities: {
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        vision: false
      },
      defaultParams: {},
      openRouterRouting: { mode: "automatic", providers: [] },
      upstreamModelId: "vendor/model"
    },
    modelDisplayName: "Vendor Model",
    providerFamily: "openrouter",
    providerModelId: "model-1",
    secret: "secret",
    ...overrides
  };
}

function discovery(overrides: Partial<OpenRouterDiscoveryClient> = {}): OpenRouterDiscoveryClient {
  return {
    async listModelEndpoints() { return []; },
    async listModels() {
      return [{
        id: "vendor/model",
        inputModalities: ["text"],
        name: "Vendor Model",
        outputModalities: ["text"],
        pricing: {},
        supportedParameters: []
      }];
    },
    ...overrides
  };
}

describe("admin provider draft tester", () => {
  it("uses the credential-specific OpenRouter account catalog", async () => {
    const listModels = vi.fn<OpenRouterDiscoveryClient["listModels"]>(async () => []);
    const createDiscoveryClient = vi.fn(() => discovery({ listModels }));
    const providerTester = createAdminProviderDraftTester({ createDiscoveryClient });

    await expect(providerTester.test(input())).resolves.toEqual({
      evidence: {
        detail: "model_missing",
        method: "openrouter_account_catalog",
        selectedProviders: [],
        upstreamModelId: "vendor/model"
      },
      status: "unavailable"
    });
    expect(createDiscoveryClient).toHaveBeenCalledWith({
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://openrouter.ai/api/v1"
      },
      secret: "secret"
    });
    expect(listModels).toHaveBeenCalledOnce();
  });

  it("requires every selected OpenRouter downstream endpoint", async () => {
    const listModelEndpoints = vi.fn<OpenRouterDiscoveryClient["listModelEndpoints"]>(async () => [{
      name: "Provider A",
      providerName: "Provider A",
      supportedParameters: [],
      tag: "provider-a"
    }]);
    const providerTester = createAdminProviderDraftTester({
      createDiscoveryClient: () => discovery({ listModelEndpoints })
    });
    const selected = input({
      model: {
        ...input().model,
        openRouterRouting: {
          mode: "only_selected",
          providers: ["provider-a", "provider-b"]
        }
      }
    });

    await expect(providerTester.test(selected)).resolves.toMatchObject({
      evidence: {
        detail: "route_missing",
        selectedProviders: ["provider-a", "provider-b"]
      },
      status: "unavailable"
    });
    expect(listModelEndpoints).toHaveBeenCalledWith("vendor/model", {
      signal: undefined
    });
  });

  it("matches OpenRouter route tags case-insensitively without changing evidence", async () => {
    const providerTester = createAdminProviderDraftTester({
      createDiscoveryClient: () => discovery({
        async listModelEndpoints() {
          return [{
            name: "Anthropic",
            providerName: "Anthropic",
            supportedParameters: [],
            tag: "anthropic"
          }];
        }
      })
    });
    const selected = input({
      model: {
        ...input().model,
        openRouterRouting: {
          mode: "only_selected",
          providers: ["Anthropic"]
        }
      }
    });

    await expect(providerTester.test(selected)).resolves.toEqual({
      evidence: {
        detail: "ok",
        method: "openrouter_account_catalog",
        selectedProviders: ["Anthropic"],
        upstreamModelId: "vendor/model"
      },
      status: "available"
    });
  });

  it("runs the explicit tiny generation through the existing runtime adapter and stores no output", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "private output", role: "assistant" } }],
      usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 }
    }), {
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const providerTester = createAdminProviderDraftTester({
      createFetch: () => fetchFn
    });
    const compatible = input({
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://compatible.example.test/v1"
      },
      mode: "tiny_generation",
      model: {
        ...input().model,
        adapterKind: "openai_chat_completions_compatible",
        openRouterRouting: undefined
      },
      providerFamily: "openai_compatible"
    });

    const result = await providerTester.test(compatible);
    expect(result).toEqual({
      evidence: {
        detail: "ok",
        method: "tiny_generation",
        selectedProviders: [],
        upstreamModelId: "vendor/model"
      },
      status: "available"
    });
    expect(JSON.stringify(result)).not.toContain("private output");
    expect(fetchFn).toHaveBeenCalledOnce();
    const [endpoint, request] = fetchFn.mock.calls[0] ?? [];
    expect(endpoint).toBe("https://compatible.example.test/v1/chat/completions");
    expect(request).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      max_completion_tokens: 16,
      stream: false
    });
  });

  it.each([
    ["openai_responses_native", "openai"],
    ["openai_responses_compatible", "openai_compatible"]
  ] as const)("uses a valid minimal Responses budget for %s", async (adapterKind, providerFamily) => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: "response-1",
      output: [{ content: [{ text: "private output", type: "output_text" }], type: "message" }],
      status: "completed",
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
    }), {
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const providerTester = createAdminProviderDraftTester({ createFetch: () => fetchFn });
    const responses = input({
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://responses.example.test/v1"
      },
      mode: "tiny_generation",
      model: {
        ...input().model,
        adapterKind,
        defaultParams: {
          reasoning: { effort: "high", summary: "detailed" }
        },
        openRouterRouting: undefined
      },
      providerFamily
    });

    await expect(providerTester.test(responses)).resolves.toMatchObject({
      evidence: { detail: "ok", method: "tiny_generation" },
      status: "available"
    });
    const [endpoint, request] = fetchFn.mock.calls[0] ?? [];
    expect(endpoint).toBe("https://responses.example.test/v1/responses");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      background: false,
      max_output_tokens: 16,
      reasoning: { effort: "none" },
      store: false,
      stream: false
    });
  });

  it("keeps the one-token Anthropic connectivity request valid", async () => {
    const body = [
      'data: {"type":"message_start","message":{"id":"message-1","model":"claude-test","usage":{"input_tokens":2}}}',
      "",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}',
      "",
      'data: {"type":"content_block_stop","index":0}',
      "",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      "",
      'data: {"type":"message_stop"}',
      ""
    ].join("\n");
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(body, {
      headers: { "content-type": "text/event-stream" },
      status: 200
    }));
    const providerTester = createAdminProviderDraftTester({ createFetch: () => fetchFn });
    const anthropic = input({
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://api.anthropic.test/v1"
      },
      mode: "tiny_generation",
      model: {
        ...input().model,
        adapterKind: "anthropic_messages",
        openRouterRouting: undefined
      },
      providerFamily: "anthropic"
    });

    await expect(providerTester.test(anthropic)).resolves.toMatchObject({
      evidence: { detail: "ok", method: "tiny_generation" },
      status: "available"
    });
    const [endpoint, request] = fetchFn.mock.calls[0] ?? [];
    expect(endpoint).toBe("https://api.anthropic.test/v1/messages");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      max_tokens: 1,
      stream: true
    });
  });
});
