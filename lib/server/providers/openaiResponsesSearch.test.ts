import { describe, expect, it, vi } from "vitest";
import { validateSearchToolArguments } from "../search/query";
import {
  buildOpenAIResponsesSearchRequest,
  createOpenAIResponsesSearchAdapter,
  lowestSupportedOpenAIResponsesSearchEffort
} from "./openaiResponsesSearch";
import type { OpenAIResponsesClient } from "./openaiResponsesTransport";
import {
  isProviderSearchExecutionError,
  type ProviderModelCapabilities,
  type ProviderSearchPolicy,
  type ProviderSearchRequest
} from "./types";

type OpenAISearchPolicy = Extract<
  ProviderSearchPolicy,
  { provider: "openai" | "openai_compatible" }
>;

function capabilities(
  overrides: Partial<ProviderModelCapabilities> = {}
): ProviderModelCapabilities {
  return {
    nativePdfInput: false,
    nativeSearch: true,
    pdf: false,
    reasoning: true,
    reasoningEfforts: ["none", "low", "medium", "high"],
    streaming: true,
    toolCalling: false,
    vision: false,
    ...overrides
  };
}

function searchRequest(
  overrides: Partial<ProviderSearchRequest> = {}
): ProviderSearchRequest {
  const validated = validateSearchToolArguments({ query: "latest news in Moscow" });
  if (!validated.ok) throw new Error(validated.code);
  return {
    correlationId: "search-call-1",
    query: validated.query,
    searchPolicy: openAISearchPolicy(),
    strategyId: "openai-native-web-search",
    ...overrides
  };
}

function openAISearchPolicy(overrides: Partial<OpenAISearchPolicy> = {}): OpenAISearchPolicy {
  return {
    maxOutputTokens: 4_096,
    modelCapabilities: capabilities(),
    modelId: "gpt-5.6-terra",
    provider: "openai",
    reasoningPolicy: "lowest_supported",
    strategyId: "openai-responses-web-search",
    ...overrides
  };
}

function client(create: OpenAIResponsesClient["create"]): OpenAIResponsesClient {
  return {
    cancel: async () => ({}),
    create,
    retrieve: async () => ({})
  };
}

describe("OpenAI Responses query-only Search adapter", () => {
  it("builds a dedicated bounded foreground request without answer defaults", () => {
    expect(buildOpenAIResponsesSearchRequest(searchRequest())).toEqual({
      background: false,
      include: ["web_search_call.action.sources"],
      input: [{
        content: [{ text: "latest news in Moscow", type: "input_text" }],
        role: "user"
      }],
      instructions: "Search the web for the query. Return concise source-backed findings.",
      max_output_tokens: 4_096,
      model: "gpt-5.6-terra",
      reasoning: { effort: "none" },
      store: false,
      stream: false,
      tool_choice: "required",
      tools: [{ type: "web_search" }]
    });
  });

  it("uses only advertised effort values and omits reasoning for unknown or disabled support", () => {
    expect(lowestSupportedOpenAIResponsesSearchEffort(capabilities({
      reasoningEfforts: ["high", "low", "medium"]
    }))).toBe("low");
    expect(lowestSupportedOpenAIResponsesSearchEffort(capabilities({
      reasoning: false,
      reasoningEfforts: ["low"]
    }))).toBeUndefined();
    expect(lowestSupportedOpenAIResponsesSearchEffort(capabilities({
      reasoningEfforts: undefined
    }))).toBeUndefined();

    const disabled = searchRequest({
      searchPolicy: openAISearchPolicy({
        modelCapabilities: capabilities({ reasoning: false, reasoningEfforts: undefined }),
        modelId: "compatible-search",
        provider: "openai_compatible",
        reasoningPolicy: "lowest_supported"
      })
    });
    expect(buildOpenAIResponsesSearchRequest(disabled)).not.toHaveProperty("reasoning");
  });

  it("explicitly omits reasoning under provider_default and rejects unsafe output bounds", () => {
    const providerDefault = searchRequest({
      searchPolicy: openAISearchPolicy({
        reasoningPolicy: "provider_default"
      })
    });
    expect(buildOpenAIResponsesSearchRequest(providerDefault)).not.toHaveProperty("reasoning");

    const tooSmall = searchRequest({
      searchPolicy: openAISearchPolicy({
        maxOutputTokens: 1_023
      })
    });
    expect(() => buildOpenAIResponsesSearchRequest(tooSmall)).toThrow("openai_search_policy_invalid");
  });

  it("returns normalized successful evidence and forwards Search cancellation and timeout", async () => {
    const controller = new AbortController();
    const create = vi.fn<OpenAIResponsesClient["create"]>(async () => ({
      id: "resp-search-1",
      model: "gpt-5.6-terra",
      output: [
        {
          action: {
            query: "Moscow news",
            sources: [{ title: "Source", url: "https://example.com/news" }],
            type: "search"
          },
          id: "ws-1",
          status: "completed",
          type: "web_search_call"
        },
        {
          content: [{
            annotations: [{
              title: "Source",
              type: "url_citation",
              url: "https://example.com/news"
            }],
            text: "Current findings.",
            type: "output_text"
          }],
          type: "message"
        }
      ],
      status: "completed",
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 18
      }
    }));
    const adapter = createOpenAIResponsesSearchAdapter({
      client: client(create),
      provider: "openai"
    });

    const result = await adapter.search(searchRequest(), {
      signal: controller.signal,
      timeoutMs: 45_000
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        background: false,
        max_output_tokens: 4_096,
        store: false,
        stream: false
      }),
      { signal: controller.signal, timeoutMs: 45_000 }
    );
    expect(result).toMatchObject({
      findings: "Current findings.",
      providerResponseId: "resp-search-1",
      requestPreview: {
        body: {
          background: false,
          max_output_tokens: 4_096,
          model: "gpt-5.6-terra",
          reasoning: { effort: "none" },
          store: false,
          stream: false,
          tool: "web_search"
        },
        provider: "openai",
        queryCharacters: 21,
        redactions: ["search_query"],
        stage: "tool_search"
      },
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        reasoningTokens: 2,
        totalTokens: 18
      }
    });
    expect(result.sources).toEqual([{
      rank: 1,
      title: "Source",
      url: "https://example.com/news"
    }]);
    expect(result.artifacts.map((event) => event.type)).toEqual(["artifact", "artifact"]);
  });

  it("normalizes the explicitly requested action sources without response traversal", async () => {
    const adapter = createOpenAIResponsesSearchAdapter({
      client: client(async () => ({
        id: "resp-action-sources",
        output: [{
          action: {
            query: "Moscow news",
            sources: [{
              snippet: "Explicit source evidence",
              title: "Action source",
              url: "https://example.com/action-source"
            }],
            type: "search"
          },
          id: "ws-action-sources",
          status: "completed",
          type: "web_search_call"
        }, {
          content: [{ text: "Current findings.", type: "output_text" }],
          role: "assistant",
          type: "message"
        }],
        status: "completed",
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 }
      })),
      provider: "openai"
    });

    await expect(adapter.search(searchRequest())).resolves.toMatchObject({
      findings: "Current findings.",
      sources: [{
        rank: 1,
        snippet: "Explicit source evidence",
        title: "Action source",
        url: "https://example.com/action-source"
      }]
    });
  });

  it("fails closed when a completed response has findings and citations but no terminal Search operation", async () => {
    const adapter = createOpenAIResponsesSearchAdapter({
      client: client(async () => ({
        id: "resp-no-search-operation",
        output: [{
          content: [{
            annotations: [{
              title: "Unproven source",
              type: "url_citation",
              url: "https://example.com/unproven"
            }],
            text: "Ungrounded findings.",
            type: "output_text"
          }],
          role: "assistant",
          type: "message"
        }],
        status: "completed",
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
      })),
      provider: "openai"
    });

    const error = await adapter.search(searchRequest()).then(() => null, (value: unknown) => value);
    expect(isProviderSearchExecutionError(error)).toBe(true);
    if (!isProviderSearchExecutionError(error)) throw new Error("expected typed Search error");
    expect(error).toMatchObject({
      artifacts: [],
      code: "openai_search_operation_missing",
      providerStatus: "completed",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
    });
    expect(JSON.stringify(error)).not.toContain("Ungrounded findings");
  });

  it("fails closed when a completed Search operation has findings but no safe source", async () => {
    const adapter = createOpenAIResponsesSearchAdapter({
      client: client(async () => ({
        id: "resp-no-safe-source",
        output: [{
          action: {
            query: "Moscow news",
            sources: [{
              title: "Credential-bearing",
              url: "https://user:PRIVATE_PASSWORD@example.com/private"
            }],
            type: "search"
          },
          id: "ws-no-source",
          status: "completed",
          type: "web_search_call"
        }, {
          content: [{ text: "Current findings.", type: "output_text" }],
          role: "assistant",
          type: "message"
        }],
        status: "completed",
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
      })),
      provider: "openai"
    });

    const error = await adapter.search(searchRequest()).then(() => null, (value: unknown) => value);
    expect(isProviderSearchExecutionError(error)).toBe(true);
    if (!isProviderSearchExecutionError(error)) throw new Error("expected typed Search error");
    expect(error).toMatchObject({
      code: "openai_search_sources_invalid",
      providerStatus: "completed",
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 }
    });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_PASSWORD");
  });

  it("throws a raw-free typed incomplete error with reason, usage, and bounded operations", async () => {
    const adapter = createOpenAIResponsesSearchAdapter({
      client: client(async () => ({
        id: "resp-incomplete",
        incomplete_details: {
          private_debug: "must-not-leak",
          reason: "max_output_tokens"
        },
        output: [{
          action: {
            query: "Moscow news",
            secret: "must-not-leak",
            sources: [{ snippet: "must-not-leak", url: "https://example.com/private" }],
            type: "search"
          },
          id: "ws-incomplete",
          status: "incomplete",
          type: "web_search_call"
        }],
        output_text: "must-not-leak",
        status: "incomplete",
        usage: {
          input_tokens: 9,
          output_tokens: 4,
          output_tokens_details: { reasoning_tokens: 4 },
          total_tokens: 13
        }
      })),
      provider: "openai"
    });

    const error = await adapter.search(searchRequest()).then(
      () => null,
      (value: unknown) => value
    );
    expect(isProviderSearchExecutionError(error)).toBe(true);
    if (!isProviderSearchExecutionError(error)) throw new Error("expected typed Search error");
    expect(error).toMatchObject({
      artifacts: [{
        data: {
          artifactType: "search",
          payload: {
            action: { query: "Moscow news", type: "search" },
            id: "ws-incomplete",
            outputIndex: 0,
            provider: "openai",
            status: "incomplete",
            type: "web_search_call"
          }
        },
        type: "artifact"
      }],
      code: "openai_response_incomplete",
      providerStatus: "incomplete",
      reason: "max_output_tokens",
      usage: {
        inputTokens: 9,
        outputTokens: 4,
        reasoningTokens: 4,
        totalTokens: 13
      }
    });
    expect(JSON.stringify(error)).not.toContain("must-not-leak");
    expect(error).not.toHaveProperty("response");
  });

  it("omits unknown incomplete reasons and maps compatible reasoning without answer params", async () => {
    const create = vi.fn<OpenAIResponsesClient["create"]>(async () => ({
      incomplete_details: { reason: "gateway_specific_reason" },
      status: "incomplete",
      usage: {}
    }));
    const adapter = createOpenAIResponsesSearchAdapter({
      client: client(create),
      provider: "openai_compatible",
      reasoningRequestMapping: { effortPath: "reasoning_effort" }
    });
    const request = searchRequest({
      searchPolicy: openAISearchPolicy({
        modelCapabilities: capabilities({ reasoningEfforts: ["medium", "low"] }),
        modelId: "compatible-search",
        provider: "openai_compatible",
        reasoningPolicy: "lowest_supported"
      })
    });

    const error = await adapter.search(request).then(() => null, (value: unknown) => value);
    expect(isProviderSearchExecutionError(error)).toBe(true);
    if (!isProviderSearchExecutionError(error)) throw new Error("expected typed Search error");
    expect(error.reason).toBeUndefined();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      background: false,
      max_output_tokens: 4_096,
      reasoning_effort: "low",
      store: false,
      stream: false
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("reasoning");
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("temperature");
  });
});
