import { describe, expect, it } from "vitest";
import { perplexityWebSearchTool } from "../tools/perplexitySearch";
import { validateSearchToolArguments } from "../search/query";
import type {
  ProviderRunRequest,
  ProviderSearchPolicy,
  ProviderSearchRequest
} from "./types";
import {
  buildOpenRouterChatRequest,
  buildOpenRouterChatRequestPreview,
  buildOpenRouterPerplexitySearchRequest,
  buildOpenRouterPerplexitySearchRequestPreview
} from "./openRouterChatRequest";

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

function searchPolicy(): Extract<ProviderSearchPolicy, { provider: "openrouter" }> {
  return {
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
        only: [],
        requireParameters: false,
        sort: "throughput",
        zdr: false
      },
      reasoning: {
        enabled: false,
        exclude: true
      },
      stream: false,
      temperature: 0
    },
    modelId: "perplexity/sonar-pro-search",
    provider: "openrouter",
    strategyId: "perplexity-tool-search"
  };
}

function searchRequest(overrides: Partial<ProviderSearchRequest> = {}): ProviderSearchRequest {
  const validated = validateSearchToolArguments({ query: "Find one concise fact." });
  if (!validated.ok) throw new Error(validated.code);
  return {
    correlationId: "search-call-1",
    query: validated.query,
    searchPolicy: searchPolicy(),
    strategyId: "perplexity-tool-search",
    ...overrides
  };
}

describe("OpenRouter request builders", () => {
  it("builds chat route, cache, reasoning, instruction, and metadata controls", () => {
    const body = buildOpenRouterChatRequest(request());

    expect(body).toMatchObject({
      cache_control: {
        type: "ephemeral"
      },
      max_completion_tokens: 64,
      messages: [
        {
          content: "You are precise.\n\nDeveloper instructions:\nPrefer citations.",
          role: "system"
        },
        {
          content: "Find one concise fact.",
          role: "user"
        }
      ],
      metadata: {
        app: "aiqsa",
        search_strategy: "perplexity-tool-search",
        stage: "answer"
      },
      model: "anthropic/claude-opus-4.8",
      provider: {
        allow_fallbacks: false,
        data_collection: "deny",
        order: ["anthropic"],
        only: ["Anthropic"],
        require_parameters: true,
        sort: "latency",
        zdr: true
      },
      reasoning: {
        enabled: true,
        effort: "high",
        max_tokens: 32
      },
      stream: true,
      temperature: 0
    });
    expect(body.session_id).toMatch(/^aiqsa-chat-[a-f0-9]{32}$/);
    expect(body.session_id).not.toContain("chat-1");
  });

  it("merges adjacent context and preserves the provider tool transcript", () => {
    const body = buildOpenRouterChatRequest(
      request({
        context: {
          messages: [
            {
              content: { blocks: [{ text: "Earlier question", type: "text" }] },
              id: "user-1",
              role: "user"
            },
            {
              content: { blocks: [{ text: "Current question", type: "text" }] },
              id: "user-2",
              role: "user"
            }
          ],
          mode: "branch_path"
        },
        content: {
          blocks: [{ text: "Current question", type: "text" }]
        },
        providerToolMessages: [
          {
            content: null,
            role: "assistant",
            tool_calls: [
              {
                function: {
                  arguments: "{\"keyword\":\"current fact\"}",
                  name: "search_via_perplexity"
                },
                id: "call-1",
                type: "function"
              }
            ]
          },
          {
            content: "Search findings",
            name: "search_via_perplexity",
            role: "tool",
            tool_call_id: "call-1"
          }
        ],
        parallelToolCalls: true,
        toolChoice: "none",
        tools: [perplexityWebSearchTool]
      })
    );

    expect(body.messages).toEqual([
      {
        content: "You are precise.\n\nDeveloper instructions:\nPrefer citations.",
        role: "system"
      },
      {
        content: "Earlier question\n\nCurrent question",
        role: "user"
      },
      {
        content: null,
        role: "assistant",
        tool_calls: [
          {
            function: {
              arguments: "{\"keyword\":\"current fact\"}",
              name: "search_via_perplexity"
            },
            id: "call-1",
            type: "function"
          }
        ]
      },
      {
        content: "Search findings",
        name: "search_via_perplexity",
        role: "tool",
        tool_call_id: "call-1"
      }
    ]);
    expect(body).toMatchObject({
      parallel_tool_calls: true,
      stream: true,
      tool_choice: "none",
      tools: [
        {
          function: {
            name: "search_via_perplexity",
            parameters: perplexityWebSearchTool.inputSchema
          },
          type: "function"
        }
      ]
    });
    expect(buildOpenRouterChatRequest(request({ forceNonStreaming: true })).stream).toBe(false);
  });

  it("keeps model-specific cache and reasoning differences", () => {
    const verboseClaude = buildOpenRouterChatRequest(
      request({
        params: {
          maxTokens: 128000,
          provider: {
            order: ["anthropic"]
          },
          reasoning: {
            enabled: true,
            effort: "high"
          },
          verbosity: "max"
        }
      })
    );
    const gemini = buildOpenRouterChatRequest(
      request({
        modelId: "google/gemini-3.5-flash",
        params: {
          maxTokens: 65536,
          reasoning: {
            enabled: true,
            effort: "medium"
          },
          temperature: 1
        }
      })
    );

    expect(verboseClaude).toMatchObject({
      cache_control: { type: "ephemeral" },
      reasoning: { enabled: true },
      verbosity: "max"
    });
    expect(verboseClaude.reasoning).not.toMatchObject({ effort: expect.any(String) });
    expect(verboseClaude).not.toHaveProperty("temperature");
    expect(gemini).toMatchObject({
      reasoning: {
        effort: "medium",
        enabled: true
      },
      temperature: 1
    });
    expect(gemini).not.toHaveProperty("cache_control");
    expect(gemini).not.toHaveProperty("verbosity");
  });

  it("preserves legacy asymmetric redaction and makes previews unconditionally safe", () => {
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
          byteSize: 16,
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
    const actual = JSON.stringify(buildOpenRouterChatRequest(runRequest, { maxAttachmentTextChars: 5 }));
    const filesRedacted = JSON.stringify(buildOpenRouterChatRequest(runRequest, { redactFiles: true }));
    const imagesRedacted = JSON.stringify(buildOpenRouterChatRequest(runRequest, { redactImages: true }));
    const preview = buildOpenRouterChatRequestPreview(runRequest, {
      maxAttachmentTextChars: 5,
      redactFiles: false,
      redactImages: false
    });
    const previewJson = JSON.stringify(preview);

    expect(actual).toContain("PRIVATE_PDF_BYTES");
    expect(actual).toContain("PRIVATE_IMAGE_BYTES");
    expect(actual).toContain("01234\\n[truncated 5 chars]");
    expect(actual).not.toContain("PDF fallback must not be sent");
    expect(filesRedacted).not.toContain("PRIVATE_PDF_BYTES");
    expect(filesRedacted).toContain("PRIVATE_IMAGE_BYTES");
    expect(imagesRedacted).toContain("PRIVATE_PDF_BYTES");
    expect(imagesRedacted).not.toContain("PRIVATE_IMAGE_BYTES");
    expect(previewJson).not.toContain("PRIVATE_PDF_BYTES");
    expect(previewJson).not.toContain("PRIVATE_IMAGE_BYTES");
    expect(previewJson).toContain("[base64 PDF data omitted]");
    expect(previewJson).toContain("[image data url omitted]");
    expect(preview).toMatchObject({
      provider: "openrouter",
      redactions: ["image_data_url", "pdf_base64"],
      replayedContext: [
        {
          id: "current-user-message",
          role: "user",
          text: "Find one concise fact."
        }
      ]
    });
  });

  it("keeps live missing-payload errors while safe previews remain buildable", () => {
    const base = request();
    const missingPdf = request({
      attachmentIds: ["pdf-missing"],
      attachments: [
        {
          byteSize: 64,
          extractedText: "Unused fallback",
          fileName: "missing.pdf",
          id: "pdf-missing",
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
    const missingImage = request({
      attachmentIds: ["image-missing"],
      attachments: [
        {
          byteSize: 32,
          extractedText: null,
          fileName: "missing.png",
          id: "image-missing",
          kind: "image",
          metadata: {},
          mimeType: "image/png",
          status: "ready"
        }
      ]
    });

    expect(() => buildOpenRouterChatRequest(missingPdf)).toThrow(
      "pdf_attachment_data_unavailable:pdf-missing"
    );
    expect(() => buildOpenRouterChatRequest(missingImage)).toThrow(
      "image_attachment_data_unavailable:image-missing"
    );
    expect(JSON.stringify(buildOpenRouterChatRequestPreview(missingPdf))).toContain(
      "[base64 PDF data omitted]"
    );
    expect(JSON.stringify(buildOpenRouterChatRequestPreview(missingImage))).toContain(
      "[image data url omitted]"
    );
  });

  it("builds a query-only Perplexity request even when a caller defeats the type boundary", () => {
    const search = {
      ...searchRequest(),
      attachmentIds: ["ATTACHMENT_ID_CANARY"],
      attachments: [{
        dataUrl: "data:image/png;base64,ATTACHMENT_BYTES_CANARY",
        extractedText: "ATTACHMENT_TEXT_CANARY",
        fileName: "ATTACHMENT_FILENAME_CANARY"
      }],
      content: { blocks: [{ text: "ORIGINAL_USER_CONTENT_CANARY", type: "text" }] },
      context: { messages: [{ content: "BRANCH_CONTEXT_CANARY" }] },
      prompt: { developer: "DEVELOPER_PROMPT_CANARY", system: "SYSTEM_PROMPT_CANARY" },
      providerToolMessages: [{ content: "TOOL_TRANSCRIPT_CANARY" }]
    } as unknown as ProviderSearchRequest;
    const body = buildOpenRouterPerplexitySearchRequest(search);
    const userMessage = body.messages.at(-1)?.content;

    expect(body).toMatchObject({
      max_completion_tokens: 1024,
      metadata: {
        app: "aiqsa",
        stage: "tool_search",
        strategy: "perplexity-tool-search"
      },
      model: "perplexity/sonar-pro-search",
      provider: {
        allow_fallbacks: true,
        data_collection: "deny",
        order: ["perplexity"],
        require_parameters: false,
        sort: "throughput"
      },
      reasoning: {
        exclude: true
      },
      stream: false
    });
    expect(body).not.toHaveProperty("cache_control");
    expect(userMessage).toContain("Find one concise fact.");
    const serialized = JSON.stringify(body);
    for (const canary of [
      "ATTACHMENT_ID_CANARY",
      "ATTACHMENT_BYTES_CANARY",
      "ATTACHMENT_TEXT_CANARY",
      "ATTACHMENT_FILENAME_CANARY",
      "ORIGINAL_USER_CONTENT_CANARY",
      "BRANCH_CONTEXT_CANARY",
      "DEVELOPER_PROMPT_CANARY",
      "SYSTEM_PROMPT_CANARY",
      "TOOL_TRANSCRIPT_CANARY"
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("returns the stable always-safe Perplexity preview envelope", () => {
    const preview = buildOpenRouterPerplexitySearchRequestPreview(searchRequest());

    expect(preview).toMatchObject({
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
    expect(JSON.stringify(preview)).not.toContain("Find one concise fact.");
  });

  it.each([
    ["server default", searchRequest(), 1024],
    [
      "canonical bounded override",
      searchRequest({
        searchControls: {
          maxOutputTokens: 77
        }
      }),
      77
    ]
  ])("uses the %s Perplexity result cap", (_label, search, expectedMaxTokens) => {
    expect(buildOpenRouterPerplexitySearchRequest(search).max_completion_tokens).toBe(expectedMaxTokens);
  });

  it("accepts only bounded search controls and rejects routing or policy injection", () => {
    const safeBody = buildOpenRouterPerplexitySearchRequest(
      searchRequest({
        searchControls: {
          maxOutputTokens: 2048,
          temperature: 0.5
        }
      })
    );

    expect(safeBody).toMatchObject({
      max_completion_tokens: 2048,
      model: "perplexity/sonar-pro-search",
      provider: {
        data_collection: "deny",
        order: ["perplexity"]
      },
      temperature: 0.5
    });

    for (const search of [
      { max_tokens: 64 },
      { maxOutputTokens: 8193 },
      { provider: { data_collection: "allow" } },
      { reasoning: { exclude: false } }
    ]) {
      expect(() =>
        buildOpenRouterPerplexitySearchRequest(
          searchRequest({ searchControls: search })
        )
      ).toThrow("invalid_run_params");
    }

    expect(() =>
      buildOpenRouterPerplexitySearchRequest(
        searchRequest({
          searchPolicy: {
            ...searchPolicy(),
            strategyId: "untrusted-strategy" as "perplexity-tool-search"
          }
        })
      )
    ).toThrow("openrouter_search_policy_invalid");
  });
});
