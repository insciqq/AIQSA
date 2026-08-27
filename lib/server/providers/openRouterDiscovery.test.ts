import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpPinnedHttpRequest } from "../mcp/safeFetch";
import { ProviderResponseTooLargeError } from "./network";
import {
  createOpenRouterDiscoveryClient,
  MAX_OPENROUTER_DISCOVERY_ENDPOINTS,
  MAX_OPENROUTER_DISCOVERY_MODELS,
  OpenRouterDiscoveryError
} from "./openRouterDiscovery";

const publicLookup = async () => [
  { address: "93.184.216.34", family: 4 as const }
];

afterEach(() => {
  vi.unstubAllEnvs();
});

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

function expectDiscoveryCode(error: unknown, code: OpenRouterDiscoveryError["code"]): void {
  expect(error).toBeInstanceOf(OpenRouterDiscoveryError);
  expect(error).toMatchObject({ code, message: code, name: "OpenRouterDiscoveryError" });
}

describe("OpenRouter account-filtered discovery", () => {
  it("uses the dedicated embedding-model catalog path", async () => {
    const requests: McpPinnedHttpRequest[] = [];
    const client = createOpenRouterDiscoveryClient({
      apiRoot: "https://openrouter.example.test/api/v1",
      bearerToken: "embedding-key",
      network: {
        dispatch: async (request) => {
          requests.push(request);
          return responseJson({
            data: [{ id: "qwen/qwen3-embedding-8b", name: "Qwen3 Embedding 8B" }]
          });
        },
        lookupHostname: publicLookup
      }
    });

    await expect(client.listEmbeddingModels()).resolves.toEqual([{
      id: "qwen/qwen3-embedding-8b",
      inputModalities: [],
      name: "Qwen3 Embedding 8B",
      outputModalities: [],
      pricing: {},
      supportedParameters: []
    }]);
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/api/v1/embeddings/models"
    ]);
  });

  it("filters rerank models upstream and locally by the rerank output modality", async () => {
    const requests: McpPinnedHttpRequest[] = [];
    const client = createOpenRouterDiscoveryClient({
      apiRoot: "https://openrouter.example.test/api/v1",
      bearerToken: "rerank-key",
      network: {
        dispatch: async (request) => {
          requests.push(request);
          return responseJson({
            data: [
              {
                architecture: { output_modalities: ["rerank"] },
                id: "qwen/qwen3-reranker-8b",
                name: "Qwen3 Reranker 8B"
              },
              {
                architecture: { output_modalities: ["text"] },
                id: "vendor/chat-model",
                name: "Loosely filtered chat model"
              }
            ]
          });
        },
        lookupHostname: publicLookup
      }
    });

    await expect(client.listRerankModels()).resolves.toEqual([{
      id: "qwen/qwen3-reranker-8b",
      inputModalities: [],
      name: "Qwen3 Reranker 8B",
      outputModalities: ["rerank"],
      pricing: {},
      supportedParameters: []
    }]);
    expect(requests.map(({ url }) =>
      `${url.pathname}?${url.searchParams.toString()}`
    )).toEqual(["/api/v1/models?output_modalities=rerank"]);
  });

  it("uses exact draft bearer paths and returns only bounded safe model and endpoint metadata", async () => {
    const requests: McpPinnedHttpRequest[] = [];
    const responses = [
      responseJson({
        data: [
          {
            architecture: {
              input_modalities: ["text", "image", "text", { invalid: true }],
              output_modalities: ["text"]
            },
            context_length: 1_050_000,
            description: "must not survive",
            id: "openai/gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            pricing: {
              __proto__: "ignored",
              completion: 0.00002,
              prompt: "0.00001",
              unsafe: { nested: true }
            },
            supported_parameters: ["tools", "reasoning", "tools", null]
          },
          { id: "invalid model id", name: "ignored" },
          "ignored"
        ],
        secret: "must not survive"
      }),
      responseJson({
        data: {
          endpoints: [
            {
              context_length: 1_050_000,
              max_completion_tokens: 128_000,
              max_prompt_tokens: 922_000,
              name: "OpenAI: GPT-5.6 Sol",
              provider_name: "OpenAI",
              quantization: "unknown",
              supported_parameters: ["tools", "reasoning"],
              tag: "openai",
              url: "https://must-not-survive.example"
            },
            { name: "missing tag" },
            { name: "duplicate", provider_name: "Other", tag: "openai" }
          ],
          id: "openai/gpt-5.6-sol"
        }
      })
    ];
    const client = createOpenRouterDiscoveryClient({
      apiRoot: "https://openrouter.example.test/api/v1/",
      bearerToken: "  exact-draft-key  ",
      network: {
        dispatch: async (request) => {
          requests.push(request);
          return responses.shift() ?? responseJson({ data: [] });
        },
        lookupHostname: publicLookup
      }
    });

    await expect(client.listModels()).resolves.toEqual([
      {
        contextLength: 1_050_000,
        id: "openai/gpt-5.6-sol",
        inputModalities: ["text", "image"],
        name: "GPT-5.6 Sol",
        outputModalities: ["text"],
        pricing: {
          completion: "0.00002",
          prompt: "0.00001"
        },
        supportedParameters: ["tools", "reasoning"]
      }
    ]);
    await expect(
      client.listModelEndpoints("openai/gpt-5.6-sol")
    ).resolves.toEqual([
      {
        contextLength: 1_050_000,
        maxCompletionTokens: 128_000,
        maxPromptTokens: 922_000,
        name: "OpenAI: GPT-5.6 Sol",
        providerName: "OpenAI",
        quantization: "unknown",
        supportedParameters: ["tools", "reasoning"],
        tag: "openai"
      }
    ]);

    expect(requests.map((request) => request.url.href)).toEqual([
      "https://openrouter.example.test/api/v1/models/user",
      "https://openrouter.example.test/api/v1/models/openai/gpt-5.6-sol/endpoints"
    ]);
    for (const request of requests) {
      expect(request.method).toBe("GET");
      expect(request.body).toBeNull();
      expect(request.headers.get("accept")).toBe("application/json");
      expect(request.headers.get("authorization")).toBe("Bearer exact-draft-key");
    }
  });

  it("supports the current tilde model alias while rejecting arbitrary path input and blank keys", async () => {
    const requests: McpPinnedHttpRequest[] = [];
    const client = createOpenRouterDiscoveryClient({
      apiRoot: "https://openrouter.example.test/api/v1",
      bearerToken: "key",
      network: {
        dispatch: async (request) => {
          requests.push(request);
          return responseJson({ data: { endpoints: [] } });
        },
        lookupHostname: publicLookup
      }
    });

    await client.listModelEndpoints("~google/gemini-pro-latest");
    expect(requests[0]?.url.pathname).toBe(
      "/api/v1/models/~google/gemini-pro-latest/endpoints"
    );

    for (const modelId of ["one", "a/b/c", "a/../secret", "a/b?key=secret", "a/%2fsecret"]) {
      try {
        await client.listModelEndpoints(modelId);
        throw new Error("Expected model id to be rejected.");
      } catch (error) {
        expectDiscoveryCode(error, "openrouter_discovery_model_id_invalid");
      }
    }
    expect(requests).toHaveLength(1);

    expect(() =>
      createOpenRouterDiscoveryClient({
        apiRoot: "https://openrouter.example.test/api/v1",
        bearerToken: " "
      })
    ).toThrow("openrouter_discovery_api_key_required");
  });

  it("fails closed on malformed envelopes, duplicate model ids, and count overflow", async () => {
    const responses = [
      responseJson({ data: {} }),
      responseJson({
        data: [
          { id: "vendor/model", name: "one" },
          { id: "vendor/model", name: "two" }
        ]
      }),
      responseJson({
        data: Array.from(
          { length: MAX_OPENROUTER_DISCOVERY_MODELS + 1 },
          (_value, index) => ({ id: `vendor/model-${index}` })
        )
      }),
      responseJson({
        data: {
          endpoints: Array.from(
            { length: MAX_OPENROUTER_DISCOVERY_ENDPOINTS + 1 },
            (_value, index) => ({ tag: `provider-${index}` })
          )
        }
      })
    ];
    const client = createOpenRouterDiscoveryClient({
      apiRoot: "https://openrouter.example.test/api/v1",
      bearerToken: "key",
      network: {
        dispatch: async () => responses.shift() ?? responseJson({ data: [] }),
        lookupHostname: publicLookup
      }
    });

    for (const operation of [
      () => client.listModels(),
      () => client.listModels(),
      () => client.listModels(),
      () => client.listModelEndpoints("vendor/model")
    ]) {
      try {
        await operation();
        throw new Error("Expected discovery response to be rejected.");
      } catch (error) {
        expectDiscoveryCode(error, "openrouter_discovery_response_invalid");
      }
    }
  });

  it("bounds successful bodies and keeps one absolute deadline through body consumption", async () => {
    vi.stubEnv("AIQSA_PROVIDER_RESPONSE_MAX_BYTES", "16");
    const oversized = createOpenRouterDiscoveryClient({
      apiRoot: "https://openrouter.example.test/api/v1",
      bearerToken: "key",
      network: {
        dispatch: async () => responseJson({ data: [{ id: "vendor/model" }] }),
        lookupHostname: publicLookup
      }
    });
    await expect(oversized.listModels()).rejects.toBeInstanceOf(
      ProviderResponseTooLargeError
    );

    vi.stubEnv("AIQSA_PROVIDER_RESPONSE_MAX_BYTES", "2097152");
    vi.useFakeTimers();
    try {
      let cancellationReason: unknown;
      const stalled = createOpenRouterDiscoveryClient({
        apiRoot: "https://openrouter.example.test/api/v1",
        bearerToken: "key",
        network: {
          dispatch: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                cancel(reason) {
                  cancellationReason = reason;
                },
                pull() {
                  // Keep the body pending beyond the absolute discovery deadline.
                }
              })
            ),
          lookupHostname: publicLookup
        },
        responseTimeoutMs: 5_000
      });

      const rejection = expect(stalled.listModels()).rejects.toMatchObject({
        code: "provider_request_timed_out",
        timeoutMs: 5_000
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
      expect(cancellationReason).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sanitizes HTTP failures and never follows their redirect target", async () => {
    const lookupHostname = vi.fn(publicLookup);
    const responses = [
      new Response(
        JSON.stringify({ error: { message: "<script>bad()</script> unavailable\u0000" } }),
        { status: 503 }
      ),
      new Response(null, {
        headers: { location: "https://metadata.example.test/latest" },
        status: 307
      })
    ];
    const client = createOpenRouterDiscoveryClient({
      apiRoot: "https://openrouter.example.test/api/v1",
      bearerToken: "key",
      network: {
        dispatch: async () => responses.shift() ?? responseJson({ data: [] }),
        lookupHostname
      }
    });

    await expect(client.listModels()).rejects.toThrow(
      "OpenRouter discovery request failed with status 503"
    );
    await expect(client.listModels()).rejects.toMatchObject({
      code: "provider_http_redirect_forbidden"
    });
    expect(lookupHostname).toHaveBeenCalledTimes(2);
  });
});
