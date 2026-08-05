import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFetchOpenAIResponsesClient,
  createOpenAIResponsesAdapter,
  type OpenAIResponsesClient
} from "./openaiResponses";
import { perplexityWebSearchTool } from "../tools/perplexitySearch";
import type { ProviderRunRequest } from "./types";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";

function isSearchArtifactEvent(
  event: ModelRunSseEvent
): event is Extract<ModelRunSseEvent, { type: "artifact" }> {
  return event.type === "artifact" && event.data.artifactType === "search";
}

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
      nativeSearch: true,
      pdf: true,
      reasoning: true,
      vision: true
    },
    modelId: "gpt-5.5",
    params: {
      maxOutputTokens: 64,
      reasoning: {
        effort: "high",
        summary: "concise"
      }
    },
    prompt: {
      developer: "Prefer verified citations.",
      presetId: "prompt-1",
      system: "You are precise."
    },
    provider: "openai",
    searchStrategy: "openai-native-web-search",
    ...overrides
  };
}

function sseResponse(frames: string[]): Response {
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
        "content-type": "text/event-stream"
      }
    }
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenAI Responses adapter", () => {
  it("composes bounded attachment previews without exposing image or native PDF bytes", () => {
    const base = request();
    const client: OpenAIResponsesClient = {
      cancel: async () => ({}),
      create: async () => ({}),
      retrieve: async () => ({})
    };
    const adapter = createOpenAIResponsesAdapter({ client, maxAttachmentTextChars: 3 });
    const preview = adapter.buildRequestPreview(
      request({
        attachmentIds: ["image-1", "pdf-1", "doc-1"],
        attachments: [
          {
            byteSize: 12,
            dataUrl: "data:image/png;base64,PRIVATE_IMAGE",
            extractedText: null,
            fileName: "chart.png",
            id: "image-1",
            kind: "image",
            metadata: {},
            mimeType: "image/png",
            status: "ready"
          },
          {
            base64Data: "PRIVATE_PDF",
            byteSize: 64,
            extractedText: "native PDF fallback must stay unused",
            fileName: "brief.pdf",
            id: "pdf-1",
            kind: "pdf",
            metadata: {},
            mimeType: "application/pdf",
            status: "ready"
          },
          {
            byteSize: 6,
            extractedText: "abcdef",
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
        },
        searchStrategy: "search-disabled"
      })
    ) as {
      body: { input: Array<{ content: unknown[]; role: string }> };
      provider: string;
      redactions: string[];
    };
    const previewJson = JSON.stringify(preview);

    expect(preview.provider).toBe("openai");
    expect(preview.redactions).toEqual([
      "attachment_extracted_text",
      "attachment_filename",
      "image_data_url",
      "pdf_base64",
      "provider_continuation_opaque_fields"
    ]);
    expect(preview.body.input.at(-1)?.content).toEqual([
      { text: "Find one concise fact.", type: "input_text" },
      { detail: "auto", image_url: "[image data url omitted]", type: "input_image" },
      {
        file_data: "[base64 PDF data omitted]",
        filename: "[attachment filename omitted]",
        type: "input_file"
      },
      {
        text: "[Document attachment text omitted]",
        type: "input_text"
      }
    ]);
    expect(previewJson).not.toContain("PRIVATE_IMAGE");
    expect(previewJson).not.toContain("PRIVATE_PDF");
    expect(previewJson).not.toContain("native PDF fallback must stay unused");
  });

  it("maps retrying, pending, failed, and completed refresh responses through the facade", async () => {
    const responses = [
      new Response(JSON.stringify({ error: { message: "temporary overload" } }), { status: 503 }),
      new Response(JSON.stringify({ id: "resp-refresh", status: "in_progress" }), { status: 200 }),
      new Response(JSON.stringify({ id: "resp-refresh", status: "incomplete" }), { status: 200 }),
      new Response(
        JSON.stringify({
          id: "resp-refresh",
          model: "gpt-5.5",
          output_text: "Recovered answer",
          status: "completed",
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
        }),
        { status: 200 }
      )
    ];
    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      fetchFn: async () => responses.shift() ?? new Response("{}", { status: 200 })
    });
    const adapter = createOpenAIResponsesAdapter({ client });

    const retrying = await adapter.refresh!("resp-refresh");
    expect(retrying).toMatchObject({
      events: [
        {
          data: {
            artifactType: "summary",
            payload: {
              error: { retryable: true, status: 503 },
              provider: "openai",
              responseId: "resp-refresh",
              status: "retrying"
            }
          },
          type: "artifact"
        }
      ],
      providerResponseId: "resp-refresh",
      status: "retrying",
      terminal: false
    });

    const pending = await adapter.refresh!("resp-refresh");
    expect(pending).toEqual({
      events: [
        {
          data: {
            artifactType: "summary",
            payload: { provider: "openai", responseId: "resp-refresh", status: "in_progress" }
          },
          type: "artifact"
        }
      ],
      providerResponseId: "resp-refresh",
      status: "in_progress",
      terminal: false
    });

    const incomplete = await adapter.refresh!("resp-refresh");
    expect(incomplete).toMatchObject({
      error: {
        code: "openai_response_incomplete",
        message: "OpenAI response incomplete"
      },
      providerResponseId: "resp-refresh",
      status: "incomplete",
      terminal: true
    });
    expect(incomplete.events.map((event) => event.type)).toEqual(["artifact"]);

    const completed = await adapter.refresh!("resp-refresh");
    expect(completed.events).toEqual([
      {
        data: {
          artifactType: "summary",
          payload: { provider: "openai", responseId: "resp-refresh", status: "completed" }
        },
        type: "artifact"
      },
      { data: { delta: "Recovered answer" }, type: "token" }
    ]);
    expect(completed).toMatchObject({
      providerResponseId: "resp-refresh",
      result: {
        finalText: "Recovered answer",
        providerResponseId: "resp-refresh",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
      },
      status: "completed",
      terminal: true
    });
  });

  it.each([
    ["missing", { id: "resp-refresh" }, "unknown"],
    ["unknown", { id: "resp-refresh", status: "future_status" }, "unknown"]
  ])("fails closed for %s refresh status", async (_label, payload, status) => {
    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      fetchFn: async () => new Response(JSON.stringify(payload), { status: 200 })
    });
    const adapter = createOpenAIResponsesAdapter({ client });

    const refreshed = await adapter.refresh!("resp-refresh");
    expect(refreshed).toMatchObject({
      error: {
        code: "openai_response_not_completed"
      },
      status,
      terminal: true
    });
    expect(refreshed).not.toHaveProperty("result");
  });

  it("parses OpenAI function calls for the shared tool loop", async () => {
    const client: OpenAIResponsesClient = {
      cancel: async () => ({}),
      create: async () => ({
        id: "resp-tool-1",
        output: [
          {
            id: "rs-1",
            summary: [],
            type: "reasoning"
          },
          {
            arguments: "{\"keyword\":\"latest Anthropic model\"}",
            call_id: "call-search-1",
            id: "fc-1",
            name: "search_via_perplexity",
            status: "completed",
            type: "function_call"
          }
        ],
        status: "completed",
        usage: {
          input_tokens: 20,
          output_tokens: 4
        }
      }),
      retrieve: async () => ({})
    };
    const adapter = createOpenAIResponsesAdapter({ client, pollIntervalMs: 0 });
    const stream = adapter.stream(
      request({
        forceNonStreaming: true,
        searchStrategy: "perplexity-tool-search",
        toolChoice: "auto",
        tools: [perplexityWebSearchTool]
      })
    );
    let next = await stream.next();

    while (!next.done) {
      next = await stream.next();
    }

    expect(next.value.toolCalls).toEqual([
      expect.objectContaining({
        arguments: {
          keyword: "latest Anthropic model"
        },
        id: "call-search-1",
        name: "search_via_perplexity"
      })
    ]);
    expect(next.value.providerToolCallMessage).toEqual([
      expect.objectContaining({
        type: "reasoning"
      }),
      expect.objectContaining({
        call_id: "call-search-1",
        type: "function_call"
      })
    ]);
  });

  it("streams Responses SSE text, web-search lifecycle artifacts, final sources, and usage", async () => {
    const bodies: Record<string, unknown>[] = [];
    const client: OpenAIResponsesClient = {
      cancel: async () => ({}),
      create: async () => {
        throw new Error("json_create_should_not_be_used");
      },
      retrieve: async () => ({}),
      stream: async (body) => {
        bodies.push(body);

        return sseResponse([
          'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-stream-1","model":"gpt-5.5","status":"in_progress"}}\n\n',
          'event: response.web_search_call.in_progress\ndata: {"type":"response.web_search_call.in_progress","response_id":"resp-stream-1","item_id":"ws-1","output_index":0}\n\n',
          'event: response.web_search_call.searching\ndata: {"type":"response.web_search_call.searching","response_id":"resp-stream-1","item_id":"ws-1","output_index":0}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","response_id":"resp-stream-1","delta":"Hel"}\n\n',
          'event: response.web_search_call.completed\ndata: {"type":"response.web_search_call.completed","response_id":"resp-stream-1","item_id":"ws-1","output_index":0}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","response_id":"resp-stream-1","delta":"lo"}\n\n',
          `event: response.completed\ndata: ${JSON.stringify({
            response: {
              id: "resp-stream-1",
              model: "gpt-5.5",
              output: [
                {
                  action: {
                    sources: [
                      {
                        title: "Example",
                        url: "https://example.com"
                      }
                    ],
                    type: "search"
                  },
                  id: "ws-1",
                  status: "completed",
                  type: "web_search_call"
                },
                {
                  content: [
                    {
                      annotations: [
                        {
                          title: "Example",
                          type: "url_citation",
                          url: "https://example.com"
                        }
                      ],
                      text: "Hello",
                      type: "output_text"
                    }
                  ],
                  type: "message"
                }
              ],
              status: "completed",
              usage: {
                input_tokens: 11,
                input_tokens_details: {
                  cached_tokens: 4
                },
                output_tokens: 5,
                output_tokens_details: {
                  reasoning_tokens: 2
                },
                total_tokens: 16
              }
            },
            type: "response.completed"
          })}\n\n`
        ]);
      }
    };
    const adapter = createOpenAIResponsesAdapter({ client });
    const stream = adapter.stream(
      request({
        params: {
          background: true,
          maxOutputTokens: 64,
          reasoning: {
            effort: "medium",
            summary: "auto"
          },
          stream: true
        }
      })
    );
    const events = [];
    let result = null;

    while (true) {
      const next = await stream.next();
      if (next.done) {
        result = next.value;
        break;
      }
      events.push(next.value);
    }

    expect(bodies[0]).toMatchObject({
      background: true,
      stream: true
    });
    expect(events.filter((event) => event.type === "token").map((event) => event.data.delta)).toEqual(["Hel", "lo"]);
    expect(
      events
        .filter(isSearchArtifactEvent)
        .map((event) => event.data.payload)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "in_progress" }),
        expect.objectContaining({ status: "searching" }),
        expect.objectContaining({ status: "completed" })
      ])
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "citation",
          payload: expect.objectContaining({
            url: "https://example.com"
          })
        }),
        type: "artifact"
      })
    );
    expect(result).toMatchObject({
      finalProviderResponsePreview: {
        output: expect.arrayContaining([
          expect.objectContaining({
            action: expect.objectContaining({
              sources: [
                {
                  title: "Example",
                  url: "https://example.com"
                }
              ]
            }),
            type: "web_search_call"
          })
        ])
      },
      finalText: "Hello",
      providerResponseId: "resp-stream-1",
      usage: {
        cachedInputTokens: 4,
        cacheWriteInputTokens: 0,
        inputTokens: 11,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 16
      }
    });
  });

  it("collapses provider error frames from Responses streams", async () => {
    const client: OpenAIResponsesClient = {
      cancel: async () => ({}),
      create: async () => ({}),
      retrieve: async () => ({}),
      stream: async () =>
        sseResponse(['event: error\ndata: {"error":{"message":"Provider overloaded"}}\n\n'])
    };
    const adapter = createOpenAIResponsesAdapter({ client });
    const stream = adapter.stream(
      request({
        params: {
          stream: true
        }
      })
    );

    await expect(stream.next()).rejects.toThrow("openai_stream_error");
  });

  it("aborts Responses stream reads through the run abort signal", async () => {
    const streamControllerRef: { current?: ReadableStreamDefaultController<Uint8Array> } = {};
    const encoder = new TextEncoder();
    const abortController = new AbortController();
    const client: OpenAIResponsesClient = {
      cancel: async () => ({}),
      create: async () => ({}),
      retrieve: async () => ({}),
      stream: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamControllerRef.current = controller;
              controller.enqueue(
                encoder.encode(
                  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-abort","status":"in_progress"}}\n\n'
                )
              );
            }
          }),
          {
            headers: {
              "content-type": "text/event-stream"
            }
          }
        )
    };
    const adapter = createOpenAIResponsesAdapter({ client });
    const stream = adapter.stream(
      request({
        params: {
          stream: true
        }
      }),
      { signal: abortController.signal }
    );

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "artifact"
      }
    });

    abortController.abort();

    await expect(stream.next()).rejects.toThrow(/aborted|provider_run_aborted|sse_stream_aborted/i);
    try {
      streamControllerRef.current?.close();
    } catch {
      // The parser cancels the stream when the abort signal wins.
    }
  });

  it("polls background responses and extracts text, artifacts, response id, and usage", async () => {
    const calls: string[] = [];
    const client: OpenAIResponsesClient = {
      cancel: async () => ({}),
      create: async () => {
        calls.push("create");

        return {
          id: "resp-1",
          status: "queued"
        };
      },
      retrieve: async () => {
        calls.push("retrieve");

        return {
          id: "resp-1",
          output: [
            {
              action: {
                sources: [
                  {
                    title: "Example",
                    url: "https://example.com"
                  }
                ],
                type: "search"
              },
              id: "ws-1",
              status: "completed",
              type: "web_search_call"
            },
            {
              content: [
                {
                  annotations: [
                    {
                      title: "Example",
                      type: "url_citation",
                      url: "https://example.com"
                    }
                  ],
                  text: "OpenAI answer",
                  type: "output_text"
                }
              ],
              type: "message"
            }
          ],
          status: "completed",
          usage: {
            input_tokens: 9,
            output_tokens: 4,
            output_tokens_details: {
              reasoning_tokens: 1
            }
          }
        };
      }
    };
    const adapter = createOpenAIResponsesAdapter({ client, pollIntervalMs: 0 });
    const events = [];
    const stream = adapter.stream(request());
    let next = await stream.next();

    while (!next.done) {
      events.push(next.value);
      next = await stream.next();
    }

    expect(calls).toEqual(["create", "retrieve"]);
    expect(events.map((event) => event.type)).toContain("token");
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "search",
          payload: expect.objectContaining({
            action: expect.objectContaining({
              sources: [
                {
                  title: "Example",
                  url: "https://example.com"
                }
              ],
              type: "search"
            }),
            type: "web_search_call"
          })
        }),
        type: "artifact"
      })
    );
    expect(next.value).toMatchObject({
      finalProviderResponsePreview: {
        output: expect.arrayContaining([
          expect.objectContaining({
            action: expect.objectContaining({
              sources: [
                {
                  title: "Example",
                  url: "https://example.com"
                }
              ]
            }),
            type: "web_search_call"
          })
        ])
      },
      finalText: "OpenAI answer",
      providerResponseId: "resp-1",
      usage: {
        inputTokens: 9,
        outputTokens: 4,
        reasoningTokens: 1
      }
    });
  });

  it("waits longer than one minute for slow OpenAI background responses", async () => {
    let retrieveCalls = 0;
    const client: OpenAIResponsesClient = {
      cancel: async () => ({}),
      create: async () => ({
        id: "resp-slow",
        status: "queued"
      }),
      retrieve: async () => {
        retrieveCalls += 1;

        if (retrieveCalls <= 70) {
          return {
            id: "resp-slow",
            status: "in_progress"
          };
        }

        return {
          id: "resp-slow",
          output: [
            {
              content: [
                {
                  text: "Slow OpenAI answer",
                  type: "output_text"
                }
              ],
              type: "message"
            }
          ],
          status: "completed",
          usage: {
            input_tokens: 8,
            output_tokens: 4
          }
        };
      }
    };
    const adapter = createOpenAIResponsesAdapter({ client, pollIntervalMs: 0 });
    const stream = adapter.stream(request());
    let next = await stream.next();

    while (!next.done) {
      next = await stream.next();
    }

    expect(retrieveCalls).toBe(71);
    expect(next.value).toMatchObject({
      finalText: "Slow OpenAI answer",
      providerResponseId: "resp-slow"
    });
  });

  it("passes the exact background lifecycle timeout through the adapter", async () => {
    vi.useFakeTimers();
    const client: OpenAIResponsesClient = {
      cancel: async () => ({}),
      create: async () => ({
        id: "resp-still-running",
        status: "queued"
      }),
      retrieve: async () => new Promise<Record<string, unknown>>(() => undefined)
    };
    const adapter = createOpenAIResponsesAdapter({ client, pollIntervalMs: 0, pollTimeoutMs: 50 });
    const stream = adapter.stream(request());

    await stream.next();
    const expired = stream.next();
    const expiration = expect(expired).rejects.toThrow("openai_background_response_poll_timeout");
    await vi.advanceTimersByTimeAsync(50);

    await expiration;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps polling after a retryable Responses retrieve 503", async () => {
    const fetchCalls: string[] = [];
    let retrieveCalls = 0;
    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      fetchFn: async (_url, init) => {
        const method = init?.method ?? "GET";
        fetchCalls.push(method);

        if (method === "POST") {
          return new Response(JSON.stringify({ id: "resp-1", status: "queued" }), { status: 200 });
        }

        retrieveCalls += 1;
        if (retrieveCalls === 1) {
          return new Response(JSON.stringify({ error: { message: "temporary OpenAI overload" } }), { status: 503 });
        }

        return new Response(
          JSON.stringify({
            id: "resp-1",
            output: [
              {
                content: [
                  {
                    text: "Recovered OpenAI answer",
                    type: "output_text"
                  }
                ],
                type: "message"
              }
            ],
            status: "completed",
            usage: {
              input_tokens: 4,
              output_tokens: 3
            }
          }),
          { status: 200 }
        );
      }
    });
    const adapter = createOpenAIResponsesAdapter({ client, pollIntervalMs: 0 });
    const events = [];
    const stream = adapter.stream(request());
    let next = await stream.next();

    while (!next.done) {
      events.push(next.value);
      next = await stream.next();
    }

    expect(fetchCalls).toEqual(["POST", "GET", "GET"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "summary",
          payload: expect.objectContaining({
            error: expect.objectContaining({
              retryable: true,
              status: 503
            }),
            status: "retrying"
          })
        }),
        type: "artifact"
      })
    );
    expect(next.value).toMatchObject({
      finalText: "Recovered OpenAI answer",
      providerResponseId: "resp-1",
      usage: {
        inputTokens: 4,
        outputTokens: 3
      }
    });
  });

  it("keeps provider debug templates out of the visible final text", async () => {
    const client: OpenAIResponsesClient = {
      cancel: async () => ({}),
      create: async () => ({
        id: "resp-1",
        output: [
          {
            content: [
              {
                text: [
                  "## Question",
                  "`hi1`",
                  "",
                  "## Answer",
                  "Hi! How can I help you today?",
                  "",
                  "## Provider Parameters",
                  "- Model: hidden"
                ].join("\n"),
                type: "output_text"
              }
            ],
            type: "message"
          }
        ],
        status: "completed",
        usage: {}
      }),
      retrieve: async () => ({})
    };
    const adapter = createOpenAIResponsesAdapter({ client, pollIntervalMs: 0 });
    const stream = adapter.stream(request());
    const tokens = [];
    let next = await stream.next();

    while (!next.done) {
      if (next.value.type === "token") {
        tokens.push(next.value.data.delta);
      }
      next = await stream.next();
    }

    expect(tokens.join("")).toBe("Hi! How can I help you today?");
    expect(next.value.finalText).toBe("Hi! How can I help you today?");
    expect(next.value.finalProviderResponsePreview.rawText).toContain("## Provider Parameters");
  });

  it("fails incomplete OpenAI responses instead of returning an empty successful run", async () => {
    const client: OpenAIResponsesClient = {
      cancel: async () => ({}),
      create: async () => ({
        id: "resp-incomplete",
        status: "incomplete",
        usage: {
          output_tokens: 64,
          output_tokens_details: {
            reasoning_tokens: 64
          }
        }
      }),
      retrieve: async () => ({})
    };
    const adapter = createOpenAIResponsesAdapter({ client, pollIntervalMs: 0 });
    const stream = adapter.stream(request());

    await stream.next();
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: {
        data: expect.objectContaining({ outputTokens: 64, reasoningTokens: 64 }),
        type: "usage"
      }
    });
    await expect(stream.next()).rejects.toThrow("openai_response_incomplete");
  });
});
