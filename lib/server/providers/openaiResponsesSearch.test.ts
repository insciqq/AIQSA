import { describe, expect, it, vi } from "vitest";
import { validateSearchToolArguments } from "../search/query";
import { SEARCH_RESULT_LIST_FINDINGS, searchToolResultText } from "../search/toolResult";
import {
  buildOpenAIResponsesSearchRequest,
  createOpenAIResponsesSearchAdapter,
  lowestSupportedOpenAIResponsesSearchEffort,
  OPENAI_SEARCH_INSTRUCTIONS,
  OPENAI_SEARCH_MAX_ENTRIES
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
      instructions: OPENAI_SEARCH_INSTRUCTIONS,
      max_output_tokens: 4_096,
      model: "gpt-5.6-terra",
      reasoning: { effort: "none" },
      store: false,
      stream: false,
      tool_choice: "required",
      tools: [{ search_context_size: "low", type: "web_search" }]
    });
    // The technical model is told to stay on the result list and to write one cited line per source.
    expect(OPENAI_SEARCH_INSTRUCTIONS).toContain("open a page only when the list lacks the fact");
    expect(OPENAI_SEARCH_INSTRUCTIONS).toContain(`at most ${OPENAI_SEARCH_MAX_ENTRIES} lines`);
    expect(OPENAI_SEARCH_INSTRUCTIONS).toContain("Cite the source within its line");
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
        maxOutputTokens: 15
      })
    });
    expect(() => buildOpenAIResponsesSearchRequest(tooSmall)).toThrow("openai_search_policy_invalid");
  });

  it("does not select minimal reasoning for web search even when the answer model advertises it", () => {
    const request = searchRequest({ searchPolicy: openAISearchPolicy({
      modelId: "gpt-5",
      modelCapabilities: capabilities({ reasoningEfforts: ["minimal", "low", "medium", "high"] })
    }) });
    expect(buildOpenAIResponsesSearchRequest(request)).toMatchObject({
      reasoning: { effort: "low" }, tools: [{ type: "web_search" }]
    });
    expect(lowestSupportedOpenAIResponsesSearchEffort(capabilities({ reasoningEfforts: ["minimal"] })))
      .toBeUndefined();
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
      citation: 1,
      rank: 1,
      title: "Source",
      url: "https://example.com/news"
    }]);
    expect(result.artifacts.map((event) => event.type)).toEqual(["artifact", "artifact"]);
  });

  it("reports the billed search calls, never page actions, in success, failure and dispatch usage", async () => {
    const output = [
      { action: { query: "Moscow news", sources: [{ title: "Source", url: "https://example.com/news" }], type: "search" },
        id: "ws-1", status: "completed", type: "web_search_call" },
      { action: { type: "open_page", url: "https://example.com/news" }, id: "ws-2", status: "completed", type: "web_search_call" },
      { action: { pattern: "Moscow", type: "find_in_page", url: "https://example.com/news" }, id: "ws-3", status: "completed", type: "web_search_call" },
      // A call without its action (the older shape) is still a billed search.
      { id: "ws-4", status: "completed", type: "web_search_call" },
      { content: [{ annotations: [{ title: "Source", type: "url_citation", url: "https://example.com/news" }],
        text: "Current findings.", type: "output_text" }], type: "message" }
    ];
    const usage = { input_tokens: 11, output_tokens: 7, total_tokens: 18 };
    const dispatched: unknown[] = [];
    const completed = createOpenAIResponsesSearchAdapter({
      client: client(async () => ({ id: "resp-search-1", output, status: "completed", usage })), provider: "openai"
    });
    const result = await completed.search(searchRequest(), {
      dispatch: async (attempt) => {
        const response = await attempt.execute();
        dispatched.push(attempt.usage(response));
        return response;
      }
    });
    expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 7, totalTokens: 18, webSearchCount: 2 });
    expect(dispatched).toEqual([result.usage]);

    const incomplete = createOpenAIResponsesSearchAdapter({
      client: client(async () => ({ id: "resp-search-2", output: output.slice(0, 2), status: "incomplete", usage })), provider: "openai"
    });
    await expect(incomplete.search(searchRequest())).rejects.toMatchObject({
      code: "openai_response_incomplete", usage: { inputTokens: 11, webSearchCount: 1 } });
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

  it("merges a cited page with its browsed source despite OpenAI's attribution parameters", async () => {
    const adapter = createOpenAIResponsesSearchAdapter({
      client: client(async () => ({
        id: "resp-attributed-citations",
        output: [{
          action: {
            query: "Moscow news",
            sources: [
              { title: "Other page", url: "https://example.com/other" },
              { snippet: "Browsed snippet", title: "Page A", url: "https://example.com/a" },
              { title: "Item 1", url: "https://example.com/item?id=1" },
              { title: "Query page", url: "https://example.com/find?q=a%20b" }
            ],
            type: "search"
          },
          id: "ws-attributed-citations",
          status: "completed",
          type: "web_search_call"
        }, {
          content: [{
            annotations: [
              { title: "Cited A", type: "url_citation", url: "https://example.com/a?utm_source=openai" },
              // Another query parameter still names another page.
              { title: "Cited item 2", type: "url_citation", url: "https://example.com/item?utm_source=openai&id=2" },
              { title: "Cited query", type: "url_citation", url: "https://example.com/find?q=a%20b&UTM_Medium=chat&utm_source=openai" }
            ],
            text: "Current findings.",
            type: "output_text"
          }],
          role: "assistant",
          type: "message"
        }],
        status: "completed",
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 }
      })),
      provider: "openai"
    });

    const result = await adapter.search(searchRequest());

    // The title is the citation's; the browsed page gives its own URL and snippet.
    expect(result.sources).toEqual([
      { citation: 1, rank: 1, snippet: "Browsed snippet", title: "Cited A", url: "https://example.com/a" },
      { citation: 2, rank: 2, title: "Cited item 2", url: "https://example.com/item?id=2" },
      { citation: 3, rank: 3, title: "Cited query", url: "https://example.com/find?q=a%20b" },
      { rank: 4, title: "Other page", url: "https://example.com/other" },
      { rank: 5, title: "Item 1", url: "https://example.com/item?id=1" }
    ]);
  });

  it("puts cited sources first with their citation order, before sources the engine only browsed", async () => {
    const browsed = Array.from({ length: 8 }, (_, index) => ({
      title: `Browsed ${index}`, url: `https://example.com/browsed/${index}`
    }));
    const cited = Array.from({ length: 3 }, (_, index) => ({
      title: `Cited ${index}`, type: "url_citation", url: `https://example.com/cited/${index}`
    }));
    const adapter = createOpenAIResponsesSearchAdapter({
      client: client(async () => ({
        id: "resp-cited-sources",
        output: [{
          action: { query: "Moscow news", sources: browsed, type: "search" },
          id: "ws-cited-sources",
          status: "completed",
          type: "web_search_call"
        }, {
          content: [{
            // The same page cited twice keeps one number; a browsed page it
            // also cites is one source under the citation's title.
            annotations: [...cited, cited[0], { ...browsed[5], title: "Cited browsed", type: "url_citation" }],
            text: "Current findings.",
            type: "output_text"
          }],
          role: "assistant",
          type: "message"
        }],
        status: "completed",
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 }
      })),
      provider: "openai"
    });

    const result = await adapter.search(searchRequest());

    expect(result.sources.map(({ citation, rank, title }) => ({ citation, rank, title }))).toEqual([
      { citation: 1, rank: 1, title: "Cited 0" },
      { citation: 2, rank: 2, title: "Cited 1" },
      { citation: 3, rank: 3, title: "Cited 2" },
      { citation: 4, rank: 4, title: "Cited browsed" },
      ...[0, 1, 2, 3, 4, 6, 7].map((index, position) => ({ citation: undefined, rank: position + 5, title: `Browsed ${index}` }))
    ]);
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
    expect(adapter.buildRequestPreview(request).body).not.toHaveProperty("background");

    const error = await adapter.search(request).then(() => null, (value: unknown) => value);
    expect(isProviderSearchExecutionError(error)).toBe(true);
    if (!isProviderSearchExecutionError(error)) throw new Error("expected typed Search error");
    expect(error.reason).toBeUndefined();
    const outboundBody = create.mock.calls[0]?.[0];
    expect(outboundBody).toMatchObject({
      max_output_tokens: 4_096,
      reasoning_effort: "low",
      store: false,
      stream: false
    });
    expect(outboundBody).not.toHaveProperty("background");
    expect(outboundBody).not.toHaveProperty("reasoning");
    expect(outboundBody).not.toHaveProperty("temperature");
  });
});

type Citation = Readonly<{ title: string; url: string }>;
type Offsets = "code_points" | "utf16" | "none";

/**
 * A message text block shaped as OpenAI's hosted search returns one: each
 * citation is written into the text as `([host](url))` and annotated with
 * its span, which OpenAI counts in code points.
 */
function citedBlock(parts: readonly (string | Citation)[], offsets: Offsets = "code_points") {
  let text = "";
  const annotations: Record<string, unknown>[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    const link = ` ([${new URL(part.url).hostname}](${part.url}))`;
    const position = (value: string) => offsets === "utf16" ? value.length : Array.from(value).length;
    const start = position(text);
    text += link;
    annotations.push({
      ...(offsets === "none" ? {} : { end_index: position(text), start_index: start }),
      title: part.title,
      type: "url_citation",
      url: part.url
    });
  }
  return { annotations, text, type: "output_text" };
}

function searchResponse(
  block: Readonly<Record<string, unknown>>,
  browsed: readonly Readonly<Record<string, unknown>>[] = []
) {
  return {
    id: "resp-entries",
    output: [{
      action: { query: "bridge", sources: browsed, type: "search" },
      id: "ws-entries",
      status: "completed",
      type: "web_search_call"
    }, { content: [block], role: "assistant", type: "message" }],
    status: "completed",
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 }
  };
}

async function searchWith(response: Readonly<Record<string, unknown>>) {
  return createOpenAIResponsesSearchAdapter({ client: client(async () => response), provider: "openai" })
    .search(searchRequest());
}

function rendered(result: Awaited<ReturnType<typeof searchWith>>): string {
  return searchToolResultText([{
    displayName: "OpenAI", findings: result.findings, invocationId: "call-1:openai", modelId: "gpt-6-luna",
    optionId: "openai", provider: "openai", revisionId: "revision-1", sources: result.sources,
    status: "complete", usage: result.usage
  }]);
}

const pageA = { title: "Bridge history", url: "https://example.com/a?utm_source=openai" };
const pageB = { title: "Bridge facts", url: "https://news.example.org/b?utm_source=openai" };
const pageC = { title: "Span record", url: "https://example.net/c" };

describe("OpenAI client engine entries", () => {
  it("gives each cited source its entry's claim, passage and date, and takes URLs only from citations", async () => {
    const result = await searchWith(searchResponse(citedBlock([
      "Claim: The bridge opened in 1932 | Passage: \"opened to traffic on 19 March 1932\" | Date: 2024-05-01", pageA, "\n",
      "- **Claim:** Its span is 503 m | Passage: “The arch spans 503 metres” | Date: unknown", pageB, pageC, "\n",
      // A link the model writes itself is never a source.
      "Claim: Opening day drew crowds, see [this page](https://evil.example/fake) | Date: 2023-01-02", pageA
    ]), [{ type: "url", url: "https://example.net/c" }, { type: "url", url: "https://other.example/d" }]));

    expect(result.findings).toBe(SEARCH_RESULT_LIST_FINDINGS);
    expect(result.sources).toEqual([{
      citation: 1, date: "2024-05-01", rank: 1,
      snippet: "The bridge opened in 1932 Quote: \"opened to traffic on 19 March 1932\" … Opening day drew crowds, see this page",
      title: "Bridge history", url: "https://example.com/a"
    }, {
      citation: 2, rank: 2, snippet: "Its span is 503 m Quote: \"The arch spans 503 metres\"",
      title: "Bridge facts", url: "https://news.example.org/b"
    }, {
      citation: 3, rank: 3, snippet: "Its span is 503 m Quote: \"The arch spans 503 metres\"",
      title: "Span record", url: "https://example.net/c"
    }, { rank: 4, title: "other.example", url: "https://other.example/d" }]);
    expect(JSON.stringify(result.sources)).not.toContain("evil.example");

    // The model reads the entries alone, each with its title, site, date, URL and passage.
    const text = rendered(result);
    expect(text).not.toContain(SEARCH_RESULT_LIST_FINDINGS);
    expect(text).toContain([
      "[1] Bridge history — example.com, 2024-05-01",
      "https://example.com/a",
      "The bridge opened in 1932 Quote: \"opened to traffic on 19 March 1932\" … Opening day drew crowds, see this page"
    ].join("\n"));
  });

  it.each(["code_points", "utf16", "none"] as const)(
    "ties citations to their lines past astral characters with %s offsets",
    async (offsets) => {
      const result = await searchWith(searchResponse(citedBlock([
        "Claim: Мост 🌉 открыт в 1932 году | Passage: «открыт для движения 19 марта 1932» | Date: 1932-03-19", pageA, "\n",
        "Claim: Длина 503 м 🌉🌉", pageB
      ], offsets)));

      expect(result.findings).toBe(SEARCH_RESULT_LIST_FINDINGS);
      expect(result.sources).toEqual([{
        citation: 1, date: "1932-03-19", rank: 1, snippet: "Мост 🌉 открыт в 1932 году Quote: \"открыт для движения 19 марта 1932\"",
        title: "Bridge history", url: "https://example.com/a"
      }, { citation: 2, rank: 2, snippet: "Длина 503 м 🌉🌉", title: "Bridge facts", url: "https://news.example.org/b" }]);
    }
  );

  it("keeps uncited lines above the entries and gives a citation alone on its line the line above", async () => {
    const result = await searchWith(searchResponse(citedBlock([
      "The bridge is the city's oldest.\n",
      "Claim: Fact one | Passage: \"quoted one\"\n", pageA, "\n",
      "Claim: Fact two", pageB
    ])));

    expect(result.findings).toBe("The bridge is the city's oldest.");
    expect(result.sources.map(({ snippet, url }) => ({ snippet, url }))).toEqual([
      { snippet: "Fact one Quote: \"quoted one\"", url: "https://example.com/a" },
      { snippet: "Fact two", url: "https://news.example.org/b" }
    ]);
    expect(rendered(result)).toContain([
      "Search source \"OpenAI\":\nThe bridge is the city's oldest.",
      "Sources for \"OpenAI\":\n[1] Bridge history — example.com\nhttps://example.com/a\nFact one Quote: \"quoted one\""
    ].join("\n\n"));
  });

  it("keeps a model text without citations as its findings, with the browsed pages as sources", async () => {
    const result = await searchWith(searchResponse(
      { text: "The bridge opened in 1932 (see https://evil.example/x).", type: "output_text" },
      [{ type: "url", url: "https://example.com/a" }]
    ));

    expect(result.findings).toBe("The bridge opened in 1932 (see https://evil.example/x).");
    expect(result.sources).toEqual([{ rank: 1, title: "example.com", url: "https://example.com/a" }]);
  });

  it.each([
    ["after a search", true],
    ["without a search", false]
  ])("names a refused call %s by its own code without the refusal's words", async (_label, searched) => {
    const response = searchResponse({ refusal: "PRIVATE refusal words", type: "refusal" }, [{ type: "url", url: "https://example.com/a" }]);
    const error = await searchWith(searched ? response : { ...response, output: response.output.slice(1) })
      .then(() => null, (value: unknown) => value);

    expect(isProviderSearchExecutionError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "openai_search_refused", providerStatus: "completed", usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
    });
    expect(JSON.stringify(error)).not.toContain("PRIVATE");
  });
});
