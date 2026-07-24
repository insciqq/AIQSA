import { describe, expect, it } from "vitest";
import {
  buildAnthropicMessagesRequest,
  createAnthropicMessagesAdapter,
  createFetchAnthropicMessagesClient,
  type AnthropicMessagesClient,
  type AnthropicStreamEvent
} from "./anthropicMessages";
import type { ProviderRunRequest } from "./types";
import type { RunTool } from "../tools/types";

const mcpTool: RunTool = {
  capability: "mcp",
  description: "Search team memory.",
  inputSchema: {
    properties: {
      query: { type: "string" }
    },
    required: ["query"],
    type: "object"
  },
  name: "mem0__search"
};

function request(overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: {
      blocks: [{ text: "Answer briefly.", type: "text" }]
    },
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: true,
      reasoning: true,
      vision: true
    },
    modelId: "claude-opus-4-8",
    params: {
      maxTokens: 2048,
      temperature: 0.3,
      thinking: {
        budgetTokens: 1024,
        enabled: true,
        type: "adaptive"
      },
      outputConfig: {
        effort: "xhigh"
      }
    },
    prompt: {
      developer: "Use direct language.",
      presetId: "prompt-1",
      system: "You are Claude in AIQSA."
    },
    provider: "anthropic",
    searchStrategy: "search-disabled",
    ...overrides
  };
}

async function* events(values: AnthropicStreamEvent[]): AsyncGenerator<AnthropicStreamEvent> {
  for (const value of values) {
    yield value;
  }
}

function responseBody(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
}

describe("Anthropic Messages adapter", () => {
  const remoteSecret = "sk-aiqsa-remote-error-regression-123456789";

  it("falls back to the official base URL when baseUrl is blank", async () => {
    const urls: string[] = [];
    const client = createFetchAnthropicMessagesClient({
      apiKey: "key",
      baseUrl: "",
      fetchFn: async (url) => {
        urls.push(String(url));

        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            }
          }),
          { status: 200 }
        );
      }
    });
    const stream = client.stream({});

    await stream.next();

    expect(urls).toEqual(["https://api.anthropic.com/v1/messages"]);
  });

  it("drops non-JSON provider error bodies", async () => {
    const client = createFetchAnthropicMessagesClient({
      apiKey: "key",
      fetchFn: async () =>
        new Response(`<html><body>${remoteSecret} Service unavailable</body></html>`, {
          status: 503
        })
    });
    const stream = client.stream({});

    let failure: unknown;
    try {
      await stream.next();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ message: "Anthropic request failed with status 503" });
    expect((failure as Error).message).not.toContain(remoteSecret);
    expect((failure as Error).message).not.toContain("Service unavailable");
  });

  it("bounds non-2xx provider bodies by the request deadline and byte limit", async () => {
    const previousMaxBytes = process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES;
    const previousTimeout = process.env.AIQSA_PROVIDER_TIMEOUT_MS;
    let stalledBodyCancelled = false;
    let oversizedBodyCancelled = false;

    try {
      process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES = "1024";
      process.env.AIQSA_PROVIDER_TIMEOUT_MS = "5";
      const stalledClient = createFetchAnthropicMessagesClient({
        apiKey: "key",
        fetchFn: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                stalledBodyCancelled = true;
              }
            }),
            { status: 503 }
          )
      });

      await expect(stalledClient.stream({}).next()).rejects.toThrow("Provider request timed out");
      expect(stalledBodyCancelled).toBe(true);

      process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES = "4";
      process.env.AIQSA_PROVIDER_TIMEOUT_MS = "100";
      const oversizedClient = createFetchAnthropicMessagesClient({
        apiKey: "key",
        fetchFn: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                oversizedBodyCancelled = true;
              },
              start(controller) {
                controller.enqueue(new TextEncoder().encode("12345"));
              }
            }),
            { status: 503 }
          )
      });

      await expect(oversizedClient.stream({}).next()).rejects.toThrow(
        "Anthropic request failed with status 503"
      );
      expect(oversizedBodyCancelled).toBe(true);
    } finally {
      if (previousMaxBytes === undefined) {
        delete process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES;
      } else {
        process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES = previousMaxBytes;
      }
      if (previousTimeout === undefined) {
        delete process.env.AIQSA_PROVIDER_TIMEOUT_MS;
      } else {
        process.env.AIQSA_PROVIDER_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("generates streaming Messages requests with system, thinking, and attachments", () => {
    const body = buildAnthropicMessagesRequest(
      request({
        attachmentIds: ["pdf-1", "doc-1", "image-1"],
        attachments: [
          {
            byteSize: 32,
            extractedText: "Extracted PDF body",
            fileName: "brief.pdf",
            id: "pdf-1",
            kind: "pdf",
            metadata: {},
            mimeType: "application/pdf",
            status: "ready"
          },
          {
            byteSize: 42,
            extractedText: "alpha,beta\n1,2\n",
            fileName: "rows.csv",
            id: "doc-1",
            kind: "document",
            metadata: {},
            mimeType: "text/csv",
            status: "ready"
          },
          {
            byteSize: 12,
            dataUrl: "data:image/png;base64,AAAA",
            extractedText: null,
            fileName: "chart.png",
            id: "image-1",
            kind: "image",
            metadata: {},
            mimeType: "image/png",
            status: "ready"
          }
        ]
      })
    ) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
      system: string;
      thinking: Record<string, unknown>;
    };

    expect(body).toMatchObject({
      max_tokens: 2048,
      model: "claude-opus-4-8",
      output_config: {
        effort: "xhigh"
      },
      stream: true,
      thinking: {
        type: "adaptive"
      }
    });
    expect(body.system).toContain("You are Claude in AIQSA.");
    expect(body.system).toContain("Use direct language.");
    expect(body.messages[0].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("Extracted PDF body"), type: "text" }),
        expect.objectContaining({
          text: "[Attached document: rows.csv (text/csv)]\nalpha,beta\n1,2\n",
          type: "text"
        }),
        expect.objectContaining({
          source: expect.objectContaining({
            data: "AAAA",
            media_type: "image/png",
            type: "base64"
          }),
          type: "image"
        })
      ])
    );
  });

  it("maps accepted max-output-token aliases to max_tokens", () => {
    for (const alias of ["maxOutputTokens", "maxTokens", "max_output_tokens", "max_tokens"]) {
      const body = buildAnthropicMessagesRequest(
        request({
          params: { [alias]: 1536 }
        })
      );

      expect(body.max_tokens).toBe(1536);
    }
  });

  it("uses native document blocks for PDF attachments when the model supports native PDF input", () => {
    const base = request();
    const runRequest = request({
      attachmentIds: ["pdf-1"],
      attachments: [
        {
          base64Data: "JVBERi0xLjQK",
          byteSize: 64,
          extractedText: "Extracted PDF fallback text",
          fileName: "brief.pdf",
          id: "pdf-1",
          kind: "pdf",
          metadata: {},
          mimeType: "application/pdf",
          status: "ready"
        }
      ],
      modelCapabilities: {
        ...base.modelCapabilities,
        nativePdfInput: true
      }
    });
    const body = buildAnthropicMessagesRequest(runRequest) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const preview = buildAnthropicMessagesRequest(runRequest, { redactFiles: true }) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };

    expect(body.messages[0].content[0]).toEqual({
      source: {
        data: "JVBERi0xLjQK",
        media_type: "application/pdf",
        type: "base64"
      },
      type: "document"
    });
    expect(JSON.stringify(body)).not.toContain("Extracted PDF fallback text");
    expect(JSON.stringify(preview)).toContain("[base64 PDF data omitted]");
    expect(JSON.stringify(preview)).not.toContain("JVBERi0xLjQK");
  });

  it("keeps an adjacent unanswered user turn when rebuilding the latest user content", () => {
    const body = buildAnthropicMessagesRequest(
      request({
        context: {
          messages: [
            {
              content: {
                blocks: [{ text: "Edited but unanswered user turn", type: "text" }]
              },
              id: "user-edited",
              role: "user"
            },
            {
              content: {
                blocks: [{ text: "Answer briefly.", type: "text" }]
              },
              id: "current-user-message",
              role: "user"
            }
          ],
          mode: "branch_path"
        }
      })
    ) as {
      messages: Array<{ content: Array<Record<string, unknown>>; role: string }>;
    };

    expect(body.messages.map((message) => message.role)).toEqual(["user"]);
    expect(JSON.stringify(body.messages[0].content)).toContain("Edited but unanswered user turn");
    expect(JSON.stringify(body.messages[0].content)).toContain("Answer briefly.");
  });

  it("serializes tools and replays Anthropic tool_use/tool_result messages", () => {
    const body = buildAnthropicMessagesRequest(
      request({
        parallelToolCalls: true,
        providerToolMessages: [
          {
            content: [
              {
                id: "toolu-1",
                input: { query: "ADR" },
                name: "mem0__search",
                type: "tool_use"
              }
            ],
            role: "assistant"
          },
          {
            content: [
              {
                content: "First result",
                tool_use_id: "toolu-1",
                type: "tool_result"
              }
            ],
            role: "user"
          },
          {
            content: [
              {
                content: "Second result",
                tool_use_id: "toolu-2",
                type: "tool_result"
              }
            ],
            role: "user"
          }
        ],
        toolChoice: "auto",
        tools: [mcpTool]
      })
    ) as {
      messages: Array<{ content: Array<Record<string, unknown>>; role: string }>;
      tool_choice: Record<string, unknown>;
      tools: Array<Record<string, unknown>>;
    };

    expect(body.tools).toEqual([
      {
        description: "Search team memory.",
        input_schema: mcpTool.inputSchema,
        name: "mem0__search"
      }
    ]);
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.messages.slice(-2)).toEqual([
      {
        content: [
          {
            id: "toolu-1",
            input: { query: "ADR" },
            name: "mem0__search",
            type: "tool_use"
          }
        ],
        role: "assistant"
      },
      {
        content: [
          {
            content: "First result",
            tool_use_id: "toolu-1",
            type: "tool_result"
          },
          {
            content: "Second result",
            tool_use_id: "toolu-2",
            type: "tool_result"
          }
        ],
        role: "user"
      }
    ]);

    const serialBody = buildAnthropicMessagesRequest(request({ tools: [mcpTool] }));
    expect(serialBody.tool_choice).toEqual({
      disable_parallel_tool_use: true,
      type: "auto"
    });
  });

  it("redacts image bytes in request previews", () => {
    const client: AnthropicMessagesClient = {
      stream: () => events([])
    };
    const adapter = createAnthropicMessagesAdapter({ client });
    const preview = adapter.buildRequestPreview(
      request({
        attachmentIds: ["image-1"],
        attachments: [
          {
            byteSize: 12,
            dataUrl: "data:image/png;base64,AAAA",
            extractedText: null,
            fileName: "chart.png",
            id: "image-1",
            kind: "image",
            metadata: {},
            mimeType: "image/png",
            status: "ready"
          }
        ]
      })
    );

    expect(JSON.stringify(preview)).toContain("[base64 image data omitted]");
    expect(JSON.stringify(preview)).not.toContain("AAAA");
  });

  it("maps Anthropic stream text, thinking, usage, and provider id", async () => {
    const client: AnthropicMessagesClient = {
      stream: () =>
        events([
          {
            message: {
              id: "msg-1",
              model: "claude-opus-4-8",
              usage: {
                cache_creation_input_tokens: 3,
                cache_read_input_tokens: 5,
                input_tokens: 12,
                output_tokens: 1
              }
            },
            type: "message_start"
          },
          {
            delta: {
              thinking: "checking",
              type: "thinking_delta"
            },
            type: "content_block_delta"
          },
          {
            delta: {
              text: "Hello",
              type: "text_delta"
            },
            type: "content_block_delta"
          },
          {
            delta: {
              text: "!",
              type: "text_delta"
            },
            type: "content_block_delta"
          },
          {
            delta: {
              stop_reason: "end_turn"
            },
            type: "message_delta",
            usage: {
              output_tokens: 7,
              output_tokens_details: {
                thinking_tokens: 2
              }
            }
          },
          {
            type: "message_stop"
          }
        ])
    };
    const adapter = createAnthropicMessagesAdapter({ client });
    const seen = [];
    const stream = adapter.stream(request());
    let next = await stream.next();

    while (!next.done) {
      seen.push(next.value);
      next = await stream.next();
    }

    expect(seen).toContainEqual(
      expect.objectContaining({
        data: {
          delta: "Hello"
        },
        type: "token"
      })
    );
    expect(seen).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "reasoning"
        }),
        type: "artifact"
      })
    );
    expect(seen.filter((event) => event.type === "usage").at(-1)).toMatchObject({
      data: {
        cachedInputTokens: 5,
        cacheWriteInputTokens: 3,
        inputTokens: 20,
        outputTokens: 7,
        reasoningTokens: 2,
        totalTokens: 27
      },
      type: "usage"
    });
    expect(next.value).toMatchObject({
      finalText: "Hello!",
      providerResponseId: "msg-1",
      usage: {
        cachedInputTokens: 5,
        cacheWriteInputTokens: 3,
        inputTokens: 20,
        outputTokens: 7,
        reasoningTokens: 2,
        totalTokens: 27
      }
    });
  });

  it("assembles multiple streamed tool_use blocks and exposes their continuation message", async () => {
    const client: AnthropicMessagesClient = {
      stream: () =>
        events([
          {
            message: {
              id: "msg-tools",
              model: "claude-opus-4-8",
              usage: { input_tokens: 9 }
            },
            type: "message_start"
          },
          {
            content_block: { text: "", type: "text" },
            index: 0,
            type: "content_block_start"
          },
          {
            delta: { text: "I will check.", type: "text_delta" },
            index: 0,
            type: "content_block_delta"
          },
          { index: 0, type: "content_block_stop" },
          {
            content_block: {
              id: "toolu-mem0",
              input: {},
              name: "mem0__search",
              type: "tool_use"
            },
            index: 1,
            type: "content_block_start"
          },
          {
            delta: { partial_json: '{"query":"A', type: "input_json_delta" },
            index: 1,
            type: "content_block_delta"
          },
          {
            delta: { partial_json: 'DR"}', type: "input_json_delta" },
            index: 1,
            type: "content_block_delta"
          },
          { index: 1, type: "content_block_stop" },
          {
            content_block: {
              id: "toolu-notion",
              input: {},
              name: "notion__fetch",
              type: "tool_use"
            },
            index: 2,
            type: "content_block_start"
          },
          {
            delta: { partial_json: '{"page":42}', type: "input_json_delta" },
            index: 2,
            type: "content_block_delta"
          },
          { index: 2, type: "content_block_stop" },
          {
            delta: { stop_reason: "tool_use" },
            type: "message_delta",
            usage: { output_tokens: 12 }
          },
          { type: "message_stop" }
        ])
    };
    const normalized = await (async () => {
      const stream = createAnthropicMessagesAdapter({ client }).stream(
        request({ tools: [mcpTool] })
      );
      const seen = [];
      let next = await stream.next();
      while (!next.done) {
        seen.push(next.value);
        next = await stream.next();
      }
      return { events: seen, result: next.value };
    })();

    expect(normalized.events).toContainEqual({
      data: { delta: "I will check." },
      type: "token"
    });
    expect(normalized.result.toolCalls).toMatchObject([
      {
        arguments: { query: "ADR" },
        id: "toolu-mem0",
        name: "mem0__search"
      },
      {
        arguments: { page: 42 },
        id: "toolu-notion",
        name: "notion__fetch"
      }
    ]);
    expect(normalized.result.providerToolCallMessage).toMatchObject({
      content: [
        { text: "I will check.", type: "text" },
        { id: "toolu-mem0", input: { query: "ADR" }, type: "tool_use" },
        { id: "toolu-notion", input: { page: 42 }, type: "tool_use" }
      ],
      role: "assistant"
    });
  });

  it("rejects partial and empty EOF while preserving explicit stream errors", async () => {
    const partialAdapter = createAnthropicMessagesAdapter({
      client: {
        stream: () =>
          events([
            {
              message: { id: "msg-partial", model: "claude-opus-4-8", usage: { input_tokens: 2 } },
              type: "message_start"
            },
            {
              delta: { text: "Partial", type: "text_delta" },
              type: "content_block_delta"
            },
            {
              delta: { stop_reason: "end_turn" },
              type: "message_delta",
              usage: { output_tokens: 1 }
            }
          ])
      }
    });
    const partial = partialAdapter.stream(request());

    await expect(partial.next()).resolves.toMatchObject({ done: false });
    await expect(partial.next()).resolves.toMatchObject({ done: false });
    await expect(partial.next()).resolves.toMatchObject({
      done: false,
      value: {
        data: expect.objectContaining({ inputTokens: 2 }),
        type: "usage"
      }
    });
    await expect(partial.next()).resolves.toEqual({
      done: false,
      value: { data: { delta: "Partial" }, type: "token" }
    });
    await expect(partial.next()).resolves.toMatchObject({
      done: false,
      value: {
        data: expect.objectContaining({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
        type: "usage"
      }
    });
    await expect(partial.next()).rejects.toThrow("anthropic_stream_truncated");

    const empty = createAnthropicMessagesAdapter({ client: { stream: () => events([]) } }).stream(request());
    await expect(empty.next()).resolves.toMatchObject({ done: false });
    await expect(empty.next()).rejects.toThrow("anthropic_stream_truncated");

    const stopOnly = createAnthropicMessagesAdapter({
      client: { stream: () => events([{ type: "message_stop" }]) }
    }).stream(request());
    await expect(stopOnly.next()).resolves.toMatchObject({ done: false });
    await expect(stopOnly.next()).rejects.toThrow("anthropic_stream_truncated");

    const explicitError = createAnthropicMessagesAdapter({
      client: {
        stream: () => events([{ error: { message: remoteSecret }, type: "error" }])
      }
    }).stream(request());
    await expect(explicitError.next()).resolves.toMatchObject({ done: false });
    let failure: unknown;
    try {
      await explicitError.next();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ message: "anthropic_stream_error" });
    expect((failure as Error).message).not.toContain(remoteSecret);
  });

  it("accepts message_stop split across transport chunks", async () => {
    const client = createFetchAnthropicMessagesClient({
      apiKey: "key",
      fetchFn: async () =>
        new Response(
          responseBody([
            'data: {"type":"message_start","message":{"id":"msg-split","model":"claude-opus-4-8"}}\n\n',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Split terminal"}}\n\n',
            'data: {"type":"message_st',
            'op"}\n\n'
          ]),
          { status: 200 }
        )
    });
    const stream = createAnthropicMessagesAdapter({ client }).stream(request());
    const seen = [];
    let next = await stream.next();

    while (!next.done) {
      seen.push(next.value);
      next = await stream.next();
    }

    expect(seen).toContainEqual({ data: { delta: "Split terminal" }, type: "token" });
    expect(next.value).toMatchObject({ finalText: "Split terminal", providerResponseId: "msg-split" });

    const truncatedClient = createFetchAnthropicMessagesClient({
      apiKey: "key",
      fetchFn: async () => new Response(responseBody(['data: {"type":"message_st']), { status: 200 })
    });
    await expect(truncatedClient.stream({}).next()).rejects.toThrow("anthropic_stream_truncated");
  });
});
