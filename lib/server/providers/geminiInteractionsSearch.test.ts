import { describe, expect, it, vi } from "vitest";
import { catalogModelTokenPricing } from "../../domain/modelPrices";
import { estimateCostMicros } from "../../domain/usage";
import { validateSearchToolArguments } from "../search/query";
import type { GeminiInteractionsClient } from "./geminiInteractionsTransport";
import {
  buildGeminiInteractionsSearchRequest,
  createGeminiInteractionsSearchAdapter
} from "./geminiInteractionsSearch";
import {
  isProviderSearchExecutionError,
  type ProviderSearchPolicy,
  type ProviderSearchRequest
} from "./types";

const suggestionsHtml = [
  "<style>.container { display: flex; position: relative; }</style>",
  '<div class="container"><a class="chip" href="https://www.google.com/search?q=valencia" target="_blank">Search on Google</a>',
  '<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">',
  '<circle cx="10" cy="10" r="8" fill="#4285f4"></circle>',
  '<path d="M1 1 L2 2 Z" fill="currentColor"></path></svg></div>'
].join("");

type GeminiSearchPolicy = Extract<ProviderSearchPolicy, { provider: "gemini" }>;

function request(
  policyOverrides: Partial<GeminiSearchPolicy> = {}
): ProviderSearchRequest {
  const validated = validateSearchToolArguments({ query: "weather in Valencia" });
  if (!validated.ok) throw new Error(validated.code);
  return {
    correlationId: "gemini-search-call-1",
    query: validated.query,
    searchPolicy: {
      maxOutputTokens: 4_096,
      modelCapabilities: {
        nativePdfInput: false,
        nativeSearch: true,
        pdf: false,
        reasoning: true,
        reasoningEfforts: ["low", "medium", "high"],
        streaming: true,
        toolCalling: true,
        vision: true
      },
      modelId: "gemini-3.6-flash",
      provider: "gemini",
      reasoningPolicy: "lowest_supported",
      strategyId: "gemini-google-search",
      ...policyOverrides
    },
    strategyId: "gemini-google-search"
  };
}

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "interaction-search-1",
    model: "gemini-3.6-flash",
    status: "completed",
    steps: [
      { signature: "PRIVATE_THOUGHT_SIGNATURE", type: "thought" },
      {
        arguments: { queries: ["Valencia weather"] },
        id: "google-search-1",
        signature: "PRIVATE_CALL_SIGNATURE",
        type: "google_search_call"
      },
      {
        call_id: "google-search-1",
        result: [{ search_suggestions: suggestionsHtml }],
        signature: "PRIVATE_RESULT_SIGNATURE",
        type: "google_search_result"
      },
      {
        content: [{
          annotations: [{
            end_index: 25,
            start_index: 0,
            title: "Weather source",
            type: "url_citation",
            url: "https://example.test/valencia-weather"
          }],
          text: "Valencia is warm and sunny.",
          type: "text"
        }],
        type: "model_output"
      }
    ],
    usage: {
      grounding_tool_count: [{ count: 1, type: "google_search" }],
      total_cached_tokens: 2,
      total_input_tokens: 9,
      total_output_tokens: 6,
      total_thought_tokens: 3,
      total_tokens: 18
    },
    ...overrides
  };
}

function client(
  createInteraction: GeminiInteractionsClient["createInteraction"]
): GeminiInteractionsClient {
  return {
    createInteraction,
    async streamInteraction() {
      throw new Error("stream_must_not_be_used");
    }
  };
}

describe("Gemini Interactions query-only Search adapter", () => {
  it("builds a dedicated non-streaming store-false Google Search request", () => {
    expect(buildGeminiInteractionsSearchRequest(request())).toEqual({
      generation_config: {
        max_output_tokens: 4_096,
        thinking_level: "low",
        thinking_summaries: "none",
        tool_choice: "auto"
      },
      input: [{
        content: [{ text: "weather in Valencia", type: "text" }],
        type: "user_input"
      }],
      model: "gemini-3.6-flash",
      store: false,
      stream: false,
      system_instruction: "Use Google Search for the query and return concise source-backed findings.",
      tools: [{ type: "google_search" }]
    });
  });

  it.each([
    ["gemini-3.8-flash", "low"],
    ["gemini-3.6-flash", "minimal"]
  ])("never sends a level the %s catalog controls exclude (lowest is %s)", (modelId, expected) => {
    const capabilities = {
      ...(request().searchPolicy as GeminiSearchPolicy).modelCapabilities,
      reasoningEfforts: ["minimal", "low", "medium", "high"]
    };
    expect(buildGeminiInteractionsSearchRequest(request({ modelCapabilities: capabilities, modelId }))
      .generation_config.thinking_level).toBe(expected);
  });

  it.each([
    ["gemini-3.8-flash", "low"],
    ["gemini-4-argon", "low"],
    ["gemini-4-carbon", "low"],
    ["gemini-4-hydrogen", "low"],
    ["gemini-3.5-flash", "minimal"]
  ])("sends the lowest catalog level when the saved %s capabilities list none (%s)", (modelId, expected) => {
    const { reasoningEfforts: _saved, ...capabilities } = (request().searchPolicy as GeminiSearchPolicy).modelCapabilities;
    expect(buildGeminiInteractionsSearchRequest(request({ modelCapabilities: capabilities, modelId }))
      .generation_config.thinking_level).toBe(expected);
  });

  it("returns explicit findings, sources, operations, usage, and a raw-free preview", async () => {
    const controller = new AbortController();
    const createInteraction = vi.fn<GeminiInteractionsClient["createInteraction"]>(
      async () => response()
    );
    const adapter = createGeminiInteractionsSearchAdapter({
      client: client(createInteraction)
    });

    const result = await adapter.search(request(), {
      signal: controller.signal,
      timeoutMs: 45_000
    });

    expect(createInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ store: false, stream: false, tools: [{ type: "google_search" }] }),
      { signal: controller.signal, timeoutMs: 45_000 }
    );
    expect(result).toMatchObject({
      findings: "Valencia is warm and sunny.",
      providerResponseId: "interaction-search-1",
      sources: [{
        citation: 1,
        rank: 1,
        title: "Weather source",
        url: "https://example.test/valencia-weather"
      }],
      usage: {
        cachedInputTokens: 2,
        inputTokens: 9,
        outputTokens: 9,
        reasoningTokens: 3,
        totalTokens: 18,
        webSearchCount: 1
      }
    });
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "search",
          payload: expect.objectContaining({
            action: { queries: ["Valencia weather"], type: "search" },
            provider: "gemini",
            type: "web_search_call"
          })
        })
      }),
      expect.objectContaining({ data: expect.objectContaining({ artifactType: "citation" }) })
    ]));
    const durable = JSON.stringify(result);
    expect(durable).not.toMatch(
      /PRIVATE_THOUGHT_SIGNATURE|PRIVATE_CALL_SIGNATURE|PRIVATE_RESULT_SIGNATURE|search_suggestions|Search on Google/u
    );
    expect(result.requestPreview).not.toHaveProperty("body.input");
  });

  it("bills the queries Gemini reports in grounding_tool_count, in success, failure and dispatch usage", async () => {
    const searchCall = (id: string, queries?: unknown[]) => ({
      ...(queries ? { arguments: { queries } } : {}), id, signature: "PRIVATE_CALL_SIGNATURE", type: "google_search_call" });
    const [thought, , searchResult, output] = response().steps as Record<string, unknown>[];
    // The steps list two distinct queries; the provider's count is what it billed.
    const steps = [thought, searchCall("google-search-1", ["Valencia weather", "Valencia forecast"]), searchResult, output];
    const usage = { ...(response().usage as Record<string, unknown>),
      grounding_tool_count: [{ count: 4, type: "google_search" }, { count: 7, type: "url_context" }] };
    const dispatched: unknown[] = [];
    const result = await createGeminiInteractionsSearchAdapter({ client: client(async () => response({ steps, usage })) })
      .search(request(), { dispatch: async (attempt) => {
        const value = await attempt.execute();
        dispatched.push(attempt.usage(value));
        return value;
      } });
    expect(result.usage).toMatchObject({ completeness: "complete", inputTokens: 9, webSearchCount: 4 });
    expect(result.costUsd).toBeUndefined();
    expect(dispatched).toEqual([expect.objectContaining({ completeness: "complete", inputTokens: 9, webSearchCount: 4 })]);

    const failed = await createGeminiInteractionsSearchAdapter({
      client: client(async () => response({ steps: [thought, searchCall("google-search-1", ["Valencia weather"]), searchResult],
        usage: { ...usage, grounding_tool_count: [{ count: 1, type: "google_search" }] } }))
    }).search(request()).then(() => null, (value: unknown) => value);
    expect(failed).toMatchObject({ usage: { inputTokens: 9, webSearchCount: 1 } });
  });

  it.each([
    ["no count", undefined],
    ["no Google Search entry", [{ count: 2, type: "url_context" }]],
    ["an unreadable count", [{ count: 2.5, type: "google_search" }]],
    ["a negative count", [{ count: -1, type: "google_search" }]]
  ])("leaves the charge unknown with %s, never estimated from the listed queries", async (_label, groundingToolCount) => {
    const { grounding_tool_count: _reported, ...tokens } = response().usage as Record<string, unknown>;
    const usage = { ...tokens, ...(groundingToolCount ? { grounding_tool_count: groundingToolCount } : {}) };
    const dispatched: unknown[] = [];
    const result = await createGeminiInteractionsSearchAdapter({ client: client(async () => response({ usage })) })
      .search(request(), { dispatch: async (attempt) => {
        const value = await attempt.execute();
        dispatched.push(attempt.usage(value));
        return value;
      } });
    expect(result.usage).toMatchObject({ completeness: "partial", inputTokens: 9, outputTokens: 9, totalTokens: 18 });
    expect(result.usage).not.toHaveProperty("webSearchCount");
    expect(dispatched).toEqual([expect.objectContaining({ completeness: "partial" })]);
    // A partial usage row has no estimated cost (`estimateCostMicros`).
    expect(estimateCostMicros(result.usage, catalogModelTokenPricing("gemini:gemini-3.6-flash"))).toBeNull();
  });

  it("prices reported queries at the published Google Search fee on top of tokens", async () => {
    const usage = { total_input_tokens: 1_000, total_output_tokens: 1_000, total_thought_tokens: 0, total_tokens: 2_000,
      grounding_tool_count: [{ count: 2, type: "google_search" }] };
    const result = await createGeminiInteractionsSearchAdapter({ client: client(async () => response({ usage })) })
      .search(request());
    // gemini-3.6-flash: $1.5 / $7.5 per million tokens, $14 per 1,000 queries.
    expect(estimateCostMicros(result.usage, catalogModelTokenPricing("gemini:gemini-3.6-flash"))).toBe(1_500 + 7_500 + 28_000);
  });

  it("cites each page at its resolved address with the answer segments it supports as the excerpt", async () => {
    // Trimmed from a recorded Interactions response (2026-11-26): Russian text, byte offsets, domain titles.
    const text = [
      "Официальный курс евро, установленный Банком России:",
      "",
      "* **На 25 ноября 2026 года:** **89,8818 руб.** (действовал в течение дня 25 ноября).",
      "* **С 26 ноября 2026 года** (установлен регулятором 25 ноября): **90,2397 руб.**"
    ].join("\n");
    const span = (part: string) => {
      const start = Buffer.byteLength(text.slice(0, text.indexOf(part)), "utf8");
      return { end_index: start + Buffer.byteLength(part, "utf8"), start_index: start };
    };
    const first = "(действовал в течение дня 25 ноября)";
    const second = "**С 26 ноября 2026 года** (установлен регулятором 25 ноября): **90,2397 руб.**";
    const third = "* **На 25 ноября 2026 года:** **89,8818 руб.**";
    const redirect = (id: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;
    const annotations = [
      { ...span(first), title: "vedomosti.ru", type: "url_citation", url: redirect("vedomosti") },
      { ...span(second), title: "finmarket.ru", type: "url_citation", url: redirect("finmarket") },
      { ...span(second), title: "rosbalt.ru", type: "url_citation", url: redirect("rosbalt") },
      // A second redirect to the same finmarket page, supporting another segment.
      { ...span(third), title: "finmarket.ru", type: "url_citation", url: redirect("finmarket-2") },
      // Offsets past the block give no segment.
      { end_index: 9_999, start_index: 9_000, title: "rosbalt.ru", type: "url_citation", url: redirect("rosbalt") }
    ];
    const steps = (response().steps as Record<string, unknown>[]).map((step) => step.type === "model_output"
      ? { ...step, content: [{ annotations, text, type: "text" }] }
      : step);
    const usage = { ...(response().usage as Record<string, unknown>), grounding_tool_count: [{ count: 2, type: "google_search" }] };
    const resolveRedirects = vi.fn(async (urls: readonly string[]) => new Map([
      [redirect("vedomosti"), "https://www.vedomosti.ru/economics/news/2026/11/25/euro"],
      [redirect("finmarket"), "https://www.finmarket.ru/news/6757758"],
      [redirect("finmarket-2"), "https://www.finmarket.ru/news/6757758"]
      // rosbalt does not resolve and keeps its redirect link.
    ].filter(([from]) => urls.includes(from!)) as [string, string][]));
    const controller = new AbortController();

    const result = await createGeminiInteractionsSearchAdapter({
      client: client(async () => response({ steps, usage })),
      resolveRedirects
    }).search(request(), { signal: controller.signal });

    expect(resolveRedirects).toHaveBeenCalledWith(
      [redirect("vedomosti"), redirect("finmarket"), redirect("rosbalt"), redirect("finmarket-2")], controller.signal);
    expect(result.findings).toBe(text);
    expect(result.sources).toEqual([
      { citation: 1, rank: 1, snippet: first, title: "vedomosti.ru",
        url: "https://www.vedomosti.ru/economics/news/2026/11/25/euro" },
      { citation: 2, rank: 2, snippet: `${second} … **На 25 ноября 2026 года:** **89,8818 руб.**`, title: "finmarket.ru",
        url: "https://www.finmarket.ru/news/6757758" },
      { citation: 3, rank: 3, snippet: second, title: "rosbalt.ru", url: redirect("rosbalt") }
    ]);
    expect(result.usage).toMatchObject({ webSearchCount: 2 });
    const citations = result.artifacts.filter((event) => event.type === "artifact" && event.data.artifactType === "citation");
    expect(citations.map((event) => event.type === "artifact" ? event.data.payload : null)).toEqual([
      { index: 1, source: "gemini", title: "vedomosti.ru", url: "https://www.vedomosti.ru/economics/news/2026/11/25/euro" },
      { index: 2, source: "gemini", title: "finmarket.ru", url: "https://www.finmarket.ru/news/6757758" },
      { index: 3, source: "gemini", title: "rosbalt.ru", url: redirect("rosbalt") }
    ]);
    expect(result.finalProviderResponsePreview).toMatchObject({ grounding: { citationCount: 3 } });
  });

  it("keeps every cited redirect when resolution fails", async () => {
    const redirectUrl = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZ";
    const steps = (response().steps as Record<string, unknown>[]).map((step) => step.type === "model_output"
      ? { ...step, content: [{ annotations: [{ end_index: 8, start_index: 0, title: "example.com", type: "url_citation",
        url: redirectUrl }], text: "Valencia is warm and sunny.", type: "text" }] }
      : step);
    const result = await createGeminiInteractionsSearchAdapter({
      client: client(async () => response({ steps })),
      resolveRedirects: async () => { throw new Error("resolver_broken"); }
    }).search(request());
    expect(result.sources).toEqual([{ citation: 1, rank: 1, snippet: "Valencia", title: "example.com", url: redirectUrl }]);
  });

  it("fails closed without terminal grounded citation proof while retaining safe usage", async () => {
    const adapter = createGeminiInteractionsSearchAdapter({
      client: client(async () => response({
        status: "incomplete",
        steps: [],
        usage: { total_input_tokens: 4, total_output_tokens: 2, total_tokens: 6 }
      }))
    });

    const error = await adapter.search(request()).then(() => null, (value: unknown) => value);
    expect(isProviderSearchExecutionError(error)).toBe(true);
    if (!isProviderSearchExecutionError(error)) throw new Error("expected typed error");
    expect(error).toMatchObject({
      code: "gemini_interaction_incomplete",
      providerStatus: "incomplete",
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 }
    });
    expect(error).not.toHaveProperty("response");
  });

  it("takes a cited page without text offsets as a source, and needs no Search suggestions", async () => {
    const steps = (response().steps as Record<string, unknown>[]).map((step) => {
      if (step.type === "google_search_result") return { ...step, result: [{}] };
      if (step.type !== "model_output") return step;
      return { ...step, content: [{
        annotations: [
          { title: "Offset-free source", type: "url_citation", url: "https://example.test/offset-free" },
          { end_index: 25, start_index: 0, title: "Weather source", type: "url_citation",
            url: "https://example.test/valencia-weather" }
        ],
        text: "Valencia is warm and sunny.",
        type: "text"
      }] };
    });
    const adapter = createGeminiInteractionsSearchAdapter({ client: client(async () => response({ steps })) });
    const result = await adapter.search(request());
    expect(result.findings).toBe("Valencia is warm and sunny.");
    expect(result.sources.map((source) => source.url)).toEqual([
      "https://example.test/offset-free", "https://example.test/valencia-weather"
    ]);
  });
});
