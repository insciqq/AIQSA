import { describe, expect, it } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ProviderRunResult } from "./types";
import {
  buildOpenRouterResponsePreview,
  extractOpenRouterArtifacts,
  extractOpenRouterText,
  extractOpenRouterUsage,
  openRouterProviderResponseId,
  openRouterResponseError,
  streamOpenRouterJsonResponse,
  streamOpenRouterSseResponse,
  type OpenRouterResponseContext,
  type OpenRouterResponseRecord
} from "./openRouterChatResponse";

const responseContext: OpenRouterResponseContext = {
  modelId: "anthropic/claude-opus-4.8"
};

function responseBody(frames: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    }
  });
}

function sseResponse(frames: readonly string[], headers: Record<string, string> = {}): Response {
  return new Response(responseBody(frames), { headers });
}

async function collect(
  stream: AsyncGenerator<ModelRunSseEvent, ProviderRunResult>
): Promise<{ events: ModelRunSseEvent[]; result: ProviderRunResult }> {
  const events: ModelRunSseEvent[] = [];
  let next = await stream.next();

  while (!next.done) {
    events.push(next.value);
    next = await stream.next();
  }

  return {
    events,
    result: next.value
  };
}

describe("OpenRouter Chat response normalization", () => {
  const remoteSecret = "sk-aiqsa-remote-error-regression-123456789";

  it("extracts first-choice text, provider id, usage aliases, and response preview fields", () => {
    const response = {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: [{ text: "Hel", type: "text" }, { ignored: true }, { text: "lo", type: "text" }]
          }
        },
        {
          message: {
            content: "ignored second choice"
          }
        }
      ],
      id: "or-json-1",
      model: "anthropic/claude-opus-4.8",
      object: "chat.completion",
      usage: {
        input_tokens: 11,
        input_tokens_details: {
          cache_write_tokens: 3,
          cached_tokens: 4
        },
        output_tokens: 5,
        output_tokens_details: {
          reasoning_tokens: 2
        }
      }
    };

    expect(extractOpenRouterText(response)).toBe("Hello");
    expect(openRouterProviderResponseId(response)).toBe("or-json-1");
    expect(openRouterProviderResponseId({ id: 42 })).toBeUndefined();
    expect(extractOpenRouterUsage(response)).toEqual({
      cachedInputTokens: 4,
      cacheWriteInputTokens: 3,
      inputTokens: 11,
      outputTokens: 5,
      reasoningTokens: 2,
      totalTokens: 16
    });
    expect(buildOpenRouterResponsePreview(response, "Hello")).toEqual({
      citations: undefined,
      finishReason: "stop",
      id: "or-json-1",
      model: "anthropic/claude-opus-4.8",
      object: "chat.completion",
      provider: "openrouter",
      rawText: undefined,
      text: "Hello",
      usage: response.usage
    });
  });

  it("prefers legacy token fields and falls back to normalized zero usage", () => {
    expect(
      extractOpenRouterUsage({
        usage: {
          cache_creation_input_tokens: 2,
          completion_tokens: 7,
          completion_tokens_details: {
            reasoning_tokens: 3
          },
          input_tokens: 99,
          output_tokens: 99,
          prompt_tokens: 13,
          prompt_tokens_details: {
            cached_tokens: 5
          },
          total_tokens: 20
        }
      })
    ).toEqual({
      cachedInputTokens: 5,
      cacheWriteInputTokens: 2,
      inputTokens: 13,
      outputTokens: 7,
      reasoningTokens: 3,
      totalTokens: 20
    });
    expect(extractOpenRouterUsage({ usage: { completion_tokens: -2, prompt_tokens: Number.NaN } })).toEqual({
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0
    });
  });

  it("normalizes JSON summary, reasoning, safe deduplicated citations, visible text, and tool continuation", async () => {
    const rawText = [
      "## Question",
      "Hidden question",
      "",
      "## Answer",
      "Visible answer",
      "",
      "## Provider Parameters",
      "- hidden: true"
    ].join("\n");
    const response = {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            annotations: [
              { title: "Annotation", url: " https://example.com/annotation " },
              { title: "Unsafe annotation", url: "data:text/html,bad" }
            ],
            content: rawText,
            reasoning: "Checked the sources.",
            role: "assistant",
            tool_calls: [
              {
                function: {
                  arguments: "{\"keyword\":\"latest model\"}",
                  name: "search_via_perplexity"
                },
                id: "call-1"
              }
            ]
          }
        }
      ],
      citations: [
        "https://example.com/source",
        "https://example.com/source",
        "javascript:alert(1)"
      ],
      id: "or-json-tool",
      model: "anthropic/claude-opus-4.8",
      object: "chat.completion",
      usage: {}
    };
    const normalized = await collect(streamOpenRouterJsonResponse(response, responseContext));

    expect(normalized.events.map((event) => event.type)).toEqual([
      "artifact",
      "artifact",
      "artifact",
      "artifact",
      "token"
    ]);
    expect(
      normalized.events.flatMap((event) =>
        event.type === "artifact" && event.data.artifactType === "citation" ? [event.data.payload] : []
      )
    ).toEqual([
      {
        index: 1,
        source: "openrouter",
        title: "Source 1",
        url: "https://example.com/source"
      },
      {
        index: 1,
        snippet: undefined,
        source: "openrouter-annotations",
        title: "Annotation",
        url: "https://example.com/annotation"
      }
    ]);
    expect(JSON.stringify(normalized.events)).not.toContain("javascript:");
    expect(JSON.stringify(normalized.events)).not.toContain("data:text/html");
    expect(normalized.events.at(-1)).toEqual({
      data: { delta: "Visible answer" },
      type: "token"
    });
    expect(normalized.result).toMatchObject({
      finalProviderResponsePreview: {
        id: "or-json-tool",
        rawText,
        text: "Visible answer"
      },
      finalText: "Visible answer",
      providerResponseId: "or-json-tool",
      providerToolCallMessage: expect.objectContaining({ role: "assistant" }),
      toolCalls: [
        expect.objectContaining({
          arguments: { keyword: "latest model" },
          id: "call-1",
          name: "search_via_perplexity"
        })
      ]
    });
  });

  it("extracts artifacts directly without emitting unsafe or repeated citation URLs", () => {
    const artifacts = extractOpenRouterArtifacts({
      choices: [
        {
          message: {
            citations: [
              { href: "https://example.com/message", title: "Message" },
              { href: "https://example.com/message", title: "Repeated" },
              { href: "file:///etc/passwd", title: "Unsafe" }
            ],
            reasoning_details: [{ text: "Reasoning detail" }]
          }
        }
      ]
    });

    expect(artifacts).toEqual([
      {
        data: {
          artifactType: "reasoning",
          payload: {
            reasoning: [{ text: "Reasoning detail" }]
          }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "citation",
          payload: {
            index: 1,
            snippet: undefined,
            source: "openrouter-message",
            title: "Message",
            url: "https://example.com/message"
          }
        },
        type: "artifact"
      }
    ]);
  });

  it("normalizes the current nested url_citation annotation shape without traversing hostile nesting", () => {
    const artifacts = extractOpenRouterArtifacts({
      choices: [{
        message: {
          annotations: [{
            type: "url_citation",
            url_citation: {
              content: "Bounded source excerpt",
              title: "Nested source",
              url: "https://example.com/nested"
            }
          }, {
            type: "url_citation",
            url: "https://example.com/malformed-flat-fallback",
            url_citation: { nested: { url: "https://example.com/hidden" } }
          }, {
            type: "url_citation",
            url_citation: {
              title: "Credential-bearing",
              url: "https://user:PRIVATE_PASSWORD@example.com/private"
            }
          }, {
            type: "unknown",
            url: "https://example.com/unknown-flat",
            url_citation: { url: "https://example.com/unknown" }
          }]
        }
      }]
    });

    expect(artifacts).toEqual([{
      data: {
        artifactType: "citation",
        payload: {
          index: 1,
          snippet: "Bounded source excerpt",
          source: "openrouter-annotations",
          title: "Nested source",
          url: "https://example.com/nested"
        }
      },
      type: "artifact"
    }]);
    expect(JSON.stringify(artifacts)).not.toMatch(/PRIVATE_PASSWORD|hidden|unknown/u);
  });

  it.each([
    {
      response: { error: { code: "top_code", message: remoteSecret } }
    },
    {
      response: { choices: [{ error: { code: "choice_code" } }] }
    },
    {
      response: { choices: [{ message: { error: {} } }] }
    }
  ] satisfies readonly { response: OpenRouterResponseRecord }[])(
    "collapses a successful HTTP response error at every supported location",
    async ({ response }) => {
      expect(openRouterResponseError(response)).toBe("openrouter_response_error");
      const stream = streamOpenRouterJsonResponse(response, responseContext);
      let failure: unknown;
      try {
        await stream.next();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ message: "openrouter_response_error" });
      expect((failure as Error).message).not.toContain(remoteSecret);
    }
  );

  it.each([
    ["empty object", {}],
    ["empty choices", { choices: [] }],
    ["non-record first choice", { choices: [null] }],
    ["choice without message", { choices: [{ finish_reason: "stop" }] }],
    ["message without usable content", { choices: [{ message: {} }] }],
    ["blank text", { choices: [{ message: { content: "   " } }] }],
    [
      "text sanitized to an empty visible answer",
      {
        choices: [
          {
            message: {
              content: "## Answer\n\n## Usage\n- tokens: 1"
            }
          }
        ]
      }
    ],
    [
      "malformed tool-only message",
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ function: { name: "search_via_perplexity" } }]
            }
          }
        ]
      }
    ]
  ])("rejects malformed non-streaming terminal JSON: %s", async (_label, response) => {
    const stream = streamOpenRouterJsonResponse(response, responseContext);
    await expect(stream.next()).rejects.toThrow(
      "openrouter_terminal_response_invalid"
    );
  });

  it("accepts a non-streaming content array with usable text", async () => {
    const normalized = await collect(
      streamOpenRouterJsonResponse(
        {
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: [
                  { type: "text", text: "Array " },
                  { type: "text", text: "answer" }
                ],
                role: "assistant"
              }
            }
          ],
          id: "or-array-1"
        },
        responseContext
      )
    );

    expect(normalized.result.finalText).toBe("Array answer");
    expect(normalized.events).toContainEqual({
      data: { delta: "Array answer" },
      type: "token"
    });
  });

  it("streams summary and tokens before aggregated reasoning and safe citations", async () => {
    const normalized = await collect(
      streamOpenRouterSseResponse(
        sseResponse(
          [
            "data: 42\n\n",
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    content: [{ text: "Hel", type: "text" }],
                    reasoning: "think "
                  },
                  finish_reason: null
                }
              ],
              citations: [
                "https://example.com/stream",
                "https://example.com/stream",
                "javascript:alert(1)"
              ],
              id: "chunk-id",
              model: "anthropic/claude-opus-4.8",
              object: "chat.completion.chunk"
            })}\n\n`,
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    annotations: [
                      { title: "Stream annotation", url: "https://example.com/stream-annotation" },
                      { title: "Unsafe stream annotation", url: "data:text/html,bad" }
                    ],
                    content: "lo",
                    reasoning_details: "done"
                  },
                  finish_reason: "stop"
                }
              ],
              id: "chunk-id"
            })}\n\n`,
            `data: ${JSON.stringify({
              choices: [],
              id: "chunk-id",
              usage: {
                input_tokens: 7,
                input_tokens_details: {
                  cached_tokens: 2
                },
                output_tokens: 3,
                output_tokens_details: {
                  reasoning_tokens: 2
                },
                total_tokens: 10
              }
            })}\n\n`,
            "data: [DO",
            "NE]\n\n",
            "data: {not-json}\n\n"
          ],
          { "x-generation-id": "header-id" }
        ),
        responseContext
      )
    );

    expect(normalized.events.map((event) => event.type)).toEqual([
      "artifact",
      "token",
      "token",
      "usage",
      "artifact",
      "artifact",
      "artifact"
    ]);
    expect(normalized.events[0]).toMatchObject({
      data: {
        artifactType: "summary",
        payload: {
          responseId: "chunk-id"
        }
      },
      type: "artifact"
    });
    expect(normalized.events.filter((event) => event.type === "token")).toEqual([
      { data: { delta: "Hel" }, type: "token" },
      { data: { delta: "lo" }, type: "token" }
    ]);
    expect(normalized.events).toContainEqual({
      data: {
        artifactType: "reasoning",
        payload: {
          reasoning: "think done"
        }
      },
      type: "artifact"
    });
    expect(JSON.stringify(normalized.events)).not.toContain("javascript:");
    expect(JSON.stringify(normalized.events)).not.toContain("data:text/html");
    expect(normalized.result).toMatchObject({
      finalProviderResponsePreview: {
        finishReason: "stop"
      },
      finalText: "Hello",
      providerResponseId: "chunk-id",
      usage: {
        cachedInputTokens: 2,
        cacheWriteInputTokens: 0,
        inputTokens: 7,
        outputTokens: 3,
        reasoningTokens: 2,
        totalTokens: 10
      }
    });
  });

  it("assembles ordered parallel tool calls from streamed argument fragments", async () => {
    const normalized = await collect(
      streamOpenRouterSseResponse(
        sseResponse([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: { arguments: '{"page":', name: "notion__fetch" },
                      id: "call-notion",
                      index: 0,
                      type: "function"
                    },
                    {
                      function: { arguments: '{"query":"', name: "mem0__search" },
                      id: "call-mem0",
                      index: 1,
                      type: "function"
                    }
                  ]
                },
                finish_reason: null
              }
            ],
            id: "or-tools-1"
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { function: { arguments: '42}' }, index: 0 },
                    { function: { arguments: 'ADR"}' }, index: 1 }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            id: "or-tools-1"
          })}\n\n`,
          "data: [DONE]\n\n"
        ]),
        responseContext
      )
    );

    expect(normalized.result.toolCalls).toMatchObject([
      {
        arguments: { page: 42 },
        id: "call-notion",
        name: "notion__fetch"
      },
      {
        arguments: { query: "ADR" },
        id: "call-mem0",
        name: "mem0__search"
      }
    ]);
    expect(normalized.result.providerToolCallMessage).toMatchObject({
      role: "assistant",
      tool_calls: [
        { id: "call-notion", type: "function" },
        { id: "call-mem0", type: "function" }
      ]
    });
  });

  it("uses the response header id and legacy sparse zero usage when the stream ends without JSON", async () => {
    const normalized = await collect(
      streamOpenRouterSseResponse(
        sseResponse(["data: [DONE]\n\n"], { "x-generation-id": "header-only-id" }),
        responseContext
      )
    );

    expect(normalized.events).toEqual([
      {
        data: {
          artifactType: "summary",
          payload: {
            model: "anthropic/claude-opus-4.8",
            provider: "openrouter",
            responseId: "header-only-id",
            stage: "answer"
          }
        },
        type: "artifact"
      }
    ]);
    expect(normalized.result).toEqual({
      finalProviderResponsePreview: {
        citations: [],
        finishReason: null,
        id: "header-only-id",
        model: "anthropic/claude-opus-4.8",
        object: "chat.completion.chunk",
        provider: "openrouter",
        rawText: undefined,
        text: "",
        usage: null
      },
      finalText: "",
      providerResponseId: "header-only-id",
      toolCalls: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0
      }
    });
  });

  it("rejects partial text and usage or empty EOF without a DONE sentinel", async () => {
    const partial = streamOpenRouterSseResponse(
      sseResponse([
        'data: {"id":"or-partial","choices":[{"delta":{"content":"Partial"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n'
      ]),
      responseContext
    );

    await expect(partial.next()).resolves.toMatchObject({
      done: false,
      value: expect.objectContaining({ type: "artifact" })
    });
    await expect(partial.next()).resolves.toEqual({
      done: false,
      value: {
        data: expect.objectContaining({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
        type: "usage"
      }
    });
    await expect(partial.next()).resolves.toEqual({
      done: false,
      value: { data: { delta: "Partial" }, type: "token" }
    });
    await expect(partial.next()).rejects.toThrow("openrouter_stream_truncated");

    const empty = streamOpenRouterSseResponse(sseResponse([]), responseContext);
    await expect(empty.next()).rejects.toThrow("openrouter_stream_truncated");
  });

  it("preserves non-string reasoning fragments as an ordered aggregate", async () => {
    const normalized = await collect(
      streamOpenRouterSseResponse(
        sseResponse([
          'data: {"choices":[{"delta":{"reasoning_details":{"step":1}}}]}\n\n',
          'data: {"choices":[{"delta":{"reasoning_details":{"step":2}}}]}\n\n',
          "data: [DONE]\n\n"
        ]),
        responseContext
      )
    );

    expect(normalized.events).toContainEqual({
      data: {
        artifactType: "reasoning",
        payload: {
          reasoning: [{ step: 1 }, { step: 2 }]
        }
      },
      type: "artifact"
    });
  });

  it.each([
    ["top-level", { error: { message: remoteSecret } }],
    ["choice", { choices: [{ error: { code: "stream-choice" } }] }],
    [
      "message",
      { choices: [{ message: { error: { message: "stream-message" } } }] }
    ]
  ])("rejects %s mid-stream error frames without remote details", async (_location, payload) => {
    const stream = streamOpenRouterSseResponse(
      sseResponse([`data: ${JSON.stringify(payload)}\n\n`]),
      responseContext
    );

    let failure: unknown;
    try {
      await stream.next();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ message: "openrouter_stream_error" });
    expect((failure as Error).message).not.toContain(remoteSecret);
  });

  it("rejects missing bodies and malformed JSON frames", async () => {
    const missingBody = streamOpenRouterSseResponse(new Response(null), responseContext);
    await expect(missingBody.next()).rejects.toThrow("openrouter_stream_body_missing");

    const malformed = streamOpenRouterSseResponse(sseResponse(["data: {not-json}\n\n"]), responseContext);
    await expect(malformed.next()).rejects.toThrow("openrouter_stream_truncated");
  });

  it("preserves provider stream idle timeout and abort behavior", async () => {
    const idle = streamOpenRouterSseResponse(
      new Response(new ReadableStream<Uint8Array>()),
      responseContext,
      undefined,
      1
    );
    await expect(idle.next()).rejects.toThrow("provider_stream_timeout");

    const abortController = new AbortController();
    abortController.abort(new Error("operator_cancelled"));
    const aborted = streamOpenRouterSseResponse(
      new Response(new ReadableStream<Uint8Array>()),
      responseContext,
      abortController.signal,
      1000
    );
    await expect(aborted.next()).rejects.toThrow("operator_cancelled");
  });
});
