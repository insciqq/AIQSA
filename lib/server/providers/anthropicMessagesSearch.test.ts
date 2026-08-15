import { describe, expect, it, vi } from "vitest";
import { validateSearchToolArguments } from "../search/query";
import { createFetchAnthropicMessagesClient } from "./anthropicMessages";
import {
  buildAnthropicMessagesSearchRequest,
  createAnthropicMessagesSearchAdapter,
  lowestSupportedAnthropicSearchEffort,
  type AnthropicMessagesSearchClient
} from "./anthropicMessagesSearch";
import {
  isProviderSearchExecutionError,
  type ProviderModelCapabilities,
  type ProviderSearchPolicy,
  type ProviderSearchRequest
} from "./types";

type AnthropicSearchPolicy = Extract<
  ProviderSearchPolicy,
  { provider: "anthropic" }
>;

function capabilities(
  overrides: Partial<ProviderModelCapabilities> = {}
): ProviderModelCapabilities {
  return {
    nativePdfInput: true,
    nativeSearch: true,
    pdf: true,
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    streaming: true,
    toolCalling: true,
    vision: true,
    ...overrides
  };
}

function policy(overrides: Partial<AnthropicSearchPolicy> = {}): AnthropicSearchPolicy {
  return {
    maxOutputTokens: 4_096,
    modelCapabilities: capabilities(),
    modelId: "claude-opus-5",
    provider: "anthropic",
    reasoningPolicy: "lowest_supported",
    strategyId: "anthropic-web-search",
    ...overrides
  };
}

function searchRequest(
  overrides: Partial<ProviderSearchRequest> = {}
): ProviderSearchRequest {
  const decoded = validateSearchToolArguments({ query: "latest news in Moscow" });
  if (!decoded.ok) throw new Error(decoded.code);
  return {
    correlationId: "search-call-1",
    query: decoded.query,
    searchPolicy: policy(),
    strategyId: "anthropic-web-search",
    ...overrides
  };
}

function searchCall(id = "srvtoolu-1") {
  return {
    id,
    input: { query: "Moscow news" },
    name: "web_search",
    type: "server_tool_use"
  };
}

function searchResult(id = "srvtoolu-1", overrides: Record<string, unknown> = {}) {
  return {
    caller: { type: "direct" },
    content: [{
      encrypted_content: "PRIVATE_ENCRYPTED_RESULT",
      page_age: "2026-08-04",
      title: "Current report",
      type: "web_search_result",
      url: "https://example.com/report"
    }],
    tool_use_id: id,
    type: "web_search_tool_result",
    ...overrides
  };
}

function citedText(title: string | null = "Current report") {
  return {
    citations: [{
      cited_text: "A concise supported fact.",
      encrypted_index: "PRIVATE_ENCRYPTED_INDEX",
      title,
      type: "web_search_result_location",
      url: "https://example.com/report"
    }],
    text: "Current findings.",
    type: "text"
  };
}

function message(input: Readonly<{
  content: Record<string, unknown>[];
  id?: string;
  stopReason?: string;
  usage?: Record<string, unknown>;
}>) {
  return {
    content: input.content,
    id: input.id ?? "msg-search-1",
    model: "claude-opus-5",
    role: "assistant",
    stop_reason: input.stopReason ?? "end_turn",
    type: "message",
    usage: input.usage ?? {
      input_tokens: 7,
      output_tokens: 5,
      output_tokens_details: { thinking_tokens: 1 },
      server_tool_use: { web_search_requests: 1 }
    }
  };
}

function client(
  createMessage: AnthropicMessagesSearchClient["createMessage"]
): AnthropicMessagesSearchClient {
  return { createMessage };
}

describe("Anthropic Messages query-only Search adapter", () => {
  it("builds only the bounded query request with the reviewed basic direct tool", () => {
    expect(buildAnthropicMessagesSearchRequest(searchRequest())).toEqual({
      max_tokens: 4_096,
      messages: [{
        content: [{ text: "latest news in Moscow", type: "text" }],
        role: "user"
      }],
      model: "claude-opus-5",
      output_config: { effort: "low" },
      stream: false,
      system: "Use Web Search for the query and return concise source-backed findings.",
      thinking: { type: "adaptive" },
      tools: [{
        allowed_callers: ["direct"],
        max_uses: 3,
        name: "web_search",
        type: "web_search_20250305"
      }]
    });
  });

  it("uses only advertised effort and omits reasoning under provider_default", () => {
    expect(lowestSupportedAnthropicSearchEffort(capabilities({
      reasoningEfforts: ["high", "medium"]
    }))).toBe("medium");
    expect(lowestSupportedAnthropicSearchEffort(capabilities({
      reasoning: false,
      reasoningEfforts: ["low"]
    }))).toBeUndefined();

    const body = buildAnthropicMessagesSearchRequest(searchRequest({
      searchPolicy: policy({ reasoningPolicy: "provider_default" })
    }));
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("output_config");
  });

  it("normalizes operation, citation, usage, and raw-free previews", async () => {
    const createMessage = vi.fn<AnthropicMessagesSearchClient["createMessage"]>(
      async () => message({ content: [searchCall(), searchResult(), citedText(null)] })
    );
    const adapter = createAnthropicMessagesSearchAdapter({ client: client(createMessage) });
    const result = await adapter.search(searchRequest(), { timeoutMs: 45_000 });

    expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({
      max_tokens: 4_096,
      messages: [{
        content: [{ text: "latest news in Moscow", type: "text" }],
        role: "user"
      }],
      stream: false,
      tools: [{
        allowed_callers: ["direct"],
        max_uses: 3,
        name: "web_search",
        type: "web_search_20250305"
      }]
    }), expect.objectContaining({ timeoutMs: 45_000 }));
    expect(result).toMatchObject({
      finalProviderResponsePreview: {
        continuationCount: 0,
        operationCount: 1,
        sourceCount: 1,
        status: "completed",
        webSearchRequests: 1
      },
      findings: "Current findings.",
      providerResponseId: "msg-search-1",
      requestPreview: {
        body: {
          max_tokens: 4_096,
          model: "claude-opus-5",
          stream: false,
          tool: {
            allowed_callers: ["direct"],
            max_uses: 3,
            name: "web_search",
            type: "web_search_20250305"
          }
        },
        provider: "anthropic",
        queryCharacters: 21,
        stage: "tool_search"
      },
      usage: {
        inputTokens: 7,
        outputTokens: 5,
        reasoningTokens: 1,
        totalTokens: 12
      }
    });
    expect(result.sources).toEqual([{
      rank: 1,
      snippet: "A concise supported fact.",
      title: "https://example.com/report",
      url: "https://example.com/report"
    }]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_ENCRYPTED_RESULT|PRIVATE_ENCRYPTED_INDEX/u);
  });

  it("replays a paused assistant message exactly and resolves its result on the next hop", async () => {
    const pausedContent = [
      {
        signature: "PRIVATE_THINKING_SIGNATURE",
        thinking: "PRIVATE_THINKING_CONTENT",
        type: "thinking"
      },
      searchCall("srvtoolu-paused")
    ];
    const responses = [
      message({
        content: pausedContent,
        id: "msg-paused",
        stopReason: "pause_turn",
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          server_tool_use: { web_search_requests: 1 }
        }
      }),
      message({
        content: [
          searchResult("srvtoolu-paused"),
          citedText()
        ],
        id: "msg-complete",
        usage: {
          input_tokens: 4,
          output_tokens: 3,
          server_tool_use: { web_search_requests: 0 }
        }
      })
    ];
    const createMessage = vi.fn<AnthropicMessagesSearchClient["createMessage"]>(
      async () => responses.shift()!
    );
    const adapter = createAnthropicMessagesSearchAdapter({ client: client(createMessage) });
    const result = await adapter.search(searchRequest());

    expect(createMessage).toHaveBeenCalledTimes(2);
    const continuationBody = createMessage.mock.calls[1]?.[0] as {
      messages: Record<string, unknown>[];
      tools: Record<string, unknown>[];
    };
    expect(continuationBody.messages[1]).toEqual({
      content: pausedContent,
      role: "assistant"
    });
    expect(continuationBody.tools).toEqual([{
      allowed_callers: ["direct"],
      max_uses: 3,
      name: "web_search",
      type: "web_search_20250305"
    }]);
    expect(result).toMatchObject({
      finalProviderResponsePreview: {
        continuationCount: 1,
        webSearchRequests: 1
      },
      providerResponseId: "msg-complete",
      usage: {
        inputTokens: 6,
        outputTokens: 4,
        totalTokens: 10
      }
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_THINKING_CONTENT|PRIVATE_THINKING_SIGNATURE/u
    );
  });

  it("rejects unknown response content blocks instead of retaining provider fields", async () => {
    const adapter = createAnthropicMessagesSearchAdapter({
      client: client(async () => message({
        content: [{ secret: "PRIVATE_UNKNOWN_BLOCK", type: "future_block" }]
      }))
    });
    const error = await adapter.search(searchRequest()).then(
      () => null,
      (value: unknown) => value
    );

    expect(error).toMatchObject({ code: "anthropic_search_response_invalid" });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_UNKNOWN_BLOCK");
  });

  it("rejects a non-direct Search result caller under the basic direct contract", async () => {
    const adapter = createAnthropicMessagesSearchAdapter({
      client: client(async () => message({
        content: [
          searchCall(),
          searchResult("srvtoolu-1", {
            caller: {
              tool_id: "PRIVATE_CODE_EXECUTION_CALL",
              type: "code_execution_20260120"
            }
          })
        ]
      }))
    });
    const error = await adapter.search(searchRequest()).then(
      () => null,
      (value: unknown) => value
    );

    expect(error).toMatchObject({ code: "anthropic_search_response_invalid" });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_CODE_EXECUTION_CALL");
  });

  it("caps pause_turn at three continuation requests", async () => {
    let ordinal = 0;
    const createMessage = vi.fn<AnthropicMessagesSearchClient["createMessage"]>(
      async () => {
        ordinal += 1;
        return message({
          content: [searchCall(`srvtoolu-${ordinal}`)],
          id: `msg-${ordinal}`,
          stopReason: "pause_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        });
      }
    );
    const adapter = createAnthropicMessagesSearchAdapter({ client: client(createMessage) });
    const error = await adapter.search(searchRequest()).then(
      () => null,
      (value: unknown) => value
    );

    expect(createMessage).toHaveBeenCalledTimes(4);
    expect(isProviderSearchExecutionError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "anthropic_search_pause_limit_exceeded",
      providerStatus: "pause_turn",
      usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 }
    });
  });

  it("rejects unsafe aggregate usage while retaining the last safe hop", async () => {
    const responses = [
      message({
        content: [searchCall("srvtoolu-usage")],
        stopReason: "pause_turn",
        usage: {
          input_tokens: Number.MAX_SAFE_INTEGER,
          output_tokens: 0,
          server_tool_use: { web_search_requests: 1 }
        }
      }),
      message({
        content: [searchResult("srvtoolu-usage"), citedText()],
        usage: {
          input_tokens: 1,
          output_tokens: 0,
          server_tool_use: { web_search_requests: 0 }
        }
      })
    ];
    const adapter = createAnthropicMessagesSearchAdapter({
      client: client(async () => responses.shift()!)
    });
    const error = await adapter.search(searchRequest()).then(
      () => null,
      (value: unknown) => value
    );

    expect(isProviderSearchExecutionError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "anthropic_usage_invalid",
      usage: {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 0,
        totalTokens: Number.MAX_SAFE_INTEGER
      }
    });
  });

  it("retains completed pause-hop usage and evidence on a local Search timeout", async () => {
    const controller = new AbortController();
    let attempt = 0;
    const createMessage = vi.fn<AnthropicMessagesSearchClient["createMessage"]>(
      async (_body, options) => {
        attempt += 1;
        if (attempt === 1) {
          return message({
            content: [searchCall(), searchResult(), citedText()],
            stopReason: "pause_turn",
            usage: {
              input_tokens: 2,
              output_tokens: 1,
              server_tool_use: { web_search_requests: 1 }
            }
          });
        }
        return await new Promise<Record<string, unknown>>((_, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(options.signal?.reason);
          }, { once: true });
        });
      }
    );
    const adapter = createAnthropicMessagesSearchAdapter({ client: client(createMessage) });
    const pending = adapter.search(searchRequest(), { signal: controller.signal });
    await vi.waitFor(() => expect(createMessage).toHaveBeenCalledTimes(2));
    controller.abort(new Error("search_timeout"));
    const error = await pending.then(() => null, (value: unknown) => value);

    expect(isProviderSearchExecutionError(error)).toBe(true);
    if (!isProviderSearchExecutionError(error)) throw new Error("expected typed Search error");
    expect(error).toMatchObject({
      code: "search_timeout",
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }
    });
  });

  it("preserves non-timeout caller cancellation", async () => {
    const controller = new AbortController();
    const callerAbort = new DOMException("cancelled by caller", "AbortError");
    const adapter = createAnthropicMessagesSearchAdapter({
      client: client(async (_body, options) =>
        await new Promise<Record<string, unknown>>((_, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true
          });
        }))
    });
    const pending = adapter.search(searchRequest(), { signal: controller.signal });
    controller.abort(callerAbort);

    await expect(pending).rejects.toBe(callerAbort);
  });

  it.each([
    "too_many_requests",
    "invalid_tool_input",
    "max_uses_exceeded",
    "query_too_long",
    "request_too_large",
    "unavailable"
  ])("maps embedded %s without retaining provider content", async (errorCode) => {
    const adapter = createAnthropicMessagesSearchAdapter({
      client: client(async () => message({
        content: [
          searchCall(),
          searchResult("srvtoolu-1", {
            content: {
              error_code: errorCode,
              type: "web_search_tool_result_error"
            }
          })
        ]
      }))
    });
    const error = await adapter.search(searchRequest()).then(
      () => null,
      (value: unknown) => value
    );

    expect(isProviderSearchExecutionError(error)).toBe(true);
    expect(error).toMatchObject({
      code: `anthropic_search_${errorCode}`,
      providerStatus: "end_turn"
    });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_ENCRYPTED_RESULT");
  });

  it("fails a completed empty result as source-missing without raw response retention", async () => {
    const adapter = createAnthropicMessagesSearchAdapter({
      client: client(async () => message({
        content: [
          searchCall(),
          searchResult("srvtoolu-1", { content: [] }),
          { text: "No current result.", type: "text" }
        ]
      }))
    });
    const error = await adapter.search(searchRequest()).then(
      () => null,
      (value: unknown) => value
    );

    expect(isProviderSearchExecutionError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "anthropic_search_sources_missing",
      usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 }
    });
  });

  it("bounds and parses the non-stream transport without exposing invalid JSON", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ stream: false });
      expect(new Headers(init?.headers).get("x-api-key")).toBe("key");
      return new Response(JSON.stringify(message({ content: [] })));
    });
    const transport = createFetchAnthropicMessagesClient({
      apiKey: "key",
      fetchFn
    });
    await expect(transport.createMessage({ stream: false })).resolves.toMatchObject({
      id: "msg-search-1",
      type: "message"
    });
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe("https://api.anthropic.com/v1/messages");

    const invalid = createFetchAnthropicMessagesClient({
      apiKey: "key",
      fetchFn: async () => new Response("PRIVATE not-json")
    });
    await expect(invalid.createMessage({ stream: false })).rejects.toThrow(
      "anthropic_response_invalid_json"
    );
  });
});
