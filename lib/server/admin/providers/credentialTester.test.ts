import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpPinnedHttpRequest } from "../../mcp/safeFetch";
import {
  AdminProviderCredentialTestError,
  createAdminProviderCredentialTester,
  MAX_PROVIDER_CREDENTIAL_TEST_MODELS,
  type AdminProviderCredentialTesterInput
} from "./credentialTester";
import { discoverAdminCompatibleModels } from "@/components/admin/adminProvidersApi";

const publicLookup = async () => [
  { address: "93.184.216.34", family: 4 as const }
];

function input(
  family: AdminProviderCredentialTesterInput["family"],
  secret: AdminProviderCredentialTesterInput["secret"] = "exact-secret",
  connection: Partial<AdminProviderCredentialTesterInput["connection"]> = {}
): AdminProviderCredentialTesterInput {
  return {
    connection: {
      allowPrivateNetwork: false,
      apiRoot: `https://${family}.example.test/v1/`,
      authenticationMode: "bearer",
      responseTimeoutMs: 300_000,
      ...connection
    },
    family,
    secret
  };
}

function catalog(ids: string[], status = 200): Response {
  return new Response(JSON.stringify({
    data: ids.map((id) => ({ id, ignored: "remote metadata" }))
  }), {
    headers: { "content-type": "application/json" },
    status
  });
}

function expectStableFailure(error: unknown, forbiddenValue?: string): void {
  expect(error).toBeInstanceOf(AdminProviderCredentialTestError);
  expect(error).toMatchObject({
    code: "provider_credential_test_failed",
    message: "provider_credential_test_failed",
    name: "AdminProviderCredentialTestError"
  });
  if (forbiddenValue) expect(String(error)).not.toContain(forbiddenValue);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("admin provider credential tester", () => {
  it("feeds the actual compatible catalog projection through the client decoder", async () => {
    const tester = createAdminProviderCredentialTester({
      network: {
        dispatch: async () => new Response(JSON.stringify({
          data: [{
            capabilities: {
              context_length: 128_000,
              supports_reasoning: true
            },
            id: "vendor/model",
            owned_by: "codex-lb",
            supported_reasoning_levels: ["low", "high"]
          }]
        }), {
          headers: { "content-type": "application/json" },
          status: 200
        }),
        lookupHostname: publicLookup
      }
    });
    const outcome = await tester.test({
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://compatible.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      family: "openai_compatible",
      secret: "catalog-key"
    });
    expect(outcome.responsesRequestIsolationDetected).toBe(true);
    expect(outcome.models).toEqual([{
      capabilities: {
        contextWindow: 128_000,
        defaultReasoningEffort: "low",
        reasoning: true,
        reasoningEfforts: ["low", "high"]
      },
      id: "vendor/model",
      ownedBy: "codex-lb"
    }]);

    const fetcher = vi.fn(async () => Response.json({ models: outcome.models }));
    await expect(discoverAdminCompatibleModels(
      "connection/one",
      "credential/one",
      fetcher
    )).resolves.toEqual({ data: outcome.models, ok: true });
  });

  it("retains an authenticated chat catalog when optional image discovery is unavailable", async () => {
    const dispatch = vi.fn().mockResolvedValueOnce(catalog(["chat-model"]))
      .mockResolvedValue(new Response("{}", { status: 503 }));
    const tester = createAdminProviderCredentialTester({ network: { lookupHostname: publicLookup, dispatch } });
    await expect(tester.test({ ...input("openai"), modelClasses: ["answer", "image"] })).resolves.toMatchObject({
      modelIds: ["chat-model"], imageModels: [], modelIdsByClass: { answer: ["chat-model"], image: [] }
    });
    await expect(tester.test({ ...input("openai"), modelClasses: ["image"] })).rejects.toBeInstanceOf(AdminProviderCredentialTestError);
  });

  it("keeps only bounded per-model tool/image/parallel hints and distinct output ceilings", async () => {
    const tester = createAdminProviderCredentialTester({ network: { lookupHostname: publicLookup,
      dispatch: async () => Response.json({ data: [
        { id: "terra", capabilities: { supports_tool_use: true, supports_images: true, supports_vision: true,
          input_modalities: ["text", "image"], context_length: 272_000, max_output_tokens: 65_536 },
          metadata: { supports_parallel_tool_calls: true, secret_extra: "PRIVATE_METADATA" } },
        { id: "astra", capabilities: { supports_tool_use: false, supports_images: "true", context_length: 128_000 },
          metadata: { supports_tool_use: true, supports_parallel_tool_calls: false } },
        { id: "unknown", capabilities: { supports_tool_use: {}, supports_vision: "true" }, metadata: { arbitrary: { supports_parallel_tool_calls: true } } }
      ] }) } });
    const outcome = await tester.test(input("openai_compatible"));
    expect(outcome.models).toEqual([
      { id: "terra", capabilities: { toolCalling: true, vision: true, parallelToolCalls: true, contextWindow: 272_000, maxOutputTokens: 65_536 } },
      { id: "astra", capabilities: { toolCalling: false, parallelToolCalls: false, contextWindow: 128_000 } },
      { id: "unknown", capabilities: {} }
    ]);
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_METADATA");
  });

  it("keeps OpenRouter answer, embedding, and reranker catalogs class-specific", async () => {
    const requests: McpPinnedHttpRequest[] = [];
    const tester = createAdminProviderCredentialTester({
      network: {
        dispatch: async (request) => {
          requests.push(request);
          if (request.url.pathname.endsWith("/embeddings/models")) {
            return catalog(["qwen/qwen3-embedding-8b"]);
          }
          if (request.url.searchParams.get("output_modalities") === "rerank") {
            return new Response(JSON.stringify({
              data: [{
                architecture: { output_modalities: ["rerank"] },
                id: "qwen/qwen3-reranker-8b"
              }, {
                architecture: { output_modalities: ["text"] },
                id: "must-not-be-classified-as-reranker"
              }]
            }));
          }
          return catalog(["openai/gpt-5.6-sol"]);
        },
        lookupHostname: publicLookup
      }
    });

    await expect(tester.test({
      ...input("openrouter"),
      modelClasses: ["answer", "embedding", "reranker"]
    })).resolves.toMatchObject({
      modelIds: [
        "openai/gpt-5.6-sol",
        "qwen/qwen3-embedding-8b",
        "qwen/qwen3-reranker-8b"
      ],
      modelIdsByClass: {
        answer: ["openai/gpt-5.6-sol"],
        embedding: ["qwen/qwen3-embedding-8b"],
        reranker: ["qwen/qwen3-reranker-8b"]
      }
    });
    expect(requests.map(({ url }) => `${url.pathname}${url.search}`)).toEqual([
      "/v1/models/user",
      "/v1/embeddings/models",
      "/v1/models?output_modalities=rerank"
    ]);
  });

  it.each([
    {
      family: "openai" as const,
      path: "/v1/models",
      expectedHeaders: {
        authorization: "Bearer exact-secret"
      }
    },
    {
      family: "openai_compatible" as const,
      path: "/v1/models",
      expectedHeaders: {
        authorization: "Bearer exact-secret"
      }
    },
    {
      family: "anthropic" as const,
      path: "/v1/models",
      expectedHeaders: {
        "anthropic-version": "2023-06-01",
        "x-api-key": "exact-secret"
      }
    },
    {
      family: "gemini" as const,
      path: "/v1/models",
      expectedHeaders: {
        "x-goog-api-key": "exact-secret"
      }
    },
    {
      family: "openrouter" as const,
      path: "/v1/models/user",
      expectedHeaders: {
        authorization: "Bearer exact-secret"
      }
    }
  ])("uses the reviewed $family catalog path and authentication headers", async ({
    expectedHeaders,
    family,
    path
  }) => {
    const requests: McpPinnedHttpRequest[] = [];
    const tester = createAdminProviderCredentialTester({
      network: {
        dispatch: async (request) => {
          requests.push(request);
          return family === "gemini"
            ? new Response(JSON.stringify({
                models: ["model-b", "model-a", "model-b"].map((name) => ({ name }))
              }))
            : catalog(["model-b", "model-a", "model-b"]);
        },
        lookupHostname: publicLookup
      }
    });

    await expect(tester.test(input(family))).resolves.toEqual({
      method: "models_catalog",
      modelIds: ["model-b", "model-a"],
      ...(family === "openai_compatible" ? {
        responsesRequestIsolationDetected: false,
        models: [
          { capabilities: {}, id: "model-b" },
          { capabilities: {}, id: "model-a" }
        ]
      } : {})
    });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url.pathname).toBe(path);
    expect(request.method).toBe("GET");
    expect(request.body).toBeNull();
    expect(request.headers.get("accept")).toBe("application/json");
    for (const [name, value] of Object.entries(expectedHeaders)) {
      expect(request.headers.get(name)).toBe(value);
    }
    if (family === "anthropic" || family === "gemini") {
      expect(request.headers.has("authorization")).toBe(false);
    } else {
      expect(request.headers.has("x-api-key")).toBe(false);
      expect(request.headers.has("anthropic-version")).toBe(false);
    }
  });

  it("omits authorization only for an explicit keyless private HTTP connection", async () => {
    const requests: McpPinnedHttpRequest[] = [];
    const tester = createAdminProviderCredentialTester({
      network: {
        dispatch: async (request) => {
          requests.push(request);
          return catalog(["local-model"]);
        },
        lookupHostname: async () => [{ address: "127.0.0.1", family: 4 as const }]
      }
    });

    await expect(tester.test({
      connection: {
        allowPrivateNetwork: true,
        apiRoot: "http://127.0.0.1:8080/v1",
        authenticationMode: "none",
        responseTimeoutMs: 300_000
      },
      family: "openai_compatible",
      secret: null
    })).resolves.toEqual({
      method: "models_catalog",
      modelIds: ["local-model"],
      responsesRequestIsolationDetected: false,
      models: [{ capabilities: {}, id: "local-model" }]
    });
    expect(requests[0]?.headers.has("authorization")).toBe(false);
  });

  it("normalizes Gemini catalog resource names before policy matching", async () => {
    const tester = createAdminProviderCredentialTester({
      network: {
        dispatch: async () => new Response(JSON.stringify({
          models: [
            "models/gemini-3.6-flash",
            "gemini-3.5-flash",
            "models/gemini-3.6-flash",
            "models/gemini-3.5-flash-lite",
            "models/gemini-3.1-pro-preview"
          ].map((name) => ({ name }))
        })),
        lookupHostname: publicLookup
      }
    });

    await expect(tester.test(input("gemini"))).resolves.toEqual({
      method: "models_catalog",
      modelIds: [
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-pro-preview"
      ]
    });
  });

  it("resolves a lazy secret once and never includes it in the result", async () => {
    const source = vi.fn(async () => "  lazy-exact-secret  ");
    const requests: McpPinnedHttpRequest[] = [];
    const tester = createAdminProviderCredentialTester({
      network: {
        dispatch: async (request) => {
          requests.push(request);
          return catalog(["model-1"]);
        },
        lookupHostname: publicLookup
      }
    });

    const result = await tester.test(input("openai", source));
    expect(source).toHaveBeenCalledOnce();
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer lazy-exact-secret");
    expect(JSON.stringify(result)).not.toContain("lazy-exact-secret");
  });

  it("returns only bounded compatible reasoning and token metadata", async () => {
    const tester = createAdminProviderCredentialTester({
      network: {
        dispatch: async () => Response.json({
          data: [{
            contextWindow: 272_000,
            id: "gpt-5.6-sol",
            ignoredCredentialHint: "must-not-enter-the-result",
            metadata: {
              default_reasoning_level: "low",
              default_reasoning_mode: "standard",
              internal_route: "must-not-enter-the-result",
              supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
              supported_reasoning_modes: ["standard", "pro"]
            },
            supportsReasoning: true
          }]
        }),
        lookupHostname: publicLookup
      }
    });

    const result = await tester.test(input("openai_compatible"));

    expect(result).toEqual({
      method: "models_catalog",
      modelIds: ["gpt-5.6-sol"],
      responsesRequestIsolationDetected: false,
      models: [{
        capabilities: {
          contextWindow: 272_000,
          defaultReasoningEffort: "low",
          defaultReasoningMode: "standard",
          reasoning: true,
          reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
          reasoningModes: ["standard", "pro"]
        },
        id: "gpt-5.6-sol"
      }]
    });
    expect(JSON.stringify(result)).not.toContain("must-not-enter-the-result");
  });

  it.each([
    { data: {} },
    { data: [null] },
    { data: [{}] },
    { data: [{ id: " " }] },
    { data: [{ id: "bad\u0000id" }] },
    { data: [{ id: "x".repeat(257) }] },
    { models: [{ id: "model-1" }] }
  ])("rejects a non-standard catalog without reflecting it", async (body) => {
    const tester = createAdminProviderCredentialTester({
      network: {
        dispatch: async () => new Response(JSON.stringify(body)),
        lookupHostname: publicLookup
      }
    });
    try {
      await tester.test(input("openai"));
      throw new Error("Expected the credential catalog to be rejected.");
    } catch (error) {
      expectStableFailure(error);
    }
  });

  it.each([
    { label: "all exact markers", entries: [{ id: "one", owned_by: "codex-lb" }, { id: "two", owned_by: "codex-lb" }], detected: true },
    { label: "empty catalog", entries: [], detected: false },
    { label: "unmarked model", entries: [{ id: "codex-lb-model" }], detected: false },
    { label: "mixed owners", entries: [{ id: "one", owned_by: "codex-lb" }, { id: "two", owned_by: "other" }], detected: false },
    { label: "whitespace marker", entries: [{ id: "one", owned_by: " codex-lb " }], detected: false },
    { label: "blank marker", entries: [{ id: "one", owned_by: "   " }], detected: false },
    { label: "uppercase marker", entries: [{ id: "one", owned_by: "CODEX-LB" }], detected: false },
    { label: "wrong marker type", entries: [{ id: "one", owned_by: ["codex-lb"] }], detected: false },
    { label: "duplicate positive marker", entries: [{ id: "one", owned_by: "codex-lb" }, { id: "one", owned_by: "codex-lb" }], detected: true },
    { label: "duplicate conflicting owner", entries: [{ id: "one", owned_by: "codex-lb" }, { id: "one", owned_by: "other" }], detected: false },
    { label: "duplicate unmarked owner", entries: [{ id: "one", owned_by: "codex-lb" }, { id: "one" }], detected: false }
  ])("detects routing isolation from the complete raw catalog: $label", async ({ label, entries, detected }) => {
    const dispatch = vi.fn(async () => Response.json({ data: entries }));
    const tester = createAdminProviderCredentialTester({ network: { lookupHostname: publicLookup, dispatch } });
    const result = await tester.test(input("openai_compatible", "codex-lb-looking-key", {
      apiRoot: "https://codex-lb.example.test/v1"
    }));
    expect(result.responsesRequestIsolationDetected).toBe(detected);
    expect(result.modelIds).toEqual([...new Set(entries.map((entry) => entry.id))]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    if (label === "whitespace marker") expect(result.models?.[0]?.ownedBy).toBe(" codex-lb ");
    if (label === "blank marker") expect(result.models?.[0]).not.toHaveProperty("ownedBy");
  });

  it("does not accept an all-marked malformed compatible catalog", async () => {
    const tester = createAdminProviderCredentialTester({ network: { lookupHostname: publicLookup,
      dispatch: async () => Response.json({ data: [{ id: "one", owned_by: "codex-lb" }, { owned_by: "codex-lb" }] })
    } });
    await expect(tester.test(input("openai_compatible"))).rejects.toMatchObject({ code: "provider_credential_test_failed" });
  });

  it("requires every loaded class catalog to have the marker and leaves native connections alone", async () => {
    const dispatch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "one", owned_by: "codex-lb" }] }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "one" }] }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "one", owned_by: "codex-lb" }] }));
    const tester = createAdminProviderCredentialTester({ network: { lookupHostname: publicLookup, dispatch } });
    const result = await tester.test({ ...input("openai_compatible"), modelClasses: ["answer", "embedding"] });
    expect(result.responsesRequestIsolationDetected).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(await tester.test(input("openai"))).not.toHaveProperty("responsesRequestIsolationDetected");
  });

  it("detects the explicit marker on an allowed keyless private endpoint", async () => {
    const dispatch = vi.fn(async () => Response.json({ data: [{ id: "local", owned_by: "codex-lb" }] }));
    const tester = createAdminProviderCredentialTester({ network: { dispatch,
      lookupHostname: async () => [{ address: "127.0.0.1", family: 4 as const }]
    } });
    const result = await tester.test(input("openai_compatible", null, {
      allowPrivateNetwork: true, apiRoot: "http://127.0.0.1:8080/v1", authenticationMode: "none"
    }));
    expect(result.responsesRequestIsolationDetected).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects catalog count and response-byte overflows with one stable error", async () => {
    const responses = [
      catalog(Array.from(
        { length: MAX_PROVIDER_CREDENTIAL_TEST_MODELS + 1 },
        (_value, index) => `model-${index}`
      )),
      catalog(["model-with-a-body-that-exceeds-the-test-limit"])
    ];
    const tester = createAdminProviderCredentialTester({
      network: {
        dispatch: async () => responses.shift()!,
        lookupHostname: publicLookup
      }
    });

    try {
      await tester.test(input("anthropic"));
      throw new Error("Expected catalog count overflow.");
    } catch (error) {
      expectStableFailure(error);
    }

    vi.stubEnv("AIQSA_PROVIDER_RESPONSE_MAX_BYTES", "16");
    try {
      await tester.test(input("anthropic"));
      throw new Error("Expected catalog byte overflow.");
    } catch (error) {
      expectStableFailure(error);
    }
  });

  it("discards non-success bodies and never exposes the exact secret or remote error", async () => {
    const secret = "never-reflect-this-secret";
    const remoteError = `invalid key ${secret}`;
    const tester = createAdminProviderCredentialTester({
      network: {
        dispatch: async () => new Response(remoteError, { status: 401 }),
        lookupHostname: publicLookup
      }
    });

    try {
      await tester.test(input("openrouter", secret));
      throw new Error("Expected a non-success response.");
    } catch (error) {
      expectStableFailure(error, secret);
      expect(String(error)).not.toContain(remoteError);
    }
  });

  it("keeps one timeout through body consumption and rejects redirects", async () => {
    vi.useFakeTimers();
    let cancellationReason: unknown;
    try {
      const stalled = createAdminProviderCredentialTester({
        network: {
          dispatch: async () => new Response(new ReadableStream<Uint8Array>({
            cancel(reason) {
              cancellationReason = reason;
            },
            pull() {
              // Keep the body pending beyond the absolute credential-test deadline.
            }
          })),
          lookupHostname: publicLookup
        }
      });
      const rejection = expect(stalled.test(input(
        "openai",
        "exact-secret",
        { responseTimeoutMs: 5_000 }
      ))).rejects.toMatchObject({
        code: "provider_credential_test_failed"
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
    expect(cancellationReason).toBeInstanceOf(Error);

    const redirected = createAdminProviderCredentialTester({
      network: {
        dispatch: async () => new Response(null, {
          headers: { location: "https://attacker.example.test/models" },
          status: 302
        }),
        lookupHostname: publicLookup
      }
    });
    try {
      await redirected.test(input("openai"));
      throw new Error("Expected a redirect to be rejected.");
    } catch (error) {
      expectStableFailure(error);
    }
  });
});
