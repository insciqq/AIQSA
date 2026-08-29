import { describe, expect, it, vi } from "vitest";
import {
  createOpenRouterRerankAdapter,
  MAX_RERANK_DOCUMENT_CHARACTERS,
  MAX_RERANK_DOCUMENTS
} from "./rerank";
import { normalizeProviderModelConfiguration } from "./providerConfiguration";

const connection = {
  allowPrivateNetwork: false,
  apiRoot: "https://openrouter.ai/api/v1",
  authenticationMode: "bearer" as const,
  responseTimeoutMs: 30_000
};

function rerankerModel(
  upstreamModelId = "qwen/qwen3-reranker-8b",
  providers: readonly string[] = ["Together", "DeepInfra"]
) {
  return normalizeProviderModelConfiguration({
    adapterKind: "openrouter_rerank",
    answerSelectable: false,
    capabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      toolCalling: false,
      vision: false
    },
    defaultParams: {},
    modelClass: "reranker",
    openRouterRouting: {
      mode: "only_selected",
      providers: [...providers]
    },
    upstreamModelId
  });
}

function response(input: Readonly<{
  model?: string;
  provider?: string;
  results?: unknown[];
  usage?: unknown;
}> = {}): Response {
  return new Response(JSON.stringify({
    id: "rerank-request-1",
    model: input.model ?? "qwen/qwen3-reranker-8b",
    provider: input.provider ?? "Together",
    results: input.results ?? [
      { index: 1, relevance_score: 0.91 },
      { index: 0, relevance_score: 0.42 }
    ],
    usage: input.usage ?? {
      prompt_tokens: 23,
      search_units: 1,
      total_tokens: 23
    }
  }), {
    headers: {
      "content-type": "application/json",
      "x-request-id": "header-request-id"
    },
    status: 200
  });
}

function adapter(fetchFn: typeof fetch, responseMaxBytes?: number) {
  return createOpenRouterRerankAdapter({
    connection,
    model: rerankerModel(),
    network: { fetchFn, ...(responseMaxBytes ? { responseMaxBytes } : {}) },
    secret: "openrouter-secret"
  });
}

describe("OpenRouter reranker adapter", () => {
  it("sends one score-only request with exact routing and rejoins opaque handles", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response());
    const result = await adapter(fetchFn).rerank({
      documents: [
        { handle: "c0", text: "[date_from=2026-01-01] first evidence" },
        { handle: "c1", text: "[date_from=2026-01-02] second evidence" }
      ],
      instruction: "Rank conversational evidence.",
      query: "What happened?"
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/rerank");
    expect(new Headers(init?.headers).get("authorization"))
      .toBe("Bearer openrouter-secret");
    expect(JSON.parse(String(init?.body))).toEqual({
      documents: [
        "[date_from=2026-01-01] first evidence",
        "[date_from=2026-01-02] second evidence"
      ],
      model: "qwen/qwen3-reranker-8b",
      provider: {
        allow_fallbacks: false,
        data_collection: "deny",
        only: ["Together", "DeepInfra"],
        order: ["Together", "DeepInfra"]
      },
      query: "Rank conversational evidence.\n\nWhat happened?",
      top_n: 2
    });
    expect(result).toEqual({
      model: "qwen/qwen3-reranker-8b",
      provider: "Together",
      requestId: "rerank-request-1",
      scores: [
        { handle: "c1", index: 1, relevanceScore: 0.91 },
        { handle: "c0", index: 0, relevanceScore: 0.42 }
      ],
      usage: { inputTokens: 23, searchUnits: 1, totalTokens: 23 }
    });
  });

  it.each([
    ["missing index", [
      { index: 2, relevance_score: 0.88 },
      { index: 0, relevance_score: 0.35 }
    ]],
    ["duplicate index", [
      { index: 2, relevance_score: 0.88 },
      { index: 2, relevance_score: 0.1 },
      { index: 0, relevance_score: 0.35 }
    ]],
    ["unknown index", [
      { index: 2, relevance_score: 0.88 },
      { index: 3, relevance_score: 0.1 },
      { index: 0, relevance_score: 0.35 }
    ]],
    ["malformed entry", [
      { index: 2, relevance_score: 0.88 },
      { relevance_score: 0.1 },
      { index: 0, relevance_score: 0.35 }
    ]],
    ["invalid score", [
      { index: 2, relevance_score: 0.88 },
      { index: 1, relevance_score: 4 },
      { index: 0, relevance_score: 0.35 }
    ]]
  ] as const)("rejects the complete response for a %s", async (_label, results) => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({ results: [...results] }));
    await expect(adapter(fetchFn).rerank({
      documents: [
        { handle: "c0", text: "first" },
        { handle: "c1", text: "second" },
        { handle: "c2", text: "third" }
      ],
      query: "query"
    })).rejects.toMatchObject({ code: "rerank_response_invalid" });
  });

  it("fails when no valid score remains", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      results: [
        { index: -1, relevance_score: 0.5 },
        { index: 0, relevance_score: Number.NaN }
      ]
    }));
    await expect(adapter(fetchFn).rerank({
      documents: [{ handle: "c0", text: "first" }],
      query: "query"
    })).rejects.toMatchObject({ code: "rerank_response_invalid" });
  });

  it.each([
    ["another namespace", "other/qwen3-reranker-8b"],
    ["another slug", "qwen/qwen3-reranker-4b"]
  ])("rejects a response from %s", async (_label, model) => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({ model }));
    await expect(adapter(fetchFn).rerank({
      documents: [{ handle: "c0", text: "first" }],
      query: "query"
    })).rejects.toMatchObject({ code: "rerank_response_model_mismatch" });
  });

  it("accepts OpenRouter's unnamespaced canonical slug", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      model: "Qwen3-Reranker-8B",
      results: [{ index: 0, relevance_score: 0.8 }]
    }));
    await expect(adapter(fetchFn).rerank({
      documents: [{ handle: "c0", text: "first" }],
      query: "query"
    })).resolves.toMatchObject({ model: "Qwen3-Reranker-8B" });
  });

  it("accepts OpenRouter's provider-native canonical model path", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      model: "accounts/together/models/qwen3-reranker-8b",
      provider: "Together",
      results: [{ index: 0, relevance_score: 0.8 }]
    }));
    await expect(adapter(fetchFn).rerank({
      documents: [{ handle: "c0", text: "first" }],
      query: "query"
    })).resolves.toMatchObject({
      model: "accounts/together/models/qwen3-reranker-8b",
      provider: "Together"
    });
  });

  it("accepts Cohere's exact allowlisted native Rerank 4 model identity", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      model: "rerank-v4.0-pro",
      provider: "Cohere",
      results: [{ index: 0, relevance_score: 0.8 }]
    }));
    const reranker = createOpenRouterRerankAdapter({
      connection,
      model: rerankerModel("cohere/rerank-4-pro", ["Cohere"]),
      network: { fetchFn },
      secret: "openrouter-secret"
    });

    await expect(reranker.rerank({
      documents: [{ handle: "c0", text: "first" }],
      query: "query"
    })).resolves.toMatchObject({
      model: "rerank-v4.0-pro",
      provider: "Cohere"
    });
  });

  it("rejects an allowlisted native model identity from a different provider", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      model: "rerank-v4.0-pro",
      provider: "Together",
      results: [{ index: 0, relevance_score: 0.8 }]
    }));
    const reranker = createOpenRouterRerankAdapter({
      connection,
      model: rerankerModel("cohere/rerank-4-pro", ["Together"]),
      network: { fetchFn },
      secret: "openrouter-secret"
    });

    await expect(reranker.rerank({
      documents: [{ handle: "c0", text: "first" }],
      query: "query"
    })).rejects.toMatchObject({ code: "rerank_response_model_mismatch" });
  });

  it("rejects a response from a provider outside the governed routing roster", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      provider: "Fireworks",
      results: [{ index: 0, relevance_score: 0.8 }]
    }));
    await expect(adapter(fetchFn).rerank({
      documents: [{ handle: "c0", text: "first" }],
      query: "query"
    })).rejects.toMatchObject({ code: "rerank_response_provider_mismatch" });
  });

  it("rejects a provider-native model path that contradicts the routed provider", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      model: "accounts/fireworks/models/qwen3-reranker-8b",
      provider: "Together"
    }));
    await expect(adapter(fetchFn).rerank({
      documents: [{ handle: "c0", text: "first" }],
      query: "query"
    })).rejects.toMatchObject({ code: "rerank_response_model_mismatch" });
  });

  it("does not retry or enable provider fallback after an upstream failure", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("unavailable", {
      headers: { "retry-after": "2" },
      status: 503
    }));
    await expect(adapter(fetchFn).rerank({
      documents: [{ handle: "c0", text: "first" }],
      query: "query"
    })).rejects.toMatchObject({
      code: "rerank_provider_http_error",
      httpStatus: 503,
      retryAfterMs: 2_000
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)))
      .toMatchObject({ provider: { allow_fallbacks: false } });
  });

  it("bounds document count and the full serialized request before network I/O", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const reranker = adapter(fetchFn);
    await expect(reranker.rerank({
      documents: Array.from({ length: MAX_RERANK_DOCUMENTS + 1 }, (_, index) => ({
        handle: `c${index}`,
        text: "evidence"
      })),
      query: "query"
    })).rejects.toMatchObject({ code: "rerank_documents_invalid" });
    await expect(reranker.rerank({
      documents: Array.from({ length: 64 }, (_, index) => ({
        handle: `c${index}`,
        text: "x".repeat(MAX_RERANK_DOCUMENT_CHARACTERS)
      })),
      query: "query"
    })).rejects.toMatchObject({ code: "rerank_request_too_large" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("bounds the response before parsing", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response());
    await expect(adapter(fetchFn, 32).rerank({
      documents: [{ handle: "c0", text: "first" }],
      query: "query"
    })).rejects.toMatchObject({ code: "rerank_response_too_large" });
  });

  it("classifies only its own elapsed deadline as a timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("missing_signal");
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
      const timedOut = expect(createOpenRouterRerankAdapter({
        connection: { ...connection, responseTimeoutMs: 5_000 },
        model: rerankerModel(),
        network: { fetchFn },
        secret: "openrouter-secret"
      }).rerank({
        documents: [{ handle: "c0", text: "first" }],
        query: "query"
      })).rejects.toMatchObject({ code: "rerank_request_timed_out" });

      await vi.advanceTimersByTimeAsync(5_000);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed usage without fabricating accounting", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      results: [{ index: 0, relevance_score: 0.5 }],
      usage: { total_tokens: -1 }
    }));
    await expect(adapter(fetchFn).rerank({
      documents: [{ handle: "c0", text: "first" }],
      query: "query"
    })).rejects.toMatchObject({ code: "rerank_response_invalid" });
  });
});
