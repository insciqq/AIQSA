import { describe, expect, it, vi } from "vitest";
import { validateSearchToolArguments } from "../search/query";
import { isProviderSearchExecutionError, type ProviderSearchRequest } from "./types";
import type { OpenRouterChatClient } from "./openRouterChatTransport";
import {
  createFakeOpenRouterPerplexitySearchAdapter,
  createOpenRouterPerplexitySearchAdapter
} from "./openRouterPerplexitySearch";

function searchRequest(overrides: Partial<ProviderSearchRequest> = {}): ProviderSearchRequest {
  const validated = validateSearchToolArguments({ query: "Find one concise fact." });
  if (!validated.ok) throw new Error(validated.code);
  return {
    correlationId: "search-call-1",
    query: validated.query,
    searchPolicy: {
      controls: {
        maxOutputTokens: {
          defaultValue: 8192,
          maxValue: 8192
        },
        temperature: {
          defaultValue: 1,
          maxValue: 2,
          minValue: 0,
          supported: true
        }
      },
      defaultParams: {
        maxOutputTokens: 1024,
        provider: {
          allowFallbacks: true,
          dataCollection: "deny",
          order: ["perplexity"],
          requireParameters: false,
          sort: "throughput",
          zdr: false
        },
        reasoning: {
          exclude: true
        },
        stream: false,
        temperature: 0
      },
      modelId: "perplexity/sonar-pro-search",
      provider: "openrouter",
      strategyId: "perplexity-tool-search"
    },
    strategyId: "perplexity-tool-search",
    ...overrides
  };
}

function successfulResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: "Search answer [1]",
          role: "assistant"
        }
      }
    ],
    citations: ["https://example.com/source"],
    id: "or-search-1",
    model: "perplexity/sonar-pro-search",
    object: "chat.completion",
    usage: {
      completion_tokens: 5,
      prompt_tokens: 11
    },
    ...overrides
  };
}

describe("OpenRouter Perplexity search adapter", () => {
  it("owns real request, response, citation, usage, and safe-preview composition", async () => {
    const createChatCompletion = vi.fn<OpenRouterChatClient["createChatCompletion"]>(async () =>
      successfulResponse({
        citations: [
          {
            snippet: "A useful source",
            title: "Primary source",
            url: "https://example.com/source"
          }
        ]
      })
    );
    const adapter = createOpenRouterPerplexitySearchAdapter({
      client: { createChatCompletion }
    });
    const request = searchRequest();

    const result = await adapter.search(request);

    expect(createChatCompletion).toHaveBeenCalledOnce();
    const body = createChatCompletion.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      max_completion_tokens: 1024,
      metadata: {
        app: "aiqsa",
        stage: "tool_search",
        strategy: "perplexity-tool-search"
      },
      model: "perplexity/sonar-pro-search",
      provider: {
        data_collection: "deny",
        order: ["perplexity"],
        require_parameters: false
      },
      stream: false
    });
    expect(body).not.toHaveProperty("cache_control");
    expect(JSON.stringify(body)).toContain("Find one concise fact.");
    expect(result).toMatchObject({
      finalProviderResponsePreview: {
        findingsCharacters: 17,
        model: "perplexity/sonar-pro-search",
        provider: "openrouter",
        sourceCount: 1,
        status: "completed"
      },
      findings: "Search answer [1]",
      providerResponseId: "or-search-1",
      requestPreview: {
        body: {
          model: "perplexity/sonar-pro-search",
          query_characters: 22,
          strategy: "perplexity-tool-search",
          stream: false
        },
        provider: "openrouter",
        redactions: ["search_query"],
        stage: "tool_search"
      },
      usage: {
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        inputTokens: 11,
        outputTokens: 5,
        reasoningTokens: 0,
        totalTokens: 16
      }
    });
    expect(result.sources).toEqual([{
      rank: 1,
      snippet: "A useful source",
      title: "Primary source",
      url: "https://example.com/source"
    }]);
    expect(result.artifacts).toEqual([
      {
        data: {
          artifactType: "search",
          payload: {
            citationCount: 1,
            model: "perplexity/sonar-pro-search",
            provider: "openrouter",
            responseId: "or-search-1",
            strategyId: "perplexity-tool-search"
          }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "citation",
          payload: {
            index: 1,
            snippet: "A useful source",
            source: "openrouter",
            title: "Primary source",
            url: "https://example.com/source"
          }
        },
        type: "artifact"
      }
    ]);
  });

  it("forwards the exact abort signal and Search timeout to the transport client", async () => {
    const controller = new AbortController();
    const createChatCompletion = vi.fn<OpenRouterChatClient["createChatCompletion"]>(async () =>
      successfulResponse()
    );
    const adapter = createOpenRouterPerplexitySearchAdapter({
      client: { createChatCompletion }
    });

    await adapter.search(searchRequest(), { signal: controller.signal, timeoutMs: 300_000 });

    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.any(Object),
      { signal: controller.signal, timeoutMs: 300_000 }
    );
  });

  it("omits hostile citations from artifacts and the bounded provider preview", async () => {
    const adapter = createOpenRouterPerplexitySearchAdapter({
      client: {
        createChatCompletion: async () =>
          successfulResponse({
            citations: [
              "javascript:alert(1)",
              "https://example.com/safe",
              { href: "data:text/html,hostile", title: "Unsafe object" }
            ]
          })
      }
    });

    const result = await adapter.search(searchRequest());
    const citationArtifacts = result.artifacts.filter(
      (artifact) => artifact.type === "artifact" && artifact.data.artifactType === "citation"
    );

    expect(citationArtifacts).toEqual([
      {
        data: {
          artifactType: "citation",
          payload: {
            index: 2,
            source: "openrouter",
            title: "Source 2",
            url: "https://example.com/safe"
          }
        },
        type: "artifact"
      }
    ]);
    expect(result.finalProviderResponsePreview).toMatchObject({
      findingsCharacters: 17,
      sourceCount: 1,
      status: "completed"
    });
    expect(JSON.stringify(result.finalProviderResponsePreview)).not.toMatch(/javascript:|data:text/u);
  });

  it("normalizes and deduplicates current nested OpenRouter annotations", async () => {
    const adapter = createOpenRouterPerplexitySearchAdapter({
      client: {
        createChatCompletion: async () => successfulResponse({
          choices: [{
            finish_reason: "stop",
            message: {
              annotations: [{
                type: "url_citation",
                url_citation: {
                  content: "Nested excerpt",
                  title: "Nested source",
                  url: "https://example.com/nested"
                }
              }, {
                type: "url_citation",
                url_citation: {
                  title: "Duplicate",
                  url: "https://example.com/nested"
                }
              }],
              content: "Search answer [1]",
              role: "assistant"
            }
          }],
          citations: []
        })
      }
    });

    await expect(adapter.search(searchRequest())).resolves.toMatchObject({
      sources: [{
        rank: 1,
        snippet: "Nested excerpt",
        title: "Nested source",
        url: "https://example.com/nested"
      }]
    });
  });

  it("returns a raw-free typed failure when no safe source proves Search", async () => {
    const adapter = createOpenRouterPerplexitySearchAdapter({
      client: {
        createChatCompletion: async () => successfulResponse({
          citations: [{
            content: "PRIVATE_PROVIDER_CONTENT",
            url: "https://user:PRIVATE_PASSWORD@example.com/private"
          }]
        })
      }
    });

    const error = await adapter.search(searchRequest()).then(() => null, (value: unknown) => value);
    expect(isProviderSearchExecutionError(error)).toBe(true);
    if (!isProviderSearchExecutionError(error)) throw new Error("expected typed Search error");
    expect(error).toMatchObject({
      code: "openrouter_search_sources_invalid",
      usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 }
    });
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE_PROVIDER_CONTENT|PRIVATE_PASSWORD/u);
  });

  it.each([
    ["top-level", { error: { code: "provider_error", message: "Top-level failure" } }],
    [
      "choice",
      { choices: [{ error: { code: "choice_error", message: "Choice failure" } }] }
    ],
    [
      "message",
      { choices: [{ message: { error: { code: "message_error", message: "Message failure" } } }] }
    ]
  ])("rejects HTTP-200 %s error objects without exposing remote detail", async (_location, response) => {
    const adapter = createOpenRouterPerplexitySearchAdapter({
      client: {
        createChatCompletion: async () => response
      }
    });

    await expect(adapter.search(searchRequest())).rejects.toThrow("openrouter_response_error");
  });

  it.each([
    ["empty object", {}],
    ["empty choices", { choices: [] }],
    ["choice without message", { choices: [{ finish_reason: "stop" }] }],
    [
      "tool-only search result",
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  function: { arguments: "{}", name: "unexpected" },
                  id: "call-1"
                }
              ]
            }
          }
        ]
      }
    ]
  ])("rejects malformed HTTP-200 search terminal JSON: %s", async (_label, response) => {
    const adapter = createOpenRouterPerplexitySearchAdapter({
      client: {
        createChatCompletion: async () => response
      }
    });

    await expect(adapter.search(searchRequest())).rejects.toThrow(
      "openrouter_terminal_response_invalid"
    );
  });

  it("accepts a usable content-array search response", async () => {
    const adapter = createOpenRouterPerplexitySearchAdapter({
      client: {
        createChatCompletion: async () =>
          successfulResponse({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: [
                    { text: "Search ", type: "text" },
                    { text: "answer", type: "text" }
                  ],
                  role: "assistant"
                }
              }
            ]
          })
      }
    });

    await expect(adapter.search(searchRequest())).resolves.toMatchObject({
      findings: "Search answer"
    });
  });

  it("does not misclassify nullable or scalar error-shaped fields", async () => {
    const response = successfulResponse({
      choices: [
        {
          error: "diagnostic-only",
          message: {
            content: "Successful answer",
            error: null,
            role: "assistant"
          }
        }
      ],
      error: null
    });
    const adapter = createOpenRouterPerplexitySearchAdapter({
      client: {
        createChatCompletion: async () => response
      }
    });

    await expect(adapter.search(searchRequest())).resolves.toMatchObject({
      findings: "Successful answer",
      providerResponseId: "or-search-1"
    });
  });

  it("preserves deterministic fake result, artifacts, usage, and request preview", async () => {
    const adapter = createFakeOpenRouterPerplexitySearchAdapter();

    const result = await adapter.search(searchRequest());

    expect(result.findings).toBe(
      "Fake Perplexity search findings for: Find one concise fact.\n[1] https://example.com/aiqsa-search"
    );
    expect(result.providerResponseId).toBe("fake-openrouter-search-1");
    expect(result.artifacts).toEqual([
      {
        data: {
          artifactType: "search",
          payload: {
            model: "perplexity/sonar-pro-search",
            provider: "openrouter",
            strategyId: "perplexity-tool-search",
            text: result.findings
          }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "citation",
          payload: {
            index: 1,
            source: "fake-openrouter-perplexity",
            title: "AIQSA fake search source",
            url: "https://example.com/aiqsa-search"
          }
        },
        type: "artifact"
      }
    ]);
    expect(result.requestPreview).toMatchObject({
      body: {
        model: "perplexity/sonar-pro-search",
        query_characters: 22,
        strategy: "perplexity-tool-search",
        stream: false
      },
      provider: "openrouter",
      redactions: ["search_query"],
      stage: "tool_search"
    });
    expect(JSON.stringify(result.requestPreview)).not.toContain("Find one concise fact.");
    expect(result.usage).toEqual({
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      inputTokens: 6,
      outputTokens: 24,
      reasoningTokens: 0,
      totalTokens: 30
    });
  });
});
