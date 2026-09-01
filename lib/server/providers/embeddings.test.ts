import { describe, expect, it, vi } from "vitest";
import {
  createOpenAICompatibleEmbeddingAdapter,
  EmbeddingAdapterError,
  MAX_EMBEDDING_BATCH_INPUTS,
  OPENROUTER_INTERACTIVE_EMBEDDING_HEDGE_DELAY_MS
} from "./embeddings";
import { createFakeEmbeddingAdapter } from "@/tests/support/embeddings";
import {
  normalizeProviderModelConfiguration,
  ProviderConfigurationError,
  type EmbeddingModelConfiguration,
  type ProviderModelConfiguration
} from "./providerConfiguration";
import { ProviderSafeFetchError } from "./providerSafeFetch";

const queryTemplate = "Instruct: retrieve relevant passages\nQuery: {text}";
const openRouterConnection = {
  allowPrivateNetwork: false,
  apiRoot: "https://openrouter.ai/api/v1",
  authenticationMode: "bearer" as const,
  responseTimeoutMs: 300_000
};

function embeddingModel(
  overrides: Partial<EmbeddingModelConfiguration> = {}
): ProviderModelConfiguration {
  return normalizeProviderModelConfiguration({
    adapterKind: "openai_embeddings_compatible",
    answerSelectable: false,
    capabilities: {
      contextWindow: 32_768,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      toolCalling: false,
      vision: false
    },
    defaultParams: {},
    embedding: {
      nativeDimension: 4_096,
      providerFamily: "openrouter",
      queryInstructionTemplate: queryTemplate,
      supportsMrl: true,
      targetDimension: 1_536,
      ...overrides
    },
    modelClass: "embedding",
    upstreamModelId: "qwen/qwen3-embedding-8b"
  });
}

function vector(dimension: number, offset = 0): number[] {
  return Array.from({ length: dimension }, (_, index) => (index + offset) % 17 + 1);
}

function providerResponse(
  vectors: readonly number[][],
  options: Readonly<{ model?: string; usage?: unknown }> = {}
): Response {
  return new Response(JSON.stringify({
    data: vectors.map((embedding, index) => ({ embedding, index, object: "embedding" })),
    model: options.model ?? "qwen/qwen3-embedding-8b",
    object: "list",
    usage: options.usage ?? { prompt_tokens: 12, total_tokens: 12 }
  }), {
    headers: {
      "content-type": "application/json",
      "x-request-id": "embedding-request-1"
    },
    status: 200
  });
}

function errorCode(error: unknown): string | null {
  return error instanceof EmbeddingAdapterError || error instanceof ProviderConfigurationError
    ? error.code
    : null;
}

describe("OpenAI-compatible embeddings", () => {
  it("requests full Qwen vectors once, truncates to 1536, normalizes, and captures usage", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => providerResponse([
      vector(4_096),
      vector(4_096, 3)
    ], { usage: { prompt_tokens: 0, total_tokens: 0 } }));
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: {
        ...openRouterConnection,
        responseTimeoutMs: 30_000
      },
      model: embeddingModel(),
      network: { fetchFn },
      secret: "openrouter-key"
    });

    const result = await adapter.embed({
      mode: "query",
      texts: ["first", "second"]
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/embeddings");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      encoding_format: "float",
      model: "qwen/qwen3-embedding-8b",
      provider: { allow_fallbacks: false, data_collection: "deny" }
    });
    expect(body).not.toHaveProperty("dimensions");
    expect(body.input).toEqual([
      "Instruct: retrieve relevant passages\nQuery: first",
      "Instruct: retrieve relevant passages\nQuery: second"
    ]);
    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toHaveLength(1_536);
    expect(Math.sqrt(result.vectors[0]!.reduce((sum, value) => sum + value * value, 0)))
      .toBeCloseTo(1, 12);
    expect(result.usage).toEqual({ inputTokens: 0, totalTokens: 0 });
    expect(result.requestId).toBe("embedding-request-1");
  });

  it("pins the ordered Qwen document route and falls back only inside it", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => providerResponse([vector(4_096)]));
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: openRouterConnection,
      model: {
        ...embeddingModel(),
        openRouterRouting: {
          mode: "only_selected",
          providers: ["nebius", "deepinfra"]
        }
      },
      network: { fetchFn },
      secret: "openrouter-key"
    });

    await adapter.embed({ mode: "document", texts: ["one"] });

    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body.provider).toEqual({
      allow_fallbacks: true,
      data_collection: "deny",
      only: ["nebius", "deepinfra"],
      order: ["nebius", "deepinfra"]
    });
  });

  it("keeps a successful interactive query on the primary provider", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => providerResponse([vector(4_096)]));
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: openRouterConnection,
      model: {
        ...embeddingModel(),
        openRouterRouting: {
          mode: "only_selected",
          providers: ["nebius", "deepinfra"]
        }
      },
      network: { fetchFn },
      secret: "openrouter-key"
    });

    const result = await adapter.embed({ mode: "query", texts: ["one"] });

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      providerRequestCount: 1,
      providerRequestRoutes: ["nebius"]
    });
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body.provider).toEqual({
      allow_fallbacks: false,
      data_collection: "deny",
      only: ["nebius"],
      order: ["nebius"]
    });
  });

  it("hedges an interactive pre-instructed query onto the next selected provider", async () => {
    vi.useFakeTimers();
    try {
      let primarySignal: AbortSignal | undefined;
      const bodies: Array<Record<string, unknown>> = [];
      const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        const provider = body.provider as { only: string[] };
        if (provider.only[0] === "nebius") {
          primarySignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            const rejectFromSignal = () => reject(primarySignal?.reason);
            if (primarySignal?.aborted) rejectFromSignal();
            else primarySignal?.addEventListener("abort", rejectFromSignal, { once: true });
          });
        }
        return providerResponse([vector(4_096)]);
      });
      const adapter = createOpenAICompatibleEmbeddingAdapter({
        connection: openRouterConnection,
        model: {
          ...embeddingModel(),
          openRouterRouting: {
            mode: "only_selected",
            providers: ["nebius", "deepinfra"]
          }
        },
        network: { fetchFn, retry: { maxAttempts: 1 } },
        secret: "openrouter-key"
      });

      const pending = adapter.embed({
        latencyClass: "interactive",
        mode: "document",
        texts: ["pre-instructed query"]
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchFn).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(
        OPENROUTER_INTERACTIVE_EMBEDDING_HEDGE_DELAY_MS
      );

      await expect(pending).resolves.toMatchObject({
        model: "qwen/qwen3-embedding-8b",
        providerRequestCount: 2,
        providerRequestRoutes: ["nebius", "deepinfra"]
      });
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(bodies.map((body) => body.provider)).toEqual([
        {
          allow_fallbacks: false,
          data_collection: "deny",
          only: ["nebius"],
          order: ["nebius"]
        },
        {
          allow_fallbacks: false,
          data_collection: "deny",
          only: ["deepinfra"],
          order: ["deepinfra"]
        }
      ]);
      expect(primarySignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records both pinned routes when an interactive hedge is cancelled", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("missing_signal");
        return new Promise<Response>((_resolve, reject) => {
          const rejectFromSignal = () => reject(signal.reason);
          if (signal.aborted) rejectFromSignal();
          else signal.addEventListener("abort", rejectFromSignal, { once: true });
        });
      });
      const adapter = createOpenAICompatibleEmbeddingAdapter({
        connection: openRouterConnection,
        model: {
          ...embeddingModel(),
          openRouterRouting: {
            mode: "only_selected",
            providers: ["nebius", "deepinfra"]
          }
        },
        network: { fetchFn, retry: { maxAttempts: 1 } },
        secret: "openrouter-key"
      });
      const pending = adapter.embed({
        latencyClass: "interactive",
        mode: "document",
        signal: controller.signal,
        texts: ["pre-instructed query"]
      });

      await vi.advanceTimersByTimeAsync(
        OPENROUTER_INTERACTIVE_EMBEDDING_HEDGE_DELAY_MS
      );
      expect(fetchFn).toHaveBeenCalledTimes(2);
      controller.abort({ code: "test_query_embedding_timeout" });

      await expect(pending).rejects.toMatchObject({
        code: "embedding_provider_request_failed",
        providerRequestCount: 2,
        providerRequestRoutes: ["nebius", "deepinfra"]
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps explicit Automatic OpenRouter embedding routing unrestricted", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => providerResponse([vector(4_096)]));
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: openRouterConnection,
      model: {
        ...embeddingModel(),
        openRouterRouting: { mode: "automatic", providers: [] }
      },
      network: { fetchFn },
      secret: "openrouter-key"
    });

    await adapter.embed({ mode: "document", texts: ["one"] });

    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body.provider).toEqual({
      allow_fallbacks: true,
      data_collection: "deny"
    });
  });

  it("accepts OpenRouter's exact unnamespaced response slug", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => providerResponse([
      vector(4_096)
    ], { model: "qwen3-embedding-8b" }));
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: openRouterConnection,
      model: embeddingModel(),
      network: { fetchFn },
      secret: "openrouter-key"
    });

    await expect(adapter.embed({ mode: "document", texts: ["one"] }))
      .resolves.toMatchObject({ model: "qwen3-embedding-8b" });
  });

  it("accepts OpenRouter's case-normalized canonical model id", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => providerResponse([
      vector(4_096)
    ], { model: "Qwen/Qwen3-Embedding-8B" }));
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: openRouterConnection,
      model: embeddingModel(),
      network: { fetchFn },
      secret: "openrouter-key"
    });

    await expect(adapter.embed({ mode: "document", texts: ["one"] }))
      .resolves.toMatchObject({ model: "Qwen/Qwen3-Embedding-8B" });
  });

  it("rejects any other namespaced response model", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => providerResponse([
      vector(4_096)
    ], { model: "other/qwen3-embedding-8b" }));
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: openRouterConnection,
      model: embeddingModel(),
      network: { fetchFn },
      secret: "openrouter-key"
    });

    await expect(adapter.embed({ mode: "document", texts: ["one"] }))
      .rejects.toMatchObject({ code: "embedding_response_model_mismatch" });
  });

  it("applies the instruction to queries only and sends documents bare", async () => {
    const bodies: unknown[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return providerResponse([vector(4_096)]);
    });
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: openRouterConnection,
      model: embeddingModel(),
      network: { fetchFn },
      secret: "openrouter-key"
    });

    await adapter.embed({ mode: "query", texts: ["same text"] });
    await adapter.embed({ mode: "document", texts: ["same text"] });

    expect(bodies).toEqual([
      expect.objectContaining({
        input: ["Instruct: retrieve relevant passages\nQuery: same text"]
      }),
      expect.objectContaining({ input: ["same text"] })
    ]);
  });

  it("inserts every native replacement-token sequence as literal query text", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => providerResponse([vector(4_096)]));
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: openRouterConnection,
      model: embeddingModel(),
      network: { fetchFn },
      secret: "openrouter-key"
    });
    const text = "price $$; match $&; prefix $`; suffix $'";

    await adapter.embed({ mode: "query", texts: [text] });

    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as {
      input: string[];
    };
    expect(body.input).toEqual([
      `Instruct: retrieve relevant passages\nQuery: ${text}`
    ]);
  });

  it.each([
    {
      code: "embedding_response_count_mismatch",
      response: providerResponse([vector(4_096)])
    },
    {
      code: "embedding_response_dimension_mismatch",
      response: providerResponse([vector(4_096), vector(4_095)])
    },
    {
      code: "embedding_response_vector_invalid",
      response: providerResponse([
        vector(4_096),
        [...vector(4_095), Number.NaN]
      ])
    }
  ])("fails closed with $code", async ({ code, response }) => {
    const fetchFn = vi.fn<typeof fetch>(async () => response);
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: openRouterConnection,
      model: embeddingModel(),
      network: { fetchFn },
      secret: "openrouter-key"
    });

    await expect(adapter.embed({ mode: "document", texts: ["a", "b"] }))
      .rejects.toMatchObject({ code });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient upstream failure with Retry-After on the same route", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", {
        headers: { "retry-after": "75" },
        status: 503
      }))
      .mockResolvedValueOnce(providerResponse([vector(4_096)]));
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: openRouterConnection,
      model: embeddingModel(),
      network: { fetchFn, retry: { sleep } },
      secret: "openrouter-key"
    });

    await expect(adapter.embed({ mode: "document", texts: ["one"] }))
      .resolves.toMatchObject({ model: "qwen/qwen3-embedding-8b" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(75_000, expect.any(AbortSignal));
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      "https://openrouter.ai/api/v1/embeddings",
      "https://openrouter.ai/api/v1/embeddings"
    ]);
  });

  it("surfaces the final transient status after bounded retries", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("unavailable", {
      headers: { "retry-after": "1" },
      status: 503
    }));
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: openRouterConnection,
      model: embeddingModel(),
      network: { fetchFn, retry: { sleep: async () => undefined } },
      secret: "openrouter-key"
    });

    await expect(adapter.embed({ mode: "document", texts: ["one"] }))
      .rejects.toMatchObject({
        code: "embedding_provider_http_error",
        httpStatus: 503,
        providerRequestCount: 4,
        providerRequestRoutes: [null, null, null, null],
        retryAfterMs: 1_000
      });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("preserves a permanent upstream status without retaining its response body", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("private invalid request", {
      headers: { "retry-after": "not-a-delay" },
      status: 400
    }));
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: openRouterConnection,
      model: embeddingModel(),
      network: { fetchFn },
      secret: "openrouter-key"
    });

    await expect(adapter.embed({ mode: "document", texts: ["one"] }))
      .rejects.toMatchObject({
        code: "embedding_provider_http_error",
        httpStatus: 400,
        retryAfterMs: null
      });
  });

  it("does not retry permanent safe-fetch policy failures", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new ProviderSafeFetchError("provider_http_origin_forbidden");
    });
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: openRouterConnection,
      model: embeddingModel(),
      network: { fetchFn, retry: { sleep: async () => undefined } },
      secret: "openrouter-key"
    });

    await expect(adapter.embed({ mode: "document", texts: ["one"] }))
      .rejects.toMatchObject({ code: "embedding_provider_request_failed" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("does not classify upstream timeout text as the configured deadline", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new TypeError("upstream connect error: connection timeout");
    });
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: openRouterConnection,
      model: embeddingModel(),
      network: { fetchFn, retry: { sleep: async () => undefined } },
      secret: "openrouter-key"
    });

    await expect(adapter.embed({ mode: "document", texts: ["one"] }))
      .rejects.toMatchObject({ code: "embedding_provider_request_failed" });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("classifies its own elapsed request deadline explicitly", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("missing_signal");
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
      const adapter = createOpenAICompatibleEmbeddingAdapter({
        connection: {
          ...openRouterConnection,
          responseTimeoutMs: 5_000
        },
        model: embeddingModel(),
        network: { fetchFn },
        secret: "openrouter-key"
      });
      const timedOut = expect(adapter.embed({ mode: "document", texts: ["one"] }))
        .rejects.toMatchObject({ code: "embedding_request_timed_out" });

      await vi.advanceTimersByTimeAsync(5_000);

      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces bounded batches before the network", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: openRouterConnection,
      model: embeddingModel(),
      network: { fetchFn },
      secret: "openrouter-key"
    });

    await expect(adapter.embed({
      mode: "document",
      texts: Array.from({ length: MAX_EMBEDDING_BATCH_INPUTS + 1 }, () => "text")
    })).rejects.toMatchObject({ code: "embedding_batch_invalid" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("embedding configuration and fake adapter", () => {
  it("rejects BGE-M3 truncation when MRL is disabled", () => {
    expect(() => embeddingModel({
      nativeDimension: 1_024,
      providerFamily: "openrouter",
      queryInstructionTemplate: null,
      supportsMrl: false,
      targetDimension: 768
    })).toThrowError(expect.objectContaining({
      code: "provider_embedding_configuration_invalid"
    }));
  });

  it("returns deterministic native 1024-dimensional BGE vectors", async () => {
    const configuration: EmbeddingModelConfiguration = {
      nativeDimension: 1_024,
      providerFamily: "openrouter",
      queryInstructionTemplate: null,
      supportsMrl: false,
      targetDimension: 1_024
    };
    const adapter = createFakeEmbeddingAdapter({ configuration, seed: "test-seed" });

    const first = await adapter.embed({ mode: "document", texts: ["document"] });
    const second = await adapter.embed({ mode: "document", texts: ["document"] });

    expect(first.vectors[0]).toHaveLength(1_024);
    expect(first.vectors[0]).toEqual(second.vectors[0]);
    expect(Math.sqrt(first.vectors[0]!.reduce((sum, value) => sum + value * value, 0)))
      .toBeCloseTo(1, 12);
  });

  it("seeds query and document fakes from their distinct prepared text", async () => {
    const adapter = createFakeEmbeddingAdapter({
      configuration: embeddingModel().embedding!
    });
    const query = await adapter.embed({ mode: "query", texts: ["same"] });
    const document = await adapter.embed({ mode: "document", texts: ["same"] });
    expect(query.vectors[0]).not.toEqual(document.vectors[0]);
  });

  it("exposes stable configuration errors", () => {
    expect(errorCode(new ProviderConfigurationError(
      "provider_embedding_configuration_invalid"
    ))).toBe("provider_embedding_configuration_invalid");
  });
});
