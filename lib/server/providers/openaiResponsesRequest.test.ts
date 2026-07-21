import { describe, expect, it } from "vitest";
import { perplexityWebSearchTool } from "../tools/perplexitySearch";
import {
  buildOpenAIResponsesRequest,
  buildOpenAIResponsesRequestPreview,
  type OpenAIResponsesInputMessage
} from "./openaiResponsesRequest";
import type { ProviderAttachment, ProviderRunRequest } from "./types";

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

function attachment(overrides: Partial<ProviderAttachment> = {}): ProviderAttachment {
  return {
    byteSize: 64,
    extractedText: null,
    fileName: "attachment.bin",
    id: "attachment-1",
    kind: "document",
    metadata: {},
    mimeType: "application/octet-stream",
    status: "ready",
    ...overrides
  };
}

function latestInputMessage(body: ReturnType<typeof buildOpenAIResponsesRequest>): OpenAIResponsesInputMessage {
  return body.input.at(-1) as OpenAIResponsesInputMessage;
}

describe("OpenAI Responses request builder", () => {
  it("builds the exact background native-search request and safe preview envelope", () => {
    const runRequest = request();
    const body = buildOpenAIResponsesRequest(runRequest);

    expect(body).toEqual({
      background: true,
      include: ["web_search_call.action.sources"],
      input: [
        {
          content: [
            {
              text: "Find one concise fact.",
              type: "input_text"
            }
          ],
          role: "user"
        }
      ],
      instructions: "You are precise.\n\nDeveloper instructions:\nPrefer verified citations.",
      max_output_tokens: 64,
      metadata: {
        app: "aiqsa",
        context: "manual_context_replay"
      },
      model: "gpt-5.5",
      prompt_cache_key: "aiqsa-chat-eaeb9111b1c6744278e803977dbf25fb",
      prompt_cache_retention: "24h",
      reasoning: {
        effort: "high",
        summary: "concise"
      },
      store: true,
      stream: false,
      temperature: 1,
      tool_choice: "auto",
      tools: [{ type: "web_search" }]
    });
    expect(buildOpenAIResponsesRequestPreview(runRequest)).toEqual({
      body,
      provider: "openai",
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

  it("preserves explicit foreground parameters and omits disabled search fields", () => {
    const body = buildOpenAIResponsesRequest(
      request({
        params: {
          background: false,
          manualContextReplay: false,
          max_output_tokens: 32,
          reasoning: {
            effort: "medium",
            summary: "none"
          },
          store: false,
          stream: true,
          temperature: 0
        },
        searchStrategy: "search-disabled"
      })
    );

    expect(body).toMatchObject({
      background: false,
      max_output_tokens: 32,
      metadata: {
        context: "provider_context"
      },
      reasoning: {
        effort: "medium"
      },
      store: false,
      stream: true,
      temperature: 0
    });
    expect(body.reasoning).not.toHaveProperty("summary");
    expect(body).not.toHaveProperty("include");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("tools");
  });

  it("serializes GPT-5.6 Pro mode, max effort, and the current prompt-cache contract", () => {
    const runRequest = request({
      modelId: "gpt-5.6-sol",
      params: {
        maxOutputTokens: 128,
        reasoning: {
          effort: "max",
          mode: "pro",
          summary: "auto"
        }
      },
      searchStrategy: "search-disabled"
    });
    const body = buildOpenAIResponsesRequest(runRequest);

    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      prompt_cache_options: { ttl: "30m" },
      reasoning: {
        effort: "max",
        mode: "pro",
        summary: "auto"
      }
    });
    expect(body).not.toHaveProperty("prompt_cache_retention");
    expect(buildOpenAIResponsesRequestPreview(runRequest).body).toEqual(body);
  });

  it("forces explicit and custom-tool requests into foreground non-streaming mode", () => {
    const forced = buildOpenAIResponsesRequest(
      request({
        forceNonStreaming: true,
        modelId: "gpt-5.6-luna",
        params: {
          background: true,
          maxOutputTokens: 64,
          reasoning: {
            effort: "none",
            mode: "pro",
            summary: "detailed"
          },
          store: false,
          stream: true
        },
        searchStrategy: "search-disabled"
      })
    );

    expect(forced).toMatchObject({
      background: false,
      reasoning: {
        effort: "none",
        mode: "pro"
      },
      store: false,
      stream: false
    });
    expect(forced.reasoning).not.toHaveProperty("summary");

    const functionCall = {
      arguments: "{\"keyword\":\"latest Anthropic model\"}",
      call_id: "call-search-1",
      name: "search_via_perplexity",
      status: "completed",
      type: "function_call"
    };
    const functionOutput = {
      call_id: "call-search-1",
      output: "Search result text",
      type: "function_call_output"
    };
    const customToolBody = buildOpenAIResponsesRequest(
      request({
        providerToolMessages: [[functionCall, "ignored"], functionOutput, "ignored", [[functionCall]]],
        searchStrategy: "perplexity-tool-search",
        toolChoice: "none",
        tools: [perplexityWebSearchTool]
      })
    );

    expect(customToolBody).toMatchObject({
      background: false,
      parallel_tool_calls: false,
      stream: false,
      tool_choice: "none",
      tools: [
        {
          description: "Search for current or source-backed information from the internet using Perplexity.",
          name: "search_via_perplexity",
          parameters: perplexityWebSearchTool.inputSchema,
          strict: true,
          type: "function"
        }
      ]
    });
    expect(customToolBody.input.slice(1)).toEqual([functionCall, functionOutput]);
    expect(customToolBody).not.toHaveProperty("include");
  });

  it("replays ordered branch roles while using current content for the latest user input", () => {
    const runRequest = request({
      context: {
        messages: [
          {
            content: {
              blocks: [{ text: "First user turn", type: "text" }]
            },
            id: "user-1",
            role: "user"
          },
          {
            content: {
              blocks: [{ text: "First assistant answer", type: "text" }]
            },
            id: "assistant-1",
            role: "assistant"
          },
          {
            content: {
              blocks: [{ text: "Stored current turn", type: "text" }]
            },
            id: "user-2",
            role: "user"
          }
        ],
        mode: "branch_path"
      }
    });
    const body = buildOpenAIResponsesRequest(runRequest);
    const preview = buildOpenAIResponsesRequestPreview(runRequest);

    expect(body.input).toEqual([
      {
        content: [{ text: "First user turn", type: "input_text" }],
        role: "user"
      },
      {
        content: [{ text: "First assistant answer", type: "output_text" }],
        role: "assistant"
      },
      {
        content: [{ text: "Find one concise fact.", type: "input_text" }],
        role: "user"
      }
    ]);
    expect(preview.replayedContext.map(({ id }) => id)).toEqual(["user-1", "assistant-1", "user-2"]);
  });

  it("includes private image data only in actual requests", () => {
    const image = attachment({
      dataUrl: "data:image/png;base64,AAAA",
      fileName: "chart.png",
      id: "image-1",
      kind: "image",
      mimeType: "image/png"
    });
    const runRequest = request({
      attachmentIds: [image.id],
      attachments: [image],
      searchStrategy: "search-disabled"
    });
    const actualJson = JSON.stringify(buildOpenAIResponsesRequest(runRequest));
    const preview = buildOpenAIResponsesRequestPreview(runRequest);
    const previewJson = JSON.stringify(preview);

    expect(actualJson).toContain("data:image/png;base64,AAAA");
    expect(previewJson).toContain("[image data url omitted]");
    expect(previewJson).not.toContain("data:image/png;base64,AAAA");
    expect(preview.redactions).toEqual(["image_data_url", "pdf_base64"]);

    const missingDataRequest = request({
      attachmentIds: [image.id],
      attachments: [{ ...image, dataUrl: undefined }]
    });
    expect(() => buildOpenAIResponsesRequest(missingDataRequest)).toThrow(
      "image_attachment_data_unavailable:image-1"
    );
    expect(JSON.stringify(buildOpenAIResponsesRequestPreview(missingDataRequest))).toContain(
      "[image data url omitted]"
    );
  });

  it("uses native PDF files in actual requests and redacts their bytes in previews", () => {
    const base = request();
    const pdf = attachment({
      base64Data: "JVBERi0xLjQK",
      extractedText: "Extracted PDF fallback text",
      fileName: "brief.pdf",
      id: "pdf-1",
      kind: "pdf",
      mimeType: "application/pdf"
    });
    const runRequest = request({
      attachmentIds: [pdf.id],
      attachments: [pdf],
      modelCapabilities: {
        ...base.modelCapabilities,
        nativePdfInput: true
      }
    });
    const body = buildOpenAIResponsesRequest(runRequest);
    const previewJson = JSON.stringify(buildOpenAIResponsesRequestPreview(runRequest));

    expect(latestInputMessage(body).content).toEqual([
      {
        text: "Find one concise fact.",
        type: "input_text"
      },
      {
        file_data: "data:application/pdf;base64,JVBERi0xLjQK",
        filename: "brief.pdf",
        type: "input_file"
      }
    ]);
    expect(JSON.stringify(body)).not.toContain("Extracted PDF fallback text");
    expect(previewJson).toContain("[base64 PDF data omitted]");
    expect(previewJson).not.toContain("JVBERi0xLjQK");
  });

  it("preserves legacy asymmetric request-builder redaction flags", () => {
    const base = request();
    const image = attachment({
      dataUrl: "data:image/png;base64,PRIVATE_IMAGE",
      fileName: "chart.png",
      id: "image-1",
      kind: "image",
      mimeType: "image/png"
    });
    const pdf = attachment({
      base64Data: "PRIVATE_PDF",
      fileName: "brief.pdf",
      id: "pdf-1",
      kind: "pdf",
      mimeType: "application/pdf"
    });
    const runRequest = request({
      attachmentIds: [image.id, pdf.id],
      attachments: [image, pdf],
      modelCapabilities: {
        ...base.modelCapabilities,
        nativePdfInput: true
      }
    });
    const filesRedacted = JSON.stringify(buildOpenAIResponsesRequest(runRequest, { redactFiles: true }));
    const imagesRedacted = JSON.stringify(buildOpenAIResponsesRequest(runRequest, { redactImages: true }));
    const bothRedacted = JSON.stringify(
      buildOpenAIResponsesRequest(runRequest, { redactFiles: true, redactImages: true })
    );
    const forcedSafePreview = JSON.stringify(
      buildOpenAIResponsesRequestPreview(runRequest, { redactFiles: false, redactImages: false })
    );

    expect(filesRedacted).toContain("data:image/png;base64,PRIVATE_IMAGE");
    expect(filesRedacted).toContain("[base64 PDF data omitted]");
    expect(filesRedacted).not.toContain("PRIVATE_PDF");
    expect(imagesRedacted).toContain("data:application/pdf;base64,PRIVATE_PDF");
    expect(imagesRedacted).toContain("[image data url omitted]");
    expect(imagesRedacted).not.toContain("PRIVATE_IMAGE");
    expect(bothRedacted).not.toContain("PRIVATE_IMAGE");
    expect(bothRedacted).not.toContain("PRIVATE_PDF");
    expect(forcedSafePreview).not.toContain("PRIVATE_IMAGE");
    expect(forcedSafePreview).not.toContain("PRIVATE_PDF");
  });

  it("uses bounded extracted text for document and non-native PDF attachments", () => {
    const document = attachment({
      extractedText: "abcdef",
      fileName: "rows.csv",
      id: "doc-1",
      kind: "document",
      mimeType: "text/csv"
    });
    const pdf = attachment({
      base64Data: "PRIVATE_PDF_BYTES",
      extractedText: "uvwxyz",
      fileName: "brief.pdf",
      id: "pdf-1",
      kind: "pdf",
      mimeType: "application/pdf"
    });
    const body = buildOpenAIResponsesRequest(
      request({
        attachmentIds: [document.id, pdf.id],
        attachments: [document, pdf]
      }),
      { maxAttachmentTextChars: 3 }
    );

    expect(latestInputMessage(body).content).toEqual([
      {
        text: "Find one concise fact.",
        type: "input_text"
      },
      {
        text: "[Attached document: rows.csv (text/csv)]\nabc\n[truncated 3 chars]",
        type: "input_text"
      },
      {
        text: "[Attached PDF: brief.pdf]\nuvw\n[truncated 3 chars]",
        type: "input_text"
      }
    ]);
    expect(JSON.stringify(body)).not.toContain("input_file");
    expect(JSON.stringify(body)).not.toContain("PRIVATE_PDF_BYTES");
  });

  it("keeps an empty input_text block when no usable content remains", () => {
    const body = buildOpenAIResponsesRequest(
      request({
        attachments: [attachment({ extractedText: null })],
        content: {
          blocks: [{ attachmentId: "attachment-1", type: "file" }]
        },
        searchStrategy: "search-disabled"
      })
    );

    expect(latestInputMessage(body).content).toEqual([
      {
        text: "",
        type: "input_text"
      }
    ]);
  });

  it("keeps preview context bounded without exposing the raw chat id", () => {
    const longText = "x".repeat(300);
    const runRequest = request({
      chatId: "private-chat-id",
      content: {
        blocks: [{ text: longText, type: "text" }]
      }
    });
    const preview = buildOpenAIResponsesRequestPreview(runRequest);

    expect(preview.body.prompt_cache_key).toMatch(/^aiqsa-chat-[a-f0-9]{32}$/);
    expect(preview.body.prompt_cache_key).not.toContain("private-chat-id");
    expect(preview.replayedContext[0]?.text).toHaveLength(240);
    expect(preview.replayedContext[0]?.text.endsWith("...")).toBe(true);
    expect(Object.keys(preview).sort()).toEqual(["body", "provider", "redactions", "replayedContext"]);
  });
});
