import { describe, expect, it, vi } from "vitest";
import type { ProviderSearchRequest } from "./types";
import type { OpenRouterChatClient } from "./openRouterChatTransport";
import {
  createFakeOpenRouterPerplexitySearchAdapter,
  createOpenRouterPerplexitySearchAdapter
} from "./openRouterPerplexitySearch";

function searchRequest(overrides: Partial<ProviderSearchRequest> = {}): ProviderSearchRequest {
  return {
    answerModelId: "anthropic/claude-opus-4.8",
    answerProvider: "openrouter",
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: {
      blocks: [{ text: "Find one concise fact.", type: "text" }]
    },
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: true,
      reasoning: true,
      vision: true
    },
    modelId: "perplexity/sonar-pro-search",
    params: {
      max_output_tokens: 1024,
      provider: {
        allowFallbacks: true,
        dataCollection: "deny",
        order: ["perplexity"],
        requireParameters: false,
        sort: "throughput"
      },
      reasoning: {
        exclude: true
      },
      temperature: 0
    },
    prompt: {
      developer: "Prefer citations.",
      presetId: "prompt-1",
      system: "You are precise."
    },
    provider: "openrouter",
    searchModelId: "perplexity/sonar-pro-search",
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
    searchStrategy: "perplexity-tool-search",
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
    const longText = `${"x".repeat(12000)}TAIL`;
    const adapter = createOpenRouterPerplexitySearchAdapter({
      client: { createChatCompletion },
      maxAttachmentTextChars: 3
    });
    const request = searchRequest({
      attachmentIds: ["doc-1", "image-1"],
      attachments: [
        {
          byteSize: longText.length,
          extractedText: longText,
          fileName: "research.txt",
          id: "doc-1",
          kind: "document",
          metadata: {},
          mimeType: "text/plain",
          status: "ready"
        },
        {
          byteSize: 20,
          dataUrl: "data:image/png;base64,PRIVATE_SEARCH_IMAGE",
          extractedText: null,
          fileName: "ignored.png",
          id: "image-1",
          kind: "image",
          metadata: {},
          mimeType: "image/png",
          status: "ready"
        }
      ]
    });

    const result = await adapter.search(request);

    expect(createChatCompletion).toHaveBeenCalledOnce();
    const body = createChatCompletion.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      max_completion_tokens: 1024,
      metadata: {
        answer_model: "anthropic/claude-opus-4.8",
        answer_provider: "openrouter",
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
    expect(JSON.stringify(body)).toContain(`${"x".repeat(12000)}\\n[truncated 4 chars]`);
    expect(JSON.stringify(body)).not.toContain("TAIL");
    expect(JSON.stringify(body)).not.toContain("PRIVATE_SEARCH_IMAGE");
    expect(result).toMatchObject({
      finalProviderResponsePreview: {
        citations: [
          {
            snippet: "A useful source",
            title: "Primary source",
            url: "https://example.com/source"
          }
        ],
        id: "or-search-1",
        model: "perplexity/sonar-pro-search",
        provider: "openrouter",
        text: "Search answer [1]"
      },
      finalText: "Search answer [1]",
      providerResponseId: "or-search-1",
      requestPreview: {
        body: {
          model: "perplexity/sonar-pro-search",
          stream: false
        },
        provider: "openrouter",
        redactions: ["image_data_url"],
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

  it("forwards the exact abort signal to the transport client", async () => {
    const controller = new AbortController();
    const createChatCompletion = vi.fn<OpenRouterChatClient["createChatCompletion"]>(async () =>
      successfulResponse()
    );
    const adapter = createOpenRouterPerplexitySearchAdapter({
      client: { createChatCompletion }
    });

    await adapter.search(searchRequest(), { signal: controller.signal });

    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.any(Object),
      { signal: controller.signal }
    );
  });

  it("omits hostile citations from artifacts while retaining the provider preview", async () => {
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
    expect(result.finalProviderResponsePreview.citations).toEqual([
      "javascript:alert(1)",
      "https://example.com/safe",
      { href: "data:text/html,hostile", title: "Unsafe object" }
    ]);
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
      finalText: "Search answer"
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
      finalText: "Successful answer",
      providerResponseId: "or-search-1"
    });
  });

  it("preserves deterministic fake result, artifacts, usage, and request preview", async () => {
    const adapter = createFakeOpenRouterPerplexitySearchAdapter();

    const result = await adapter.search(searchRequest());

    expect(result.finalText).toBe(
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
            text: result.finalText
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
        stream: false
      },
      provider: "openrouter",
      stage: "tool_search"
    });
    expect(result.requestPreview).not.toHaveProperty("redactions");
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
