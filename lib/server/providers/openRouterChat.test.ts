import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { describe, expect, it, vi } from "vitest";
import { perplexityWebSearchTool } from "../tools/perplexitySearch";
import { validateSearchToolArguments } from "../search/query";
import * as openRouterFacade from "./openRouterChat";
import {
  buildOpenRouterChatRequest,
  buildOpenRouterPerplexitySearchRequest,
  createFetchOpenRouterChatClient,
  createFakeOpenRouterPerplexitySearchAdapter,
  createOpenRouterChatAdapter,
  createOpenRouterPerplexitySearchAdapter,
  type OpenRouterAdapterOptions,
  type OpenRouterChatClient
} from "./openRouterChat";
import type {
  ProviderRunRequest,
  ProviderRunResult,
  ProviderSearchRequest
} from "./types";

function request(overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
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
    modelId: "anthropic/claude-opus-4.8",
    params: {
      max_output_tokens: 64,
      provider: {
        allowFallbacks: false,
        dataCollection: "deny",
        order: ["anthropic"],
        only: ["Anthropic"],
        requireParameters: true,
        sort: "latency",
        zdr: true
      },
      reasoning: {
        enabled: true,
        effort: "high",
        maxTokens: 32
      },
      temperature: 0
    },
    prompt: {
      developer: "Prefer citations.",
      presetId: "prompt-1",
      system: "You are precise."
    },
    provider: "openrouter",
    searchStrategy: "perplexity-tool-search",
    ...overrides
  };
}

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

function sseResponse(frames: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      }
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        ...headers
      }
    }
  );
}

async function collect(
  stream: AsyncGenerator<ModelRunSseEvent, ProviderRunResult>
): Promise<{ events: ModelRunSseEvent[]; result: ProviderRunResult }> {
  const events: ModelRunSseEvent[] = [];

  while (true) {
    const next = await stream.next();
    if (next.done) {
      return { events, result: next.value };
    }

    events.push(next.value);
  }
}

function jsonAnswer(text = "JSON answer"): Record<string, unknown> {
  return {
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: text,
          role: "assistant"
        }
      }
    ],
    id: "or-json-1",
    model: "anthropic/claude-opus-4.8",
    object: "chat.completion",
    usage: {
      completion_tokens: 3,
      prompt_tokens: 8
    }
  };
}

describe("OpenRouter Chat facade", () => {
  it("keeps every pre-split public facade export available", () => {
    const client: OpenRouterChatClient = {
      createChatCompletion: async () => jsonAnswer()
    };
    const options: OpenRouterAdapterOptions = { client };

    for (const value of [
      buildOpenRouterChatRequest,
      buildOpenRouterPerplexitySearchRequest,
      createFetchOpenRouterChatClient,
      createFakeOpenRouterPerplexitySearchAdapter,
      createOpenRouterChatAdapter,
      createOpenRouterPerplexitySearchAdapter
    ]) {
      expect(value).toBeTypeOf("function");
    }
    expect(openRouterFacade).not.toHaveProperty("buildOpenRouterChatRequestPreview");
    expect(openRouterFacade).not.toHaveProperty("buildOpenRouterPerplexitySearchRequestPreview");
    expect(options.client).toBe(client);
  });

  it("delegates a safe preview and falls back to JSON without a streaming client", async () => {
    const createChatCompletion = vi.fn<OpenRouterChatClient["createChatCompletion"]>(async () =>
      jsonAnswer()
    );
    const adapter = createOpenRouterChatAdapter({
      client: { createChatCompletion },
      maxAttachmentTextChars: 5
    });
    const base = request();
    const runRequest = request({
      attachmentIds: ["pdf-1", "image-1", "doc-1"],
      attachments: [
        {
          base64Data: "PRIVATE_PDF_BYTES",
          byteSize: 64,
          extractedText: "PDF fallback must not be sent",
          fileName: "brief.pdf",
          id: "pdf-1",
          kind: "pdf",
          metadata: {},
          mimeType: "application/pdf",
          status: "ready"
        },
        {
          byteSize: 32,
          dataUrl: "data:image/png;base64,PRIVATE_IMAGE_BYTES",
          extractedText: null,
          fileName: "chart.png",
          id: "image-1",
          kind: "image",
          metadata: {},
          mimeType: "image/png",
          status: "ready"
        },
        {
          byteSize: 10,
          extractedText: "0123456789",
          fileName: "notes.txt",
          id: "doc-1",
          kind: "document",
          metadata: {},
          mimeType: "text/plain",
          status: "ready"
        }
      ],
      modelCapabilities: {
        ...base.modelCapabilities,
        nativePdfInput: true
      }
    });
    const preview = adapter.buildRequestPreview(runRequest);
    const previewJson = JSON.stringify(preview);

    expect(preview).toMatchObject({
      body: {
        plugins: [{ id: "file-parser", pdf: { engine: "native" } }],
        stream: true
      },
      provider: "openrouter",
      redactions: ["image_data_url", "pdf_base64"]
    });
    expect(previewJson).toContain("01234\\n[truncated 5 chars]");
    expect(previewJson).toContain("[base64 PDF data omitted]");
    expect(previewJson).toContain("[image data url omitted]");
    expect(previewJson).not.toContain("PRIVATE_PDF_BYTES");
    expect(previewJson).not.toContain("PRIVATE_IMAGE_BYTES");
    expect(previewJson).not.toContain("PDF fallback must not be sent");

    const controller = new AbortController();
    const collected = await collect(adapter.stream(runRequest, { signal: controller.signal }));

    expect(createChatCompletion).toHaveBeenCalledOnce();
    const [body, options] = createChatCompletion.mock.calls[0] ?? [];
    const bodyJson = JSON.stringify(body);
    expect(body).toMatchObject({
      plugins: [{ id: "file-parser", pdf: { engine: "native" } }],
      stream: true
    });
    expect(bodyJson).toContain("PRIVATE_PDF_BYTES");
    expect(bodyJson).toContain("PRIVATE_IMAGE_BYTES");
    expect(bodyJson).toContain("01234\\n[truncated 5 chars]");
    expect(bodyJson).not.toContain("PDF fallback must not be sent");
    expect(options?.signal).toBe(controller.signal);
    expect(collected.events.at(-1)).toEqual({
      data: { delta: "JSON answer" },
      type: "token"
    });
    expect(collected.result).toMatchObject({
      finalText: "JSON answer",
      providerResponseId: "or-json-1",
      usage: {
        inputTokens: 8,
        outputTokens: 3,
        reasoningTokens: 0
      }
    });
  });

  it("routes streaming requests through the SSE client and returns normalized events", async () => {
    const createChatCompletion = vi.fn<OpenRouterChatClient["createChatCompletion"]>(async () =>
      jsonAnswer("unexpected")
    );
    const streamChatCompletion = vi.fn<NonNullable<OpenRouterChatClient["streamChatCompletion"]>>(
      async () =>
        sseResponse(
          [
            'data: {"id":"or-stream-1","model":"anthropic/claude-opus-4.8","choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
            'data: {"id":"or-stream-1","model":"anthropic/claude-opus-4.8","choices":[{"delta":{"content":"lo","reasoning":"checked","annotations":[{"title":"Source","url":"https://example.com/source"}]},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"completion_tokens_details":{"reasoning_tokens":1},"total_tokens":10}}\n\n',
            "data: [DONE]\n\n"
          ],
          { "x-generation-id": "or-stream-1" }
        )
    );
    const adapter = createOpenRouterChatAdapter({
      client: { createChatCompletion, streamChatCompletion }
    });
    const controller = new AbortController();

    const collected = await collect(adapter.stream(request(), { signal: controller.signal }));

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(streamChatCompletion).toHaveBeenCalledOnce();
    const [body, options] = streamChatCompletion.mock.calls[0] ?? [];
    expect(body).toMatchObject({ model: "anthropic/claude-opus-4.8", stream: true });
    expect(options?.signal).toBe(controller.signal);
    expect(
      collected.events.filter((event) => event.type === "token").map((event) => event.data.delta)
    ).toEqual(["Hel", "lo"]);
    expect(collected.events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "citation",
          payload: expect.objectContaining({ url: "https://example.com/source" })
        }),
        type: "artifact"
      })
    );
    expect(collected.result).toMatchObject({
      finalText: "Hello",
      providerResponseId: "or-stream-1",
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        reasoningTokens: 1,
        totalTokens: 10
      }
    });
  });

  it("composes provider-neutral tools into the streaming continuation boundary", async () => {
    const createChatCompletion = vi.fn<OpenRouterChatClient["createChatCompletion"]>();
    const streamChatCompletion = vi.fn<NonNullable<OpenRouterChatClient["streamChatCompletion"]>>(
      async () =>
        sseResponse([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"keyword":"latest ',
                        name: "search_via_perplexity"
                      },
                      id: "call-1",
                      index: 0,
                      type: "function"
                    }
                  ]
                },
                finish_reason: null
              }
            ],
            id: "or-tool-1",
            model: "anthropic/claude-opus-4.8"
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: { arguments: 'Anthropic model"}' },
                      index: 0
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            id: "or-tool-1",
            usage: {}
          })}\n\n`,
          "data: [DONE]\n\n"
        ])
    );
    const adapter = createOpenRouterChatAdapter({
      client: { createChatCompletion, streamChatCompletion }
    });

    const collected = await collect(
      adapter.stream(
        request({
          parallelToolCalls: true,
          toolChoice: "auto",
          tools: [perplexityWebSearchTool]
        })
      )
    );

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(streamChatCompletion).toHaveBeenCalledOnce();
    expect(streamChatCompletion.mock.calls[0]?.[0]).toMatchObject({
      parallel_tool_calls: true,
      stream: true,
      tool_choice: "auto",
      tools: [
        {
          function: { name: "search_via_perplexity" },
          type: "function"
        }
      ]
    });
    expect(collected.result).toMatchObject({
      finalText: "",
      providerResponseId: "or-tool-1",
      providerToolCallMessage: expect.objectContaining({ role: "assistant" }),
      toolCalls: [
        expect.objectContaining({
          arguments: { keyword: "latest Anthropic model" },
          id: "call-1",
          name: "search_via_perplexity"
        })
      ]
    });
  });

  it("collapses provider error envelopes across the facade", async () => {
    const client: OpenRouterChatClient = {
      createChatCompletion: async () => ({
        error: {
          code: "provider_error",
          message: "No endpoints found"
        }
      })
    };
    const adapter = createOpenRouterChatAdapter({ client });

    await expect(adapter.stream(request()).next()).rejects.toThrow("openrouter_response_error");
  });

  it.each([
    ["empty body", {}],
    ["empty choices", { choices: [] }],
    ["missing message", { choices: [{ finish_reason: "stop" }] }]
  ])("fails closed on malformed non-streaming facade JSON: %s", async (_label, response) => {
    const adapter = createOpenRouterChatAdapter({
      client: {
        createChatCompletion: async () => response
      }
    });

    await expect(
      adapter.stream(request({ params: { ...request().params, stream: false } })).next()
    ).rejects.toThrow("openrouter_terminal_response_invalid");
  });

  it("fails closed when the transport normalizes an empty HTTP-200 body", async () => {
    const client = createFetchOpenRouterChatClient({
      apiKey: "test-key",
      fetchFn: async () => new Response("", { status: 200 })
    });
    const adapter = createOpenRouterChatAdapter({ client });

    await expect(
      adapter.stream(request({ params: { ...request().params, stream: false } })).next()
    ).rejects.toThrow("openrouter_terminal_response_invalid");
  });

  it("keeps the real and fake Perplexity search adapters wired through the public facade", async () => {
    const createChatCompletion = vi.fn<OpenRouterChatClient["createChatCompletion"]>(async () => ({
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
      usage: {
        completion_tokens: 5,
        prompt_tokens: 11
      }
    }));
    const real = createOpenRouterPerplexitySearchAdapter({
      client: { createChatCompletion }
    });
    const controller = new AbortController();
    const search = searchRequest();

    expect(real.buildRequestPreview(search)).toMatchObject({
      body: { model: "perplexity/sonar-pro-search", stream: false },
      provider: "openrouter",
      stage: "tool_search"
    });
    const realResult = await real.search(search, { signal: controller.signal });
    const [body, options] = createChatCompletion.mock.calls[0] ?? [];
    expect(body).toMatchObject({
      max_completion_tokens: 1024,
      metadata: { stage: "tool_search", strategy: "perplexity-tool-search" },
      model: "perplexity/sonar-pro-search",
      stream: false
    });
    expect(options?.signal).toBe(controller.signal);
    expect(realResult).toMatchObject({
      findings: "Search answer [1]",
      providerResponseId: "or-search-1",
      sources: [{ url: "https://example.com/source" }],
      usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 }
    });
    expect(realResult.artifacts).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "citation",
          payload: expect.objectContaining({ url: "https://example.com/source" })
        }),
        type: "artifact"
      })
    );

    const fake = createFakeOpenRouterPerplexitySearchAdapter();
    const fakeResult = await fake.search(search);

    expect(fakeResult).toMatchObject({
      findings: expect.stringContaining("Fake Perplexity search findings"),
      providerResponseId: "fake-openrouter-search-1"
    });
    expect(
      fakeResult.artifacts
        .filter((artifact) => artifact.type === "artifact")
        .map((artifact) => artifact.data.artifactType)
    ).toEqual(["search", "citation"]);
  });
});
