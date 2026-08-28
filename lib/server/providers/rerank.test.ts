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

function rerankerModel() {
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
      providers: ["Together", "DeepInfra"]
    },
    upstreamModelId: "qwen/qwen3-reranker-8b"
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

function strictAdapter(fetchFn: typeof fetch) {
  return createOpenRouterRerankAdapter({
    connection,
    model: rerankerModel(),
    network: { fetchFn },
    secret: "openrouter-secret",
    validation: "strict"
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

  it("preserves valid partial scores and ignores malformed or duplicate entries", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      results: [
        { index: 2, relevance_score: 0.88 },
        { index: 1, relevance_score: 4 },
        { index: 2, relevance_score: 0.1 },
        { index: 0, relevance_score: 0.35 }
      ]
    }));
    const result = await adapter(fetchFn).rerank({
      documents: [
        { handle: "c0", text: "first" },
        { handle: "c1", text: "second" },
        { handle: "c2", text: "third" }
      ],
      query: "query"
    });

    expect(result.scores).toEqual([
      { handle: "c2", index: 2, relevanceScore: 0.88 },
      { handle: "c1", index: 1, relevanceScore: 4 },
      { handle: "c0", index: 0, relevanceScore: 0.35 }
    ]);
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

  it("accepts the routed provider's canonical model resource name", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      model: "accounts/fireworks/models/qwen3-reranker-8b",
      provider: "Fireworks",
      results: [{ index: 0, relevance_score: 0.8 }]
    }));
    await expect(adapter(fetchFn).rerank({
      documents: [{ handle: "c0", text: "first" }],
      query: "query"
    })).resolves.toMatchObject({
      model: "accounts/fireworks/models/qwen3-reranker-8b",
      provider: "Fireworks"
    });
  });

  it("rejects a canonical resource name that disagrees with its provider", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      model: "accounts/other/models/qwen3-reranker-8b",
      provider: "Fireworks",
      results: [{ index: 0, relevance_score: 0.8 }]
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

  it("rejects an empty results array", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({ results: [] }));
    await expect(adapter(fetchFn).rerank({
      documents: [{ handle: "c0", text: "first" }],
      query: "query"
    })).rejects.toMatchObject({ code: "rerank_response_invalid" });
  });

  it.each([400, 401, 402, 404, 413])(
    "surfaces upstream HTTP %d as a typed provider error",
    async (status) => {
      const fetchFn = vi.fn<typeof fetch>(async () =>
        new Response("failure", { status }));
      await expect(adapter(fetchFn).rerank({
        documents: [{ handle: "c0", text: "first" }],
        query: "query"
      })).rejects.toMatchObject({
        code: "rerank_provider_http_error",
        httpStatus: status,
        retryAfterMs: null
      });
      expect(fetchFn).toHaveBeenCalledOnce();
    }
  );

  it("surfaces 429 with its retry-after hint without retrying", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("limited", {
      headers: { "retry-after": "7" },
      status: 429
    }));
    await expect(adapter(fetchFn).rerank({
      documents: [{ handle: "c0", text: "first" }],
      query: "query"
    })).rejects.toMatchObject({
      code: "rerank_provider_http_error",
      httpStatus: 429,
      retryAfterMs: 7_000
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("falls back to the response header request ID when the body has none", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      model: "qwen/qwen3-reranker-8b",
      results: [{ index: 0, relevance_score: 0.5 }]
    }), {
      headers: {
        "content-type": "application/json",
        "x-request-id": "header-request-id"
      },
      status: 200
    }));
    await expect(adapter(fetchFn).rerank({
      documents: [{ handle: "c0", text: "first" }],
      query: "query"
    })).resolves.toMatchObject({
      provider: null,
      requestId: "header-request-id"
    });
  });

  it("keeps the query and documents out of every thrown failure", async () => {
    const privateQuery = "private-query-marker";
    const privateDocument = "private-document-marker";
    const failures: unknown[] = [];
    for (const fetchFn of [
      vi.fn<typeof fetch>(async () => new Response("denied", { status: 401 })),
      vi.fn<typeof fetch>(async () => new Response("not json", { status: 200 })),
      vi.fn<typeof fetch>(async () => { throw new Error("socket closed"); })
    ]) {
      failures.push(await adapter(fetchFn).rerank({
        documents: [{ handle: "c0", text: privateDocument }],
        instruction: privateQuery,
        query: privateQuery
      }).then(
        () => {
          throw new Error("expected_failure");
        },
        (error: unknown) => error
      ));
    }

    for (const failure of failures) {
      const serialized = JSON.stringify({
        message: (failure as Error).message,
        object: failure,
        stack: (failure as Error).stack ?? ""
      });
      expect(serialized).not.toContain(privateQuery);
      expect(serialized).not.toContain(privateDocument);
    }
  });

  it("uses only the rerank endpoint and never falls back to chat completions", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response("unavailable", { status: 500 }));
    await expect(adapter(fetchFn).rerank({
      documents: [{ handle: "c0", text: "first" }],
      query: "query"
    })).rejects.toMatchObject({
      code: "rerank_provider_http_error",
      httpStatus: 500
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      "https://openrouter.ai/api/v1/rerank"
    ]);
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

  it("keeps the lenient default tolerating dropped malformed entries", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      results: [
        { index: 0, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.1 },
        { index: 7, relevance_score: 0.5 }
      ]
    }));
    const result = await adapter(fetchFn).rerank({
      documents: [
        { handle: "c0", text: "first" },
        { handle: "c1", text: "second" }
      ],
      query: "query"
    });
    expect(result.scores).toEqual([{ handle: "c0", index: 0, relevanceScore: 0.9 }]);
  });

  it("treats duplicate, out-of-range, and non-finite entries as malformed in strict mode", async () => {
    const documents = [
      { handle: "c0", text: "first" },
      { handle: "c1", text: "second" }
    ];
    for (const results of [
      [{ index: 0, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }],
      [{ index: 0, relevance_score: 0.9 }, { index: 7, relevance_score: 0.5 }],
      [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: Number.NaN }],
      [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: Infinity }],
      [{ index: 0, relevance_score: 0.9 }, { relevance_score: 0.5 }],
      [
        { index: 0, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.5 },
        { index: 0, relevance_score: 0.4 }
      ]
    ]) {
      const fetchFn = vi.fn<typeof fetch>(async () => response({ results }));
      await expect(strictAdapter(fetchFn).rerank({ documents, query: "query" }))
        .rejects.toMatchObject({ code: "rerank_response_invalid" });
    }
  });

  it("accepts any finite provider relevance score without inventing a range", async () => {
    const documents = [
      { handle: "c0", text: "first" },
      { handle: "c1", text: "second" }
    ];
    const result = await strictAdapter(vi.fn<typeof fetch>(async () => response({
      results: [
        { index: 0, relevance_score: -2.5 },
        { index: 1, relevance_score: 4.25 }
      ]
    }))).rerank({ documents, query: "query" });
    expect(result.scores).toEqual([
      { handle: "c0", index: 0, relevanceScore: -2.5 },
      { handle: "c1", index: 1, relevanceScore: 4.25 }
    ]);
  });

  it("still accepts a full valid response and a genuine partial subset in strict mode", async () => {
    const documents = [
      { handle: "c0", text: "first" },
      { handle: "c1", text: "second" }
    ];
    const full = await strictAdapter(vi.fn<typeof fetch>(async () => response({
      results: [
        { index: 1, relevance_score: 0.91 },
        { index: 0, relevance_score: 0.42 }
      ]
    }))).rerank({ documents, query: "query" });
    expect(full.scores).toHaveLength(2);

    const partial = await strictAdapter(vi.fn<typeof fetch>(async () => response({
      results: [{ index: 1, relevance_score: 0.91 }]
    }))).rerank({ documents, query: "query" });
    expect(partial.scores).toEqual([{ handle: "c1", index: 1, relevanceScore: 0.91 }]);
  });
});
