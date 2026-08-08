import { describe, expect, it, vi } from "vitest";
import {
  createFakeEmbeddingAdapter,
  createOpenAICompatibleEmbeddingAdapter,
  EmbeddingAdapterError,
  MAX_EMBEDDING_BATCH_INPUTS
} from "./embeddings";
import {
  normalizeProviderModelConfiguration,
  ProviderConfigurationError,
  type EmbeddingModelConfiguration,
  type ProviderModelConfiguration
} from "./providerConfiguration";

const queryTemplate = "Instruct: retrieve relevant passages\nQuery: {text}";

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
        allowPrivateNetwork: false,
        apiRoot: "https://openrouter.ai/api/v1",
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

  it("applies the instruction to queries only and sends documents bare", async () => {
    const bodies: unknown[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return providerResponse([vector(4_096)]);
    });
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: { allowPrivateNetwork: false, apiRoot: "https://openrouter.ai/api/v1" },
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
      connection: { allowPrivateNetwork: false, apiRoot: "https://openrouter.ai/api/v1" },
      model: embeddingModel(),
      network: { fetchFn },
      secret: "openrouter-key"
    });

    await expect(adapter.embed({ mode: "document", texts: ["a", "b"] }))
      .rejects.toMatchObject({ code });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not retry or fall back after an upstream failure", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 }));
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: { allowPrivateNetwork: false, apiRoot: "https://openrouter.ai/api/v1" },
      model: embeddingModel(),
      network: { fetchFn },
      secret: "openrouter-key"
    });

    await expect(adapter.embed({ mode: "document", texts: ["one"] }))
      .rejects.toMatchObject({ code: "embedding_provider_http_error" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not classify upstream timeout text as the configured deadline", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new Error("upstream connect error: connection timeout");
    });
    const adapter = createOpenAICompatibleEmbeddingAdapter({
      connection: { allowPrivateNetwork: false, apiRoot: "https://openrouter.ai/api/v1" },
      model: embeddingModel(),
      network: { fetchFn },
      secret: "openrouter-key"
    });

    await expect(adapter.embed({ mode: "document", texts: ["one"] }))
      .rejects.toMatchObject({ code: "embedding_provider_request_failed" });
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
          allowPrivateNetwork: false,
          apiRoot: "https://openrouter.ai/api/v1",
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
      connection: { allowPrivateNetwork: false, apiRoot: "https://openrouter.ai/api/v1" },
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
