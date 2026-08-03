import { describe, expect, it, vi } from "vitest";
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
        rank: 1,
        title: "Weather source",
        url: "https://example.test/valencia-weather"
      }],
      usage: {
        cachedInputTokens: 2,
        inputTokens: 9,
        outputTokens: 9,
        reasoningTokens: 3,
        totalTokens: 18
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
});
