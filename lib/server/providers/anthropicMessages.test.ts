import { describe, expect, it, vi } from "vitest";
import {
  buildAnthropicMessagesRequest,
  createAnthropicMessagesAdapter,
  createFetchAnthropicMessagesClient,
  type AnthropicMessagesClient,
  type AnthropicStreamEvent
} from "./anthropicMessages";
import type { ProviderRunRequest } from "./types";
import type { RunTool } from "../tools/types";
import { DEFAULT_PROVIDER_STREAM_LIMITS } from "./network";
import { attachProviderStreamSafetySnapshot } from "./streamSafety";

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
      system: "You are Claude in AIQSA."
    },
    provider: "anthropic",
    searchStrategy: "search-disabled",
    ...overrides
  };
}

function hostedSearchRequest(
  overrides: Partial<ProviderRunRequest> = {}
): ProviderRunRequest {
  const base = request();
  return request({
    modelCapabilities: {
      ...base.modelCapabilities,
      nativeSearch: true
    },
    searchPlan: {
      mode: "model_choice",
      options: [{
        adapterKind: "answer_provider_hosted",
        config: {},
        credentialMode: "answer_provider",
        executionModes: ["model_choice"],
        modelId: null,
        optionId: "anthropic-web-search",
        protocol: "anthropic_web_search",
        provider: "anthropic",
        providerModelId: null,
        revisionId: "anthropic-search-revision",
        searchStrategyRowId: "anthropic-search-route"
      }]
    },
    searchStrategy: "anthropic-web-search",
    ...overrides
  });
}

function expectNoBlankAnthropicTextBlocks(body: Record<string, unknown>): void {
  const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "text") {
        expect(block.text).toEqual(expect.any(String));
        expect((block.text as string).trim()).not.toBe("");
      }
    }
  }
}

async function* events(values: AnthropicStreamEvent[]): AsyncGenerator<AnthropicStreamEvent> {
  for (const value of values) {
    yield value;
  }
}

async function collectAdapterStream(
  client: AnthropicMessagesClient,
  maxOutputChars: number,
  requestValue = request()
) {
  const stream = createAnthropicMessagesAdapter({
    client,
    streamLimits: { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars }
  }).stream(requestValue);
  const seen = [];
  let next = await stream.next();
  while (!next.done) {
    seen.push(next.value);
    next = await stream.next();
  }
  return { events: seen, result: next.value };
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
    let stalledBodyCancelled = false;
    let oversizedBodyCancelled = false;

    try {
      process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES = "1024";
      const stalledClient = createFetchAnthropicMessagesClient({
        apiKey: "key",
        defaultTimeoutMs: 5,
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

      await expect(stalledClient.stream({}).next()).rejects.toMatchObject({
        code: "provider_request_timed_out",
        timeoutMs: 5
      });
      expect(stalledBodyCancelled).toBe(true);

      process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES = "4";
      const oversizedClient = createFetchAnthropicMessagesClient({
        apiKey: "key",
        defaultTimeoutMs: 100,
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
    }
  });

  it("keeps one stream deadline active while awaiting response headers", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("test_signal_missing");
      return await new Promise<Response>((_resolve, reject) => {
        const rejectOnAbort = () => reject(signal.reason);
        if (signal.aborted) {
          rejectOnAbort();
          return;
        }
        signal.addEventListener("abort", rejectOnAbort, { once: true });
      });
    });
    const client = createFetchAnthropicMessagesClient({ apiKey: "key", fetchFn });

    await expect(client.stream({}, {
      streamLimits: {
        ...DEFAULT_PROVIDER_STREAM_LIMITS,
        maxDurationMs: 20
      }
    }).next()).rejects.toMatchObject({
      code: "provider_request_timed_out",
      timeoutMs: 20
    });
    expect(fetchFn).toHaveBeenCalledOnce();
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

  it("represents attachment-only history turns without replaying private attachment data", () => {
    const historyFileName = "HISTORY_FILENAME_CANARY.txt";
    const runRequest = request({
      context: {
        messages: [
          {
            content: {
              blocks: [
                {
                  attachmentId: "HISTORY_IMAGE_ID_CANARY",
                  dataUrl: "HISTORY_IMAGE_BYTES_CANARY",
                  mediaType: "HISTORY_IMAGE_MEDIA_TYPE_CANARY",
                  type: "image"
                },
                {
                  attachmentId: "HISTORY_FILE_ID_CANARY",
                  extractedText: "HISTORY_EXTRACTED_TEXT_CANARY",
                  fileName: historyFileName,
                  storageKey: "HISTORY_STORAGE_KEY_CANARY",
                  type: "file"
                }
              ]
            },
            id: "attachment-only-user",
            role: "user"
          },
          {
            content: {
              blocks: [{ text: "I reviewed the attachments.", type: "text" }]
            },
            id: "assistant-answer",
            role: "assistant"
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
    });
    const body = buildAnthropicMessagesRequest(runRequest) as {
      messages: Array<{ content: Array<Record<string, unknown>>; role: string }>;
    };
    const preview = buildAnthropicMessagesRequest(runRequest, {
      preview: true,
      redactFiles: true,
      redactImages: true
    }) as {
      messages: Array<{ content: Array<Record<string, unknown>>; role: string }>;
    };
    const bodyJson = JSON.stringify(body);
    const previewJson = JSON.stringify(preview);

    expect(body.messages[0]).toEqual({
      content: [
        {
          text: `[image attachment]\n[file attachment: ${historyFileName}]`,
          type: "text"
        }
      ],
      role: "user"
    });
    expect(preview.messages[0]).toEqual({
      content: [
        {
          text: "[image attachment]\n[file attachment]",
          type: "text"
        }
      ],
      role: "user"
    });
    for (const canary of [
      "HISTORY_IMAGE_ID_CANARY",
      "HISTORY_IMAGE_BYTES_CANARY",
      "HISTORY_IMAGE_MEDIA_TYPE_CANARY",
      "HISTORY_FILE_ID_CANARY",
      "HISTORY_EXTRACTED_TEXT_CANARY",
      "HISTORY_STORAGE_KEY_CANARY"
    ]) {
      expect(bodyJson).not.toContain(canary);
      expect(previewJson).not.toContain(canary);
    }
    expect(bodyJson).toContain(historyFileName);
    expect(previewJson).not.toContain(historyFileName);
    expectNoBlankAnthropicTextBlocks(body);
    expectNoBlankAnthropicTextBlocks(preview);
  });

  it("keeps attachment-only content non-empty when adjacent user turns merge", () => {
    const body = buildAnthropicMessagesRequest(
      request({
        context: {
          messages: [
            {
              content: {
                blocks: [
                  {
                    attachmentId: "history-file-id",
                    fileName: "history.txt",
                    type: "file"
                  }
                ]
              },
              id: "attachment-only-user",
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

    expect(body.messages).toEqual([
      {
        content: [
          { text: "[file attachment: history.txt]", type: "text" },
          { text: "Answer briefly.", type: "text" }
        ],
        role: "user"
      }
    ]);
    expectNoBlankAnthropicTextBlocks(body);
  });

  it("uses an attachment placeholder when current document text is whitespace-only", () => {
    const runRequest = request({
      attachmentIds: ["document-1"],
      attachments: [
        {
          byteSize: 3,
          extractedText: " \n ",
          fileName: "blank.txt",
          id: "document-1",
          kind: "document",
          metadata: {},
          mimeType: "text/plain",
          status: "ready"
        }
      ],
      content: {
        blocks: [
          {
            attachmentId: "document-1",
            fileName: "blank.txt",
            type: "file"
          }
        ]
      }
    });
    const body = buildAnthropicMessagesRequest(runRequest);
    const preview = buildAnthropicMessagesRequest(runRequest, {
      preview: true,
      redactFiles: true,
      redactImages: true
    });

    expect(body.messages).toEqual([
      {
        content: [{ text: "[file attachment: blank.txt]", type: "text" }],
        role: "user"
      }
    ]);
    expect(preview.messages).toEqual([
      {
        content: [{ text: "[file attachment]", type: "text" }],
        role: "user"
      }
    ]);
    expectNoBlankAnthropicTextBlocks(body);
    expectNoBlankAnthropicTextBlocks(preview);
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

  it("redacts Anthropic tool transcripts and thinking only in request previews", () => {
    const client: AnthropicMessagesClient = {
      stream: () => events([])
    };
    const adapter = createAnthropicMessagesAdapter({ client });
    const runRequest = request({
      providerToolMessages: [
        {
          content: [
            {
              id: "toolu-1",
              input: { query: "ANTHROPIC_TOOL_INPUT_CANARY" },
              name: "mem0__search",
              opaque_tool_use_field: "ANTHROPIC_TOOL_USE_FIELD_CANARY",
              type: "tool_use"
            },
            {
              signature: "ANTHROPIC_THINKING_SIGNATURE_CANARY",
              thinking: "ANTHROPIC_THINKING_TEXT_CANARY",
              type: "thinking"
            },
            {
              data: "ANTHROPIC_REDACTED_THINKING_CANARY",
              type: "redacted_thinking"
            },
            {
              text: "ANTHROPIC_ASSISTANT_TEXT_CANARY",
              type: "text"
            },
            {
              opaque: "ANTHROPIC_UNKNOWN_BLOCK_CANARY",
              type: "unknown"
            }
          ],
          role: "assistant"
        },
        {
          content: [
            {
              content: [{ text: "ANTHROPIC_TOOL_OUTPUT_CANARY", type: "text" }],
              is_error: true,
              opaque_result_field: "ANTHROPIC_RESULT_FIELD_CANARY",
              tool_use_id: "toolu-1",
              type: "tool_result"
            }
          ],
          role: "user"
        }
      ]
    });
    const transport = buildAnthropicMessagesRequest(runRequest);
    const preview = adapter.buildRequestPreview(runRequest) as {
      body: { messages: Array<{ content: Array<Record<string, unknown>>; role: string }> };
      redactions: string[];
    };
    const transportJson = JSON.stringify(transport);
    const previewJson = JSON.stringify(preview);

    for (const canary of [
      "ANTHROPIC_TOOL_INPUT_CANARY",
      "ANTHROPIC_TOOL_USE_FIELD_CANARY",
      "ANTHROPIC_THINKING_SIGNATURE_CANARY",
      "ANTHROPIC_THINKING_TEXT_CANARY",
      "ANTHROPIC_REDACTED_THINKING_CANARY",
      "ANTHROPIC_ASSISTANT_TEXT_CANARY",
      "ANTHROPIC_UNKNOWN_BLOCK_CANARY",
      "ANTHROPIC_TOOL_OUTPUT_CANARY",
      "ANTHROPIC_RESULT_FIELD_CANARY"
    ]) {
      expect(transportJson).toContain(canary);
      expect(previewJson).not.toContain(canary);
    }
    expect(preview.body.messages.slice(-2)).toEqual([
      {
        content: [
          {
            id: "toolu-1",
            name: "mem0__search",
            type: "tool_use"
          }
        ],
        role: "assistant"
      },
      {
        content: [
          {
            content: "[tool output omitted]",
            is_error: true,
            tool_use_id: "toolu-1",
            type: "tool_result"
          }
        ],
        role: "user"
      }
    ]);
    expect(preview.redactions).toContain("provider_continuation_opaque_fields");
  });

  it("serializes only the reviewed hosted Search declaration and rejects client-tool mixing", () => {
    const body = buildAnthropicMessagesRequest(hostedSearchRequest());

    expect(body.tools).toEqual([{
      allowed_callers: ["direct"],
      max_uses: 3,
      name: "web_search",
      type: "web_search_20250305"
    }]);
    expect(body).not.toHaveProperty("tool_choice");
    expect(() => buildAnthropicMessagesRequest(hostedSearchRequest({
      tools: [mcpTool]
    }))).toThrow("anthropic_hosted_search_client_tools_unsupported");
    expect(() => buildAnthropicMessagesRequest(hostedSearchRequest({
      providerToolMessages: [{ content: [], role: "assistant" }]
    }))).toThrow("anthropic_hosted_search_client_tools_unsupported");
  });

  it("redacts attachment canaries in request previews without changing transport", () => {
    const client: AnthropicMessagesClient = {
      stream: () => events([])
    };
    const adapter = createAnthropicMessagesAdapter({ client });
    const base = request();
    const runRequest = request({
      attachmentIds: ["PDF_ID_CANARY", "DOCUMENT_ID_CANARY", "IMAGE_ID_CANARY"],
      attachments: [
        {
          base64Data: "PDF_BYTES_CANARY",
          byteSize: 12,
          extractedText: "UNUSED_PDF_TEXT_CANARY",
          fileName: "PDF_FILENAME_CANARY",
          id: "PDF_ID_CANARY",
          kind: "pdf",
          metadata: { storageKey: "PDF_METADATA_CANARY" },
          mimeType: "application/pdf",
          status: "ready"
        },
        {
          byteSize: 16,
          extractedText: "DOCUMENT_TEXT_CANARY",
          fileName: "DOCUMENT_FILENAME_CANARY",
          id: "DOCUMENT_ID_CANARY",
          kind: "document",
          metadata: { remoteUrl: "DOCUMENT_METADATA_CANARY" },
          mimeType: "text/plain",
          status: "ready"
        },
        {
          byteSize: 12,
          dataUrl: "data:image/png;base64,IMAGE_BYTES_CANARY",
          extractedText: null,
          fileName: "IMAGE_FILENAME_CANARY",
          id: "IMAGE_ID_CANARY",
          kind: "image",
          metadata: { remoteUrl: "IMAGE_METADATA_CANARY" },
          mimeType: "IMAGE_MIME_CANARY",
          status: "ready"
        }
      ],
      modelCapabilities: { ...base.modelCapabilities, nativePdfInput: true }
    });
    const actualJson = JSON.stringify(buildAnthropicMessagesRequest(runRequest));
    const preview = adapter.buildRequestPreview(runRequest);
    const previewJson = JSON.stringify(preview);

    for (const canary of [
      "PDF_BYTES_CANARY",
      "UNUSED_PDF_TEXT_CANARY",
      "PDF_FILENAME_CANARY",
      "PDF_ID_CANARY",
      "PDF_METADATA_CANARY",
      "DOCUMENT_TEXT_CANARY",
      "DOCUMENT_FILENAME_CANARY",
      "DOCUMENT_ID_CANARY",
      "DOCUMENT_METADATA_CANARY",
      "IMAGE_BYTES_CANARY",
      "IMAGE_FILENAME_CANARY",
      "IMAGE_ID_CANARY",
      "IMAGE_METADATA_CANARY",
      "IMAGE_MIME_CANARY"
    ]) {
      expect(previewJson).not.toContain(canary);
    }
    for (const canary of ["PDF_BYTES_CANARY", "DOCUMENT_TEXT_CANARY", "IMAGE_BYTES_CANARY", "IMAGE_MIME_CANARY"]) {
      expect(actualJson).toContain(canary);
    }
    expect(previewJson).toContain("[base64 PDF data omitted]");
    expect(previewJson).toContain("[Document attachment text omitted]");
    expect(previewJson).toContain("[base64 image data omitted]");
    expect(previewJson).toContain("[attachment media type omitted]");
    expect(preview).toMatchObject({
      redactions: [
        "attachment_extracted_text",
        "attachment_filename",
        "attachment_media_type",
        "image_base64",
        "pdf_base64",
        "provider_continuation_opaque_fields"
      ]
    });
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
            content_block: { signature: "", thinking: "", type: "thinking" },
            index: 0,
            type: "content_block_start"
          },
          {
            delta: {
              thinking: "checking",
              type: "thinking_delta"
            },
            index: 0,
            type: "content_block_delta"
          },
          { index: 0, type: "content_block_stop" },
          {
            content_block: { text: "", type: "text" },
            index: 1,
            type: "content_block_start"
          },
          {
            delta: {
              text: "Hello",
              type: "text_delta"
            },
            index: 1,
            type: "content_block_delta"
          },
          {
            delta: {
              text: "!",
              type: "text_delta"
            },
            index: 1,
            type: "content_block_delta"
          },
          { index: 1, type: "content_block_stop" },
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

  it.each(["refusal", "model_context_window_exceeded"])(
    "rejects a non-hosted %s terminal without exposing provider details",
    async (stopReason) => {
      const providerDetail = `${remoteSecret}: provider-only terminal detail`;
      const client: AnthropicMessagesClient = {
        stream: () => events([
          {
            message: {
              id: `msg-${stopReason}`,
              provider_detail: providerDetail,
              usage: { input_tokens: 4 }
            },
            type: "message_start"
          },
          {
            delta: { provider_detail: providerDetail, stop_reason: stopReason },
            type: "message_delta",
            usage: { output_tokens: 0 }
          },
          { type: "message_stop" }
        ])
      };

      try {
        await collectAdapterStream(client, DEFAULT_PROVIDER_STREAM_LIMITS.maxOutputChars);
        throw new Error("Expected Anthropic terminal failure.");
      } catch (error) {
        expect(error).toEqual(new Error(`anthropic_message_${stopReason}`));
        expect(String(error)).not.toContain(providerDetail);
      }
    }
  );

  it("rejects an unknown provider-controlled stop reason with a stable identity", async () => {
    const stopReason = `future_${remoteSecret}`;
    const client: AnthropicMessagesClient = {
      stream: () => events([
        { message: { id: "msg-unknown-stop-reason" }, type: "message_start" },
        { delta: { stop_reason: stopReason }, type: "message_delta" },
        { type: "message_stop" }
      ])
    };

    const failure = await collectAdapterStream(
      client,
      DEFAULT_PROVIDER_STREAM_LIMITS.maxOutputChars
    ).then(
      () => new Error("Expected Anthropic terminal failure."),
      (error: unknown) => error
    );

    expect(failure).toEqual(new Error("anthropic_message_terminal_invalid"));
    expect(String(failure)).not.toContain(remoteSecret);
  });

  it.each(["max_tokens", "stop_sequence"])(
    "preserves partial text, usage, and preview for %s",
    async (stopReason) => {
      const client: AnthropicMessagesClient = {
        stream: () => events([
          {
            message: {
              id: `msg-${stopReason}`,
              model: "claude-opus-4-8",
              usage: { input_tokens: 4 }
            },
            type: "message_start"
          },
          { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" },
          {
            delta: { text: "Usable partial answer", type: "text_delta" },
            index: 0,
            type: "content_block_delta"
          },
          { index: 0, type: "content_block_stop" },
          {
            delta: { stop_reason: stopReason },
            type: "message_delta",
            usage: { output_tokens: 3 }
          },
          { type: "message_stop" }
        ])
      };

      const normalized = await collectAdapterStream(
        client,
        DEFAULT_PROVIDER_STREAM_LIMITS.maxOutputChars
      );

      expect(normalized.result).toMatchObject({
        finalProviderResponsePreview: {
          id: `msg-${stopReason}`,
          model: "claude-opus-4-8",
          provider: "anthropic",
          stopReason,
          text: "Usable partial answer",
          usage: { input_tokens: 4, output_tokens: 3, reasoning_tokens: 0 }
        },
        finalText: "Usable partial answer",
        providerResponseId: `msg-${stopReason}`,
        usage: { inputTokens: 4, outputTokens: 3, reasoningTokens: 0, totalTokens: 7 }
      });
    }
  );

  it("preserves a non-hosted success without message_delta", async () => {
    const client: AnthropicMessagesClient = {
      stream: () => events([
        {
          message: {
            id: "msg-no-message-delta",
            model: "claude-opus-4-8",
            usage: { input_tokens: 2, output_tokens: 1 }
          },
          type: "message_start"
        },
        {
          content_block: { text: "Terminal-only shape", type: "text" },
          index: 0,
          type: "content_block_start"
        },
        { index: 0, type: "content_block_stop" },
        { type: "message_stop" }
      ])
    };

    await expect(collectAdapterStream(
      client,
      DEFAULT_PROVIDER_STREAM_LIMITS.maxOutputChars
    )).resolves.toMatchObject({
      result: {
        finalProviderResponsePreview: {
          stopReason: undefined,
          text: "Terminal-only shape"
        },
        finalText: "Terminal-only shape",
        usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0, totalTokens: 3 }
      }
    });
  });

  it.each([undefined, "end_turn", "max_tokens", "stop_sequence"] as const)(
    "rejects a client tool call paired with non-tool terminal %s",
    async (stopReason) => {
      const streamEvents: AnthropicStreamEvent[] = [
        { message: { id: "msg-invalid-tool-terminal" }, type: "message_start" },
        {
          content_block: {
            id: "toolu-invalid-terminal",
            input: { query: "must not execute" },
            name: "mem0__search",
            type: "tool_use"
          },
          index: 0,
          type: "content_block_start"
        },
        { index: 0, type: "content_block_stop" },
        ...(stopReason === undefined
          ? []
          : [{ delta: { stop_reason: stopReason }, type: "message_delta" } as const]),
        { type: "message_stop" }
      ];
      const client: AnthropicMessagesClient = {
        stream: () => events(streamEvents)
      };

      await expect(collectAdapterStream(
        client,
        DEFAULT_PROVIDER_STREAM_LIMITS.maxOutputChars,
        request({ tools: [mcpTool] })
      )).rejects.toThrow("anthropic_message_terminal_invalid");
    }
  );

  it("rejects pause_turn and tool_use without a parsed client tool call", async () => {
    const terminal = (stopReason: "pause_turn" | "tool_use"): AnthropicMessagesClient => ({
      stream: () => events([
        { message: { id: `msg-${stopReason}` }, type: "message_start" },
        { delta: { stop_reason: stopReason }, type: "message_delta" },
        { type: "message_stop" }
      ])
    });

    await expect(collectAdapterStream(
      terminal("pause_turn"),
      DEFAULT_PROVIDER_STREAM_LIMITS.maxOutputChars
    )).rejects.toThrow("anthropic_pause_turn_unexpected");
    await expect(collectAdapterStream(
      terminal("tool_use"),
      DEFAULT_PROVIDER_STREAM_LIMITS.maxOutputChars,
      request({ tools: [mcpTool] })
    )).rejects.toThrow("anthropic_message_tool_use");
  });

  it("normalizes hosted Search SSE without exposing server blocks as client tool calls", async () => {
    const client: AnthropicMessagesClient = {
      stream: () => events([
        {
          message: {
            id: "msg-hosted-search",
            model: "claude-opus-5",
            usage: {
              input_tokens: 8,
              server_tool_use: { web_search_requests: 1 }
            }
          },
          type: "message_start"
        },
        { type: "ping" },
        {
          content_block: {
            id: "srvtoolu-hosted",
            input: {},
            name: "web_search",
            type: "server_tool_use"
          },
          index: 0,
          type: "content_block_start"
        },
        {
          delta: { partial_json: '{"query":"Moscow news"}', type: "input_json_delta" },
          index: 0,
          type: "content_block_delta"
        },
        { index: 0, type: "content_block_stop" },
        {
          content_block: {
            caller: { type: "direct" },
            content: [{
              encrypted_content: "PRIVATE_ENCRYPTED_RESULT",
              page_age: "2026-08-04",
              title: "Current report",
              type: "web_search_result",
              url: "https://example.com/report"
            }],
            tool_use_id: "srvtoolu-hosted",
            type: "web_search_tool_result"
          },
          index: 1,
          type: "content_block_start"
        },
        { index: 1, type: "content_block_stop" },
        {
          content_block: { text: "", type: "text" },
          index: 2,
          type: "content_block_start"
        },
        {
          delta: { text: "Current findings.", type: "text_delta" },
          index: 2,
          type: "content_block_delta"
        },
        {
          delta: {
            citation: {
              cited_text: "A concise supported fact.",
              encrypted_index: "PRIVATE_ENCRYPTED_INDEX",
              title: null,
              type: "web_search_result_location",
              url: "https://example.com/report"
            },
            type: "citations_delta"
          },
          index: 2,
          type: "content_block_delta"
        },
        { index: 2, type: "content_block_stop" },
        {
          delta: { stop_reason: "end_turn" },
          type: "message_delta",
          usage: {
            output_tokens: 5,
            server_tool_use: { web_search_requests: 1 }
          }
        },
        { type: "message_stop" }
      ])
    };
    const normalized = await collectAdapterStream(
      client,
      DEFAULT_PROVIDER_STREAM_LIMITS.maxOutputChars,
      hostedSearchRequest()
    );

    expect(normalized.result).toMatchObject({
      finalProviderResponsePreview: {
        continuationCount: 0,
        stopReason: "end_turn",
        webSearchRequests: 1
      },
      finalText: "Current findings.",
      providerResponseId: "msg-hosted-search",
      toolCalls: [],
      usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 }
    });
    expect(normalized.result).not.toHaveProperty("providerToolCallMessage");
    expect(normalized.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({ artifactType: "search" }),
        type: "artifact"
      }),
      expect.objectContaining({
        data: expect.objectContaining({ artifactType: "citation" }),
        type: "artifact"
      })
    ]));
    expect(JSON.stringify(normalized)).not.toMatch(
      /PRIVATE_ENCRYPTED_RESULT|PRIVATE_ENCRYPTED_INDEX/u
    );
  });

  it("matches a paused server-tool id on the next hop under shared stream budgets", async () => {
    const bodies: Record<string, unknown>[] = [];
    const limits: Array<{ maxBytes: number; maxDurationMs: number }> = [];
    let attempt = 0;
    const client: AnthropicMessagesClient = {
      stream(body, options) {
        bodies.push(body);
        limits.push({
          maxBytes: options?.streamLimits?.maxBytes ?? 0,
          maxDurationMs: options?.streamLimits?.maxDurationMs ?? 0
        });
        attempt += 1;
        const values: AnthropicStreamEvent[] = attempt === 1
          ? [
              { message: { id: "msg-paused", usage: { input_tokens: 2 } }, type: "message_start" },
              {
                content_block: {
                  id: "srvtoolu-paused",
                  input: { query: "Moscow news" },
                  name: "web_search",
                  type: "server_tool_use"
                },
                index: 0,
                type: "content_block_start"
              },
              { index: 0, type: "content_block_stop" },
              {
                delta: { stop_reason: "pause_turn" },
                type: "message_delta",
                usage: {
                  output_tokens: 1,
                  server_tool_use: { web_search_requests: 1 }
                }
              },
              { type: "message_stop" }
            ]
          : [
              { message: { id: "msg-finished", usage: { input_tokens: 4 } }, type: "message_start" },
              {
                content_block: {
                  caller: { type: "direct" },
                  content: [{
                    encrypted_content: "PRIVATE_CONTINUATION_RESULT",
                    title: "Current report",
                    type: "web_search_result",
                    url: "https://example.com/report"
                  }],
                  tool_use_id: "srvtoolu-paused",
                  type: "web_search_tool_result"
                },
                index: 0,
                type: "content_block_start"
              },
              { index: 0, type: "content_block_stop" },
              {
                content_block: {
                  citations: [{
                    cited_text: "Supported.",
                    encrypted_index: "PRIVATE_CONTINUATION_INDEX",
                    title: "Current report",
                    type: "web_search_result_location",
                    url: "https://example.com/report"
                  }],
                  text: "Done.",
                  type: "text"
                },
                index: 1,
                type: "content_block_start"
              },
              { index: 1, type: "content_block_stop" },
              {
                delta: { stop_reason: "end_turn" },
                type: "message_delta",
                usage: {
                  output_tokens: 3,
                  server_tool_use: { web_search_requests: 0 }
                }
              },
              { type: "message_stop" }
            ];
        return (async function* () {
          for (const value of values) {
            yield attachProviderStreamSafetySnapshot(value, {
              durationMs: 1,
              totalStreamBytes: attempt === 1 ? 60 : 30
            });
          }
        })();
      }
    };
    const adapter = createAnthropicMessagesAdapter({
      client,
      streamLimits: {
        ...DEFAULT_PROVIDER_STREAM_LIMITS,
        maxBytes: 100,
        maxDurationMs: 10_000,
        maxEventBytes: 100
      }
    });
    const stream = adapter.stream(hostedSearchRequest());
    const seen = [];
    let next = await stream.next();
    while (!next.done) {
      seen.push(next.value);
      next = await stream.next();
    }

    expect(bodies).toHaveLength(2);
    expect((bodies[1]?.messages as Record<string, unknown>[]).at(-1)).toEqual({
      content: [{
        id: "srvtoolu-paused",
        input: { query: "Moscow news" },
        name: "web_search",
        type: "server_tool_use"
      }],
      role: "assistant"
    });
    expect(bodies[1]?.tools).toEqual(bodies[0]?.tools);
    expect(limits[0]?.maxBytes).toBe(100);
    expect(limits[1]?.maxBytes).toBe(40);
    expect(limits[1]?.maxDurationMs).toBeLessThanOrEqual(limits[0]!.maxDurationMs);
    expect(next.value).toMatchObject({
      finalProviderResponsePreview: {
        continuationCount: 1,
        webSearchRequests: 1
      },
      finalText: "Done.",
      providerResponseId: "msg-finished",
      toolCalls: [],
      usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 }
    });
    expect(next.value).not.toHaveProperty("providerToolCallMessage");
    const searchArtifacts = seen.filter((event) =>
      event.type === "artifact" && event.data.artifactType === "search");
    expect(searchArtifacts).toHaveLength(2);
    expect(JSON.stringify({ next: next.value, seen })).not.toMatch(
      /PRIVATE_CONTINUATION_RESULT|PRIVATE_CONTINUATION_INDEX/u
    );
  });

  it("rejects unsafe hosted Search usage values", async () => {
    const client: AnthropicMessagesClient = {
      stream: () => events([{
        message: {
          id: "msg-unsafe-usage",
          usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1 }
        },
        type: "message_start"
      }])
    };

    await expect(collectAdapterStream(
      client,
      DEFAULT_PROVIDER_STREAM_LIMITS.maxOutputChars,
      hostedSearchRequest()
    )).rejects.toThrow("anthropic_usage_invalid");
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

  it("bounds visible text at the exact limit before yielding one character over", async () => {
    const client = (text: string): AnthropicMessagesClient => ({
      stream: () => events([
        { message: { id: "msg-limit" }, type: "message_start" },
        { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" },
        { delta: { text, type: "text_delta" }, index: 0, type: "content_block_delta" },
        { index: 0, type: "content_block_stop" },
        { type: "message_stop" }
      ])
    });

    await expect(collectAdapterStream(client("Hello"), 5)).resolves.toMatchObject({
      result: { finalText: "Hello" }
    });
    await expect(collectAdapterStream(client("Hello!"), 5)).rejects.toMatchObject({
      code: "provider_output_too_large",
      maxChars: 5,
      observedChars: 6,
      retainedTextKind: "visible_output"
    });
  });

  it("bounds thinking, signature, and tool-input fragments at exact and over limits", async () => {
    const thoughtClient = (
      type: "signature_delta" | "thinking_delta",
      value: string
    ): AnthropicMessagesClient => ({
      stream: () => events([
        { message: { id: "msg-thought-limit" }, type: "message_start" },
        {
          content_block: { signature: "", thinking: "", type: "thinking" },
          index: 0,
          type: "content_block_start"
        },
        {
          delta: type === "thinking_delta"
            ? { thinking: value, type }
            : { signature: value, type },
          index: 0,
          type: "content_block_delta"
        },
        { index: 0, type: "content_block_stop" },
        { type: "message_stop" }
      ])
    });
    await expect(collectAdapterStream(thoughtClient("thinking_delta", "think"), 5)).resolves.toBeDefined();
    await expect(collectAdapterStream(thoughtClient("thinking_delta", "think!"), 5)).rejects.toMatchObject({
      code: "provider_output_too_large",
      retainedTextKind: "thinking"
    });
    await expect(collectAdapterStream(thoughtClient("signature_delta", "abcde"), 5)).resolves.toBeDefined();
    await expect(collectAdapterStream(thoughtClient("signature_delta", "abcdef"), 5)).rejects.toMatchObject({
      code: "provider_output_too_large",
      retainedTextKind: "signature"
    });

    const toolClient = (partialJson: string): AnthropicMessagesClient => ({
      stream: () => events([
        { message: { id: "msg-tool-limit" }, type: "message_start" },
        {
          content_block: { id: "tool-1", input: {}, name: "lookup", type: "tool_use" },
          index: 0,
          type: "content_block_start"
        },
        {
          delta: { partial_json: partialJson, type: "input_json_delta" },
          index: 0,
          type: "content_block_delta"
        },
        { index: 0, type: "content_block_stop" },
        { delta: { stop_reason: "tool_use" }, type: "message_delta" },
        { type: "message_stop" }
      ])
    });
    await expect(collectAdapterStream(
      toolClient('{"x":1}'),
      7,
      request({ tools: [mcpTool] })
    )).resolves.toMatchObject({ result: { toolCalls: [{ arguments: { x: 1 } }] } });
    await expect(collectAdapterStream(
      toolClient('{"x":10}'),
      7,
      request({ tools: [mcpTool] })
    )).rejects.toMatchObject({
      code: "provider_output_too_large",
      retainedTextKind: "tool_arguments"
    });

    const initialToolClient = (query: string): AnthropicMessagesClient => ({
      stream: () => events([
        { message: { id: "msg-initial-tool-limit" }, type: "message_start" },
        {
          content_block: {
            id: "tool-initial",
            input: { query },
            name: "lookup",
            type: "tool_use"
          },
          index: 0,
          type: "content_block_start"
        },
        { index: 0, type: "content_block_stop" },
        { delta: { stop_reason: "tool_use" }, type: "message_delta" },
        { type: "message_stop" }
      ])
    });
    await expect(collectAdapterStream(
      initialToolClient("Hello"),
      17,
      request({ tools: [mcpTool] })
    )).resolves.toMatchObject({ result: { toolCalls: [{ arguments: { query: "Hello" } }] } });
    await expect(collectAdapterStream(
      initialToolClient("Hello!"),
      17,
      request({ tools: [mcpTool] })
    )).rejects.toMatchObject({
      code: "provider_output_too_large",
      retainedTextKind: "tool_arguments"
    });
  });

  it("normalizes an injected stream-limit context before sharing it with the client", async () => {
    let receivedMaxOutputChars: number | undefined;
    const client: AnthropicMessagesClient = {
      stream(_body, options) {
        receivedMaxOutputChars = options?.streamLimits?.maxOutputChars;
        return events([
          { message: { id: "msg-normalized-limits" }, type: "message_start" },
          { content_block: { text: "ok", type: "text" }, index: 0, type: "content_block_start" },
          { index: 0, type: "content_block_stop" },
          { type: "message_stop" }
        ]);
      }
    };
    const adapter = createAnthropicMessagesAdapter({
      client,
      streamLimits: { maxOutputChars: 0 }
    });

    const stream = adapter.stream(request());
    while (!(await stream.next()).done) {
      // Consume the complete stream so the shared client context is observed.
    }
    expect(receivedMaxOutputChars).toBe(DEFAULT_PROVIDER_STREAM_LIMITS.maxOutputChars);
  });

  it("bounds streamed tool ids and names at the protocol limit", async () => {
    const client = (id: string, name: string): AnthropicMessagesClient => ({
      stream: () => events([
        { message: { id: "msg-tool-name-limit" }, type: "message_start" },
        {
          content_block: { id, input: {}, name, type: "tool_use" },
          index: 0,
          type: "content_block_start"
        },
        { index: 0, type: "content_block_stop" },
        { delta: { stop_reason: "tool_use" }, type: "message_delta" },
        { type: "message_stop" }
      ])
    });
    const exact = await collectAdapterStream(
      client("i".repeat(512), "n".repeat(512)),
      DEFAULT_PROVIDER_STREAM_LIMITS.maxOutputChars,
      request({ tools: [mcpTool] })
    );
    expect(exact.result.toolCalls).toMatchObject([{
      id: "i".repeat(512),
      name: "n".repeat(512)
    }]);

    await expect(collectAdapterStream(
      client("i".repeat(513), "lookup"),
      DEFAULT_PROVIDER_STREAM_LIMITS.maxOutputChars,
      request({ tools: [mcpTool] })
    )).rejects.toThrow("anthropic_stream_tool_call_invalid");
    await expect(collectAdapterStream(
      client("tool-1", "n".repeat(513)),
      DEFAULT_PROVIDER_STREAM_LIMITS.maxOutputChars,
      request({ tools: [mcpTool] })
    )).rejects.toThrow("anthropic_stream_tool_call_invalid");
  });

  it("rejects unknown or out-of-order stream structures", async () => {
    const malformed = (values: AnthropicStreamEvent[]) =>
      collectAdapterStream(
        { stream: () => events(values) },
        DEFAULT_PROVIDER_STREAM_LIMITS.maxOutputChars
      );

    await expect(malformed([{
      content_block: { text: "early", type: "text" },
      index: 0,
      type: "content_block_start"
    }])).rejects.toThrow("anthropic_stream_truncated");
    await expect(malformed([
      { message: { id: "msg-unknown-block" }, type: "message_start" },
      { content_block: { type: "future_block" }, index: 0, type: "content_block_start" }
    ])).rejects.toThrow("anthropic_stream_content_block_unsupported");
    await expect(malformed([
      { message: { id: "msg-unknown-delta" }, type: "message_start" },
      { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" },
      { delta: { type: "future_delta" }, index: 0, type: "content_block_delta" }
    ])).rejects.toThrow("anthropic_stream_content_delta_unsupported");
    await expect(malformed([
      { message: { id: "msg-mismatch" }, type: "message_start" },
      {
        content_block: { signature: "", thinking: "", type: "thinking" },
        index: 0,
        type: "content_block_start"
      },
      {
        delta: { text: "wrong block", type: "text_delta" },
        index: 0,
        type: "content_block_delta"
      }
    ])).rejects.toThrow("anthropic_stream_truncated");

    await expect(malformed([
      { message: { id: "msg-unknown-event" }, type: "message_start" },
      { opaque: true, type: "future_provider_event" }
    ])).rejects.toThrow("anthropic_stream_event_unsupported");
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
              content_block: { text: "", type: "text" },
              index: 0,
              type: "content_block_start"
            },
            {
              delta: { text: "Partial", type: "text_delta" },
              index: 0,
              type: "content_block_delta"
            },
            { index: 0, type: "content_block_stop" },
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
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Split terminal"}}\n\n',
            'data: {"type":"content_block_stop","index":0}\n\n',
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
