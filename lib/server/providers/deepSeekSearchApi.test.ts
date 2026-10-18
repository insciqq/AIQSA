import { describe, expect, it, vi } from "vitest";
import type { ValidatedSearchQuery } from "../../domain/search";
import { SEARCH_NO_RESULTS_FINDINGS } from "../search/evidence";
import {
  createDeepSeekSearchAdapter,
  createDeepSeekSearchApiAdapter,
  createFetchDeepSeekSearchApiClient,
  createSlidingWindowRateLimiter,
  DEEPSEEK_SEARCH_API_REQUEST_USD,
  deepSeekSearchApiEndpoint,
  type SearchRequestRateLimiter
} from "./deepSeekSearchApi";
import { createProviderRuntimeBinding, type ProviderExecutionSnapshot } from "./runtimeFactory";
import {
  ProviderSearchExecutionError,
  type ProviderModelCapabilities,
  type ProviderSearchAdapter,
  type ProviderSearchRequest
} from "./types";

const KEY = "sk-synthetic-deepseek-key";

function request(query = "bounded query", maxResults = 8): ProviderSearchRequest {
  return {
    correlationId: "call-1:deepseek-api",
    query: query as ValidatedSearchQuery,
    searchPolicy: { maxResults, modelId: "deepseek-search-api", provider: "deepseek", strategyId: "deepseek-search-api" },
    strategyId: "deepseek-api"
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status: 200, ...init });
}

function result(index: number, extra: Record<string, unknown> = {}) {
  return {
    authority: 2,
    date: "2026-10-0" + index + "T08:00:00+08:00",
    rerank_score: 2.5,
    site_icon: null,
    site_name: `Site ${index}`,
    snippet: `Snippet ${index}`,
    summary: `Summary ${index} for the model.`,
    title: `Title ${index}`,
    url: `https://example.com/page-${index}`,
    ...extra
  };
}

const openLimiter: SearchRequestRateLimiter = { acquire: async () => undefined };

function adapter(fetchFn: typeof fetch, options: Readonly<{
  limiter?: SearchRequestRateLimiter;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}> = {}): ProviderSearchAdapter {
  return createDeepSeekSearchApiAdapter({
    client: createFetchDeepSeekSearchApiClient({ apiKey: KEY, fetchFn }),
    rateLimitKey: "credential-1",
    rateLimiter: options.limiter ?? openLimiter,
    retry: { random: () => 0.5, sleep: options.sleep ?? (async () => undefined) }
  });
}

describe("DeepSeek Search API adapter", () => {
  it("sends only the generated query to the documented endpoint with the connection key", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ results: [result(1)] }));
    await adapter(fetchFn).search(request());

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    // The user's question (`ori_question`) and conversation never leave the server.
    expect(JSON.parse(String(init?.body))).toEqual({ count: 8, need_content: false, query: "bounded query" });
    expect(deepSeekSearchApiEndpoint("https://api.deepseek.com/v1/")).toBe("https://api.deepseek.com/v1/tools/search");
    expect(deepSeekSearchApiEndpoint("https://proxy.example.test/deepseek")).toBe("https://proxy.example.test/deepseek/v1/tools/search");
  });

  it("feeds summaries to the model and keeps each linked result as a cited, billed source", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ results: [
      result(1),
      result(2, { summary: null, title: "  Title\n2  " }),
      result(3, { url: "javascript:alert(1)" }),
      result(4, { url: "https://example.com/page-1" }),
      result(5, { date: null, site_name: null, title: "", summary: "Line\u0007 five" })
    ] }));
    const searched = await adapter(fetchFn).search(request());

    expect(searched.findings).toBe([
      "[1] Title 1 — Site 1 · 2026-10-01T08:00:00+08:00\nSummary 1 for the model.",
      "[2] Title 2 — Site 2 · 2026-10-02T08:00:00+08:00\nSnippet 2",
      "[3] example.com\nLine five"
    ].join("\n\n"));
    expect(searched.sources).toEqual([
      { citation: 1, date: "2026-10-01T08:00:00+08:00", rank: 1, snippet: "Snippet 1", title: "Title 1", url: "https://example.com/page-1" },
      { citation: 2, date: "2026-10-02T08:00:00+08:00", rank: 2, snippet: "Snippet 2", title: "Title 2", url: "https://example.com/page-2" },
      { citation: 3, rank: 3, snippet: "Snippet 5", title: "example.com", url: "https://example.com/page-5" }
    ]);
    expect(searched.costUsd).toBe(DEEPSEEK_SEARCH_API_REQUEST_USD);
    expect(searched.usage).toMatchObject({ completeness: "complete", inputTokens: 0, outputTokens: 0, webSearchCount: 1 });
    expect(searched.noResults).toBeUndefined();
  });

  it("answers an empty result list as an ordinary, unbilled no-results outcome", async () => {
    const searched = await adapter(vi.fn<typeof fetch>(async () => json({ results: [] }))).search(request());

    expect(searched).toMatchObject({ costUsd: 0, findings: SEARCH_NO_RESULTS_FINDINGS, noResults: true, sources: [] });
    expect(searched.usage.webSearchCount).toBeUndefined();
  });

  it("bills results that carry no usable link but reports the missing sources", async () => {
    const searching = adapter(vi.fn<typeof fetch>(async () => json({ results: [result(1, { url: "ftp://example.com" })] })))
      .search(request());
    await expect(searching).rejects.toMatchObject({
      code: "search_sources_invalid", costUsd: DEEPSEEK_SEARCH_API_REQUEST_USD, usage: { webSearchCount: 1 }
    });
  });

  it.each([
    [400, "provider_http_invalid_request"],
    [401, "provider_auth_rejected"],
    [402, "provider_quota_exhausted"],
    [413, "provider_http_request_body_too_large"]
  ] as const)("maps HTTP %i to %s without a retry or a charge", async (status, code) => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ error: { code: "x", message: "PRIVATE_PROVIDER_TEXT" } }, { status }));
    const failure = await adapter(fetchFn).search(request()).catch((error: unknown) => error);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(ProviderSearchExecutionError);
    expect(failure).toMatchObject({ code, costUsd: 0, httpStatus: status });
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_PROVIDER_TEXT");
  });

  it("retries 408, 429 and 5xx within the attempt bound, honoring Retry-After", async () => {
    const sleeps: number[] = [];
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, { headers: { "retry-after": "2" }, status: 429 }))
      .mockResolvedValueOnce(json({}, { status: 503 }))
      .mockResolvedValueOnce(json({ results: [result(1)] }));
    const searched = await adapter(fetchFn, { sleep: async (delayMs) => { sleeps.push(delayMs); } }).search(request());

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2_000);
    expect(searched.sources).toHaveLength(1);

    const failing = vi.fn<typeof fetch>(async () => json({}, { status: 408 }));
    await expect(adapter(failing).search(request())).rejects.toMatchObject({ code: "provider_request_timed_out", costUsd: 0 });
    expect(failing).toHaveBeenCalledTimes(3);
    const unavailable = vi.fn<typeof fetch>(async () => json({}, { status: 502 }));
    await expect(adapter(unavailable).search(request())).rejects.toMatchObject({ code: "provider_server_error", httpStatus: 502 });
    expect(unavailable).toHaveBeenCalledTimes(3);
  });

  it("stops retrying when the wait would outlast the Search deadline", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({}, { headers: { "retry-after": "30" }, status: 429 }));
    await expect(adapter(fetchFn).search(request(), { timeoutMs: 5_000 })).rejects.toMatchObject({ code: "provider_rate_limited" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("refuses a query longer than the API accepts before any request", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(adapter(fetchFn).search(request("q".repeat(129)))).rejects.toThrow("search_query_too_long");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("keeps the billing of an unreadable answer unknown", async () => {
    await expect(adapter(vi.fn<typeof fetch>(async () => json({ data: [] }))).search(request()))
      .rejects.toMatchObject({ code: "provider_terminal_response_invalid", costUsd: null });
    await expect(adapter(vi.fn<typeof fetch>(async () => new Response("not json"))).search(request()))
      .rejects.toMatchObject({ code: "provider_response_invalid_json", costUsd: null });
  });

  it("passes every physical request, retries included, through the dispatch accounting", async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, { status: 500 }))
      .mockResolvedValueOnce(json({ results: [] }));
    const costs: Array<number | null> = [];
    let dispatched = 0;
    await adapter(fetchFn).search(request(), {
      async dispatch(attempt) {
        dispatched += 1;
        const response = await attempt.execute();
        costs.push(attempt.cost?.(response) ?? null);
        return response;
      }
    });
    expect(dispatched).toBe(2);
    expect(costs).toEqual([0]);
  });

  it("waits for the account's request slot before each request", async () => {
    const acquired: string[] = [];
    const limiter: SearchRequestRateLimiter = { acquire: async (key) => { acquired.push(key); } };
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, { status: 429 }))
      .mockResolvedValueOnce(json({ results: [result(1)] }));
    await adapter(fetchFn, { limiter }).search(request());
    expect(acquired).toEqual(["credential-1", "credential-1"]);
  });
});

describe("Search request rate limiter", () => {
  it("starts at most five requests per key in any one-second window", async () => {
    let now = 10_000;
    const sleeps: number[] = [];
    const limiter = createSlidingWindowRateLimiter({
      maxRequests: 5,
      now: () => now,
      sleep: async (delayMs) => { sleeps.push(delayMs); now += delayMs; },
      windowMs: 1_000
    });
    const signal = new AbortController().signal;
    for (let index = 0; index < 5; index += 1) {
      await limiter.acquire("account-a", signal);
      now += 100;
    }
    expect(sleeps).toEqual([]);
    await limiter.acquire("account-a", signal);
    // The sixth start waits until the first one leaves the window.
    expect(sleeps).toEqual([500]);
    expect(now).toBe(11_000);
    await limiter.acquire("account-b", signal);
    expect(sleeps).toEqual([500]);
  });

  it("ends a wait with the caller's signal", async () => {
    const limiter = createSlidingWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const controller = new AbortController();
    await limiter.acquire("account", controller.signal);
    const waiting = limiter.acquire("account", controller.signal);
    controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
  });
});

describe("DeepSeek binding Search adapter", () => {
  const hostedCapabilities: ProviderModelCapabilities = {
    nativePdfInput: false, nativeSearch: true, pdf: true, reasoning: true, streaming: true, vision: true
  };

  function snapshot(nativeSearch: boolean): ProviderExecutionSnapshot {
    return {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://api.deepseek.com",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      connectionDisplayName: "DeepSeek",
      connectionId: "connection-deepseek",
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      model: {
        adapterKind: "deepseek_responses_native",
        answerSelectable: true,
        capabilities: {
          nativePdfInput: false,
          nativeSearch,
          pdf: true,
          reasoning: true,
          streaming: true,
          vision: true
        },
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: "deepseek-flash"
      },
      modelDisplayName: "DeepSeek V4.1 Flash",
      providerFamily: "deepseek",
      providerModelId: "model-deepseek-flash",
      version: 1
    };
  }

  it("reaches the Search API with the binding's key even when the model has no hosted Search", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ results: [result(1)] }));
    const runtime = createProviderRuntimeBinding({ options: { allowFake: false, fetchFn }, secret: KEY, snapshot: snapshot(false) });

    const searched = await runtime.searchAdapter!.search(request());
    expect(searched.sources.map((source) => source.url)).toEqual(["https://example.com/page-1"]);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe("https://api.deepseek.com/v1/tools/search");
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    await expect(runtime.searchAdapter!.search({
      ...request(),
      searchPolicy: {
        maxOutputTokens: 1_024,
        modelCapabilities: hostedCapabilities,
        modelId: "deepseek-flash",
        provider: "deepseek",
        reasoningPolicy: "lowest_supported",
        strategyId: "deepseek-responses-web-search"
      }
    })).rejects.toThrow("search_adapter_not_available");
  });

  it("routes each policy to its own adapter", async () => {
    const responses = { buildRequestPreview: vi.fn(() => ({})), search: vi.fn(async () => { throw new Error("hosted"); }) };
    const searchApi = { buildRequestPreview: vi.fn(() => ({})), search: vi.fn(async () => { throw new Error("api"); }) };
    const routed = createDeepSeekSearchAdapter({ responses, searchApi });
    await expect(routed.search(request())).rejects.toThrow("api");
    await expect(routed.search({ ...request(), searchPolicy: {
      maxOutputTokens: 1_024, modelCapabilities: hostedCapabilities, modelId: "deepseek-v4-flash",
      provider: "deepseek", reasoningPolicy: "lowest_supported", strategyId: "deepseek-responses-web-search"
    } })).rejects.toThrow("hosted");
    expect(createDeepSeekSearchAdapter({ searchApi }).buildRequestPreview).toBeDefined();
  });
});
