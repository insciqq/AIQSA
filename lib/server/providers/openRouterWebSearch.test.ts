import { describe, expect, it, vi } from "vitest";
import type { OpenRouterWebSearchEngine } from "../../contracts/adminSearch";
import type { ValidatedSearchQuery } from "../../domain/search";
import { SEARCH_NO_RESULTS_FINDINGS } from "../search/evidence";
import { createSearchPlanToolRouter } from "../search/toolExecutor";
import { SEARCH_RESULT_LIST_FINDINGS } from "../search/toolResult";
import {
  buildOpenRouterWebSearchRequest,
  createFetchOpenRouterResponsesSearchClient,
  createOpenRouterWebSearchAdapter,
  OPENROUTER_WEB_SEARCH_STRATEGY_ID,
  openRouterWebSearchReasoningEffort,
  type OpenRouterResponsesSearchClient
} from "./openRouterWebSearch";
import type { ProviderRuntimeBinding } from "./runtimeFactory";
import { providerStreamDrop } from "./streamDrop";
import {
  ProviderSearchExecutionError,
  type NormalizedSearchPlanOption,
  type ProviderModelCapabilities,
  type ProviderSearchRequest
} from "./types";

const capabilities: ProviderModelCapabilities = {
  nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, reasoningEfforts: ["none", "low", "medium"],
  streaming: true, toolCalling: true, vision: false
};

const QUERY = "курс доллара ЦБ РФ 25 ноября 2026";

function request(overrides: Partial<{ engine: OpenRouterWebSearchEngine; mode: string | null; modelId: string;
  capabilities: ProviderModelCapabilities; defaultParams: Record<string, unknown> }> = {}): ProviderSearchRequest {
  return {
    correlationId: "run-1",
    query: QUERY as ValidatedSearchQuery,
    searchPolicy: {
      defaultParams: overrides.defaultParams ?? { provider: { dataCollection: "deny", only: ["deepseek"] } },
      engine: overrides.engine ?? "perplexity",
      mode: overrides.mode === undefined ? null : overrides.mode,
      modelCapabilities: overrides.capabilities ?? capabilities,
      modelId: overrides.modelId ?? "deepseek/deepseek-v4.1-flash",
      provider: "openrouter",
      strategyId: OPENROUTER_WEB_SEARCH_STRATEGY_ID
    },
    strategyId: "openrouter-web-search-source"
  };
}

type Annotation = Readonly<{ content?: string; title?: string; uncited?: boolean; url: string }>;

/** A trimmed Responses answer in the shape OpenRouter returned in the 2026-11-25 probes: reasoning items, one
 * `openrouter:web_search` item per search, then the message whose `url_citation` annotations carry the results. */
function response(input: Readonly<{
  annotations?: readonly Annotation[];
  cost?: number;
  queries?: readonly string[];
  status?: string;
  text?: string;
  webSearchRequests?: number;
}> = {}): Record<string, unknown> {
  const queries = input.queries ?? [QUERY];
  return {
    error: null,
    id: "gen-1",
    model: "deepseek/deepseek-v4.1-flash",
    object: "response",
    output: [
      { encrypted_content: "opaque", id: "rs_1", status: "completed", summary: [], type: "reasoning" },
      ...queries.map((query, index) => ({
        action: { query, sources: (input.annotations ?? []).map((annotation) => ({ type: "url", url: annotation.url })), type: "search" },
        id: `st_tmp_${index}`,
        status: "completed",
        type: "openrouter:web_search"
      })),
      {
        content: [{
          annotations: (input.annotations ?? []).map((annotation) => ({
            end_index: 0, start_index: 0, type: "url_citation", ...annotation
          })),
          logprobs: [],
          text: input.text ?? "OK",
          type: "output_text"
        }],
        id: "msg_tmp_1",
        role: "assistant",
        status: "completed",
        type: "message"
      }
    ],
    status: input.status ?? "completed",
    usage: {
      ...(input.cost === undefined ? {} : { cost: input.cost }),
      input_tokens: 7_000,
      input_tokens_details: { cached_tokens: 1_000 },
      output_tokens: 12,
      output_tokens_details: { reasoning_tokens: 0 },
      server_tool_use_details: { web_search_requests: input.webSearchRequests ?? queries.length },
      total_tokens: 7_012
    }
  };
}

const RESULTS: readonly Annotation[] = [
  { content: "ЦБ $ 82.1664\n\n€ 89.8818\n* Вклады", title: "Курс доллара ЦБ РФ на 25 ноября 2026", uncited: true,
    url: "https://ru.myfin.by/currency/cb-rf/usd/25-11-2026" },
  { content: "ЦБ РФ установил курс доллара США с 25 ноября в размере 82,1664 руб.", title: "ЦБ РФ установил курс",
    url: "https://www.finmarket.ru/currency/news/6756840" },
  { content: "A duplicate of the first link", title: "Duplicate", uncited: true, url: "https://ru.myfin.by/currency/cb-rf/usd/25-11-2026" }
];

function fakeClient(...responses: readonly (Record<string, unknown> | Error)[]) {
  const createResponse = vi.fn<OpenRouterResponsesSearchClient["createResponse"]>();
  for (const value of responses) {
    if (value instanceof Error) createResponse.mockRejectedValueOnce(value);
    else createResponse.mockResolvedValueOnce(value);
  }
  return { client: { createResponse }, createResponse };
}

describe("OpenRouter web search request", () => {
  it("asks the technical model for one verbatim search with the source's engine, mode and the model's routing", () => {
    const body = buildOpenRouterWebSearchRequest(request({ engine: "parallel", mode: "fast" }));
    expect(body).toEqual({
      input: QUERY,
      instructions: expect.stringContaining("exactly once"),
      max_output_tokens: 128,
      max_tool_calls: 1,
      model: "deepseek/deepseek-v4.1-flash",
      provider: expect.objectContaining({ data_collection: "deny", only: ["deepseek"] }),
      reasoning: { effort: "none" },
      tools: [{ parameters: { engine: "parallel", max_results: 10, mode: "fast" }, type: "openrouter:web_search" }]
    });
    // OpenRouter's Responses API is stateless.
    expect(body).not.toHaveProperty("store");
    expect(body).not.toHaveProperty("previous_response_id");
    expect(buildOpenRouterWebSearchRequest(request()).tools).toEqual([
      { parameters: { engine: "perplexity", max_results: 10 }, type: "openrouter:web_search" }
    ]);
  });

  it("sends the template's effort for its models, else the lowest supported, else none", () => {
    expect(openRouterWebSearchReasoningEffort("openai/gpt-6-luna", capabilities)).toBe("minimal");
    expect(openRouterWebSearchReasoningEffort("deepseek/deepseek-v4.1-flash-1017", capabilities)).toBe("none");
    expect(openRouterWebSearchReasoningEffort("vendor/model", { ...capabilities, reasoningEfforts: ["low", "high"] })).toBe("low");
    expect(openRouterWebSearchReasoningEffort("vendor/model", { ...capabilities, reasoning: false })).toBeUndefined();
    expect(buildOpenRouterWebSearchRequest(request({ capabilities: { ...capabilities, reasoning: false }, modelId: "vendor/model" })))
      .not.toHaveProperty("reasoning");
  });

  it("refuses another policy and keeps the query out of its preview", () => {
    const adapter = createOpenRouterWebSearchAdapter({ client: fakeClient().client });
    const preview = adapter.buildRequestPreview(request({ engine: "exa", mode: "auto" }));
    expect(JSON.stringify(preview)).not.toContain(QUERY);
    expect(preview).toMatchObject({ body: { engine: "exa", max_results: 10, mode: "auto" }, queryCharacters: QUERY.length });
    expect(() => buildOpenRouterWebSearchRequest({ ...request(), searchPolicy: {
      modelId: "deepseek-search-api", provider: "deepseek", strategyId: "deepseek-search-api"
    } })).toThrow("openrouter_search_policy_invalid");
  });
});

describe("OpenRouter web search results", () => {
  it("lists every annotated link once, in provider order, with its excerpt, and discards the model's prose", async () => {
    const { client, createResponse } = fakeClient(response({ annotations: RESULTS, cost: 0.0068, text: "The rate is 82,1664 ₽ [cbr](https://cbr.example)." }));
    const result = await createOpenRouterWebSearchAdapter({ client }).search(request(), { timeoutMs: 30_000 });
    expect(createResponse).toHaveBeenCalledOnce();
    expect(result.findings).toBe(SEARCH_RESULT_LIST_FINDINGS);
    expect(result.sources).toEqual([
      { citation: 1, rank: 1, snippet: "ЦБ $ 82.1664 € 89.8818 * Вклады", title: "Курс доллара ЦБ РФ на 25 ноября 2026",
        url: "https://ru.myfin.by/currency/cb-rf/usd/25-11-2026" },
      { citation: 2, rank: 2, snippet: "ЦБ РФ установил курс доллара США с 25 ноября в размере 82,1664 руб.", title: "ЦБ РФ установил курс",
        url: "https://www.finmarket.ru/currency/news/6756840" }
    ]);
    expect(JSON.stringify(result)).not.toContain("cbr.example");
    expect(result).toMatchObject({
      costUsd: 0.0068,
      searchQueries: [QUERY],
      sourceAttribution: "available",
      usage: { cachedInputTokens: 1_000, completeness: "complete", inputTokens: 7_000, outputTokens: 12, webSearchCount: 1 }
    });
    expect(result.noResults).toBeUndefined();
  });

  it("bounds each excerpt and keeps an unreported cost unknown", async () => {
    const { client } = fakeClient(response({ annotations: [{ content: `${"слово ".repeat(1_000)}`, url: "https://example.com/a" }] }));
    const result = await createOpenRouterWebSearchAdapter({ client }).search(request());
    expect(result.sources[0]!.snippet!.length).toBeLessThanOrEqual(2_000);
    expect(result.sources[0]!.title).toBe("example.com");
    expect(result.costUsd).toBeNull();
  });

  it("sends the request once more when the model did not search, and sums both requests", async () => {
    const dispatched: unknown[] = [];
    const { client, createResponse } = fakeClient(
      response({ cost: 0.0004, queries: [], text: "I cannot browse." }),
      response({ annotations: RESULTS, cost: 0.006 })
    );
    const result = await createOpenRouterWebSearchAdapter({ client }).search(request(), {
      dispatch: async (input) => {
        const value = await input.execute();
        dispatched.push(input.cost?.(value));
        return value;
      }
    });
    expect(createResponse).toHaveBeenCalledTimes(2);
    expect(dispatched).toEqual([0.0004, 0.006]);
    expect(result.sources).toHaveLength(2);
    expect(result.costUsd).toBeCloseTo(0.0064, 10);
    expect(result.usage).toMatchObject({ inputTokens: 14_000, webSearchCount: 1 });
  });

  it("answers a second empty search as an ordinary empty result", async () => {
    const { client, createResponse } = fakeClient(response({ cost: 0.005 }), response({ cost: 0.005 }));
    const result = await createOpenRouterWebSearchAdapter({ client }).search(request());
    expect(createResponse).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ costUsd: 0.01, findings: SEARCH_NO_RESULTS_FINDINGS, noResults: true, searchQueries: [QUERY], sources: [] });
  });

  it("does not repeat an empty search the deadline leaves no time for", async () => {
    const { client, createResponse } = fakeClient(response({ queries: [] }));
    const result = await createOpenRouterWebSearchAdapter({ client }).search(request(), { timeoutMs: 1_000 });
    expect(createResponse).toHaveBeenCalledOnce();
    expect(result.noResults).toBe(true);
  });

  it("keeps the results of a response cut at its output limit after the search", async () => {
    const { client } = fakeClient(response({ annotations: RESULTS, status: "incomplete" }));
    await expect(createOpenRouterWebSearchAdapter({ client }).search(request())).resolves.toMatchObject({ sources: [{}, {}] });
  });

  it("marks a failed response as a dropped request and refuses an unfinished one with its accounting", async () => {
    const failed = fakeClient({ ...response(), error: { code: "server_error", message: "upstream" }, status: "failed" });
    const error = await createOpenRouterWebSearchAdapter({ client: failed.client }).search(request()).catch((value: unknown) => value);
    expect(providerStreamDrop(error)).toBe("response_failed");
    const pending = fakeClient(response({ cost: 0.001, status: "in_progress" }));
    const refused = await createOpenRouterWebSearchAdapter({ client: pending.client }).search(request()).catch((value: unknown) => value);
    expect(refused).toBeInstanceOf(ProviderSearchExecutionError);
    expect(refused).toMatchObject({ code: "provider_terminal_response_invalid", costUsd: 0.001 });
  });
});

describe("OpenRouter Responses search client", () => {
  it("posts to the connection's Responses endpoint and throws the provider HTTP status", async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(response()), { headers: { "content-type": "application/json" }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 401, message: "No auth" } }), { status: 401 }));
    const client = createFetchOpenRouterResponsesSearchClient({ apiKey: "test-key", baseUrl: "https://openrouter.example/api/v1/", fetchFn });
    await expect(client.createResponse({ model: "m" })).resolves.toMatchObject({ status: "completed" });
    expect(fetchFn.mock.calls[0]![0]).toBe("https://openrouter.example/api/v1/responses");
    expect(fetchFn.mock.calls[0]![1]).toMatchObject({ method: "POST" });
    await expect(client.createResponse({ model: "m" })).rejects.toMatchObject({ httpStatus: 401 });
  });
});

describe("OpenRouter web search through the Search tool", () => {
  function router(client: OpenRouterResponsesSearchClient) {
    const option: NormalizedSearchPlanOption = {
      adapterKind: "provider_model_client",
      config: { maxOutputTokens: 128, modelCapabilities: capabilities, modelDefaultParams: { provider: { dataCollection: "deny" } },
        openRouterWebSearch: { engine: "parallel", mode: "fast" }, queryMaxCharacters: 1_000, reasoningPolicy: "provider_default",
        timeoutMs: 30_000 },
      credentialMode: "provider_model",
      displayName: "OpenRouter Web Search",
      executionModes: ["all_selected"],
      modelId: "deepseek/deepseek-v4.1-flash",
      optionId: "openrouter-web-search",
      protocol: "openrouter_web_search",
      provider: "openrouter",
      providerModelId: "technical-model",
      revisionId: "revision",
      searchStrategyRowId: "route"
    };
    const runtime: ProviderRuntimeBinding = {
      adapter: { buildRequestPreview: () => ({}), async *stream() { throw new Error("unused"); } },
      responseTimeoutMs: 60_000,
      searchAdapter: createOpenRouterWebSearchAdapter({ client })
    };
    const built = createSearchPlanToolRouter({ plan: { mode: "all_selected", options: [option] }, runtimes: { [option.optionId]: runtime },
      retry: { random: () => 0, sleep: async () => undefined } });
    if (!built) throw new Error("router_missing");
    return built;
  }
  const call = (name: string) => ({ arguments: { query: QUERY }, id: "call-1", name });

  it("sends the source's engine and gives the model each result as an entry", async () => {
    const { client, createResponse } = fakeClient(response({ annotations: RESULTS, cost: 0.003 }));
    const search = router(client);
    const result = await search.execute(call(search.tools[0]!.name), null, { retainOriginal: true });
    expect(createResponse.mock.calls[0]![0]).toMatchObject({ tools: [{ parameters: { engine: "parallel", mode: "fast" } }] });
    expect(result.status).toBe("complete");
    expect(JSON.stringify(result.content)).toContain("https://www.finmarket.ru/currency/news/6756840");
    expect(JSON.stringify(result.content)).toContain("82,1664 руб.");
  });

  it("delivers a second empty search as no results, not as a failure", async () => {
    const { client } = fakeClient(response({ queries: [] }), response());
    const search = router(client);
    const result = await search.execute(call(search.tools[0]!.name), null, { retainOriginal: true });
    expect(result.status).toBe("complete");
    expect(JSON.stringify(result.content)).toContain(SEARCH_NO_RESULTS_FINDINGS);
  });

  it("names a refused key and retries a server error", async () => {
    const refused = router({ createResponse: vi.fn().mockRejectedValue(Object.assign(new Error("OpenRouter returned HTTP 401"), { httpStatus: 401 })) });
    const failed = await refused.execute(call(refused.tools[0]!.name), null, { retainOriginal: true });
    expect(failed.status).toBe("error");
    expect(JSON.stringify(failed.rawPreview)).toContain("provider_auth_rejected");

    const flaky = fakeClient(Object.assign(new Error("OpenRouter returned HTTP 503"), { httpStatus: 503 }), response({ annotations: RESULTS }));
    const retried = router(flaky.client);
    const recovered = await retried.execute(call(retried.tools[0]!.name), null, { retainOriginal: true });
    expect(flaky.createResponse).toHaveBeenCalledTimes(2);
    expect(recovered.status).toBe("complete");
  });
});
