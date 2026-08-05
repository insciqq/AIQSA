import { describe, expect, it } from "vitest";
import type { RunTool } from "../tools/types";
import {
  buildGeminiInteractionsRequest,
  buildGeminiInteractionsRequestPreview
} from "./geminiInteractionsRequest";
import type { NormalizedSearchPlanOption, ProviderRunRequest } from "./types";

const tool: RunTool = {
  capability: "mcp",
  description: "Look up one record.",
  inputSchema: {
    additionalProperties: false,
    properties: { id: { type: "string" } },
    required: ["id"],
    type: "object"
  },
  name: "records__lookup",
  strict: true
};

function request(overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "Current question", type: "text" }] },
    context: {
      messages: [
        { content: { blocks: [{ text: "Earlier", type: "text" }] }, id: "u-1", role: "user" },
        { content: { blocks: [{ text: "Earlier answer", type: "text" }] }, id: "a-1", role: "assistant" },
        { content: { blocks: [{ text: "Current question", type: "text" }] }, id: "u-2", role: "user" }
      ],
      mode: "branch_path"
    },
    modelCapabilities: {
      nativePdfInput: true,
      nativeSearch: true,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: true,
      vision: true
    },
    modelId: "gemini-3.6-flash",
    params: {
      maxOutputTokens: 128,
      reasoning: { effort: "high" },
      stream: true
    },
    prompt: {
      developer: "Use the approved tools.",
      presetId: "prompt-1",
      system: "Be precise."
    },
    provider: "gemini",
    searchStrategy: "search-disabled",
    ...overrides
  };
}

function hostedGoogleSearch(): NormalizedSearchPlanOption {
  return {
    adapterKind: "answer_provider_hosted",
    config: {},
    credentialMode: "answer_provider",
    executionModes: ["model_choice"],
    modelId: null,
    optionId: "organization-google-search",
    protocol: "gemini_google_search",
    provider: "gemini",
    providerModelId: null,
    revisionId: "revision-google-hosted",
    searchStrategyRowId: "route-google-hosted"
  };
}

describe("Gemini Interactions request builder", () => {
  it("builds the stable stateless native body with flat function tools", () => {
    expect(buildGeminiInteractionsRequest(request({ tools: [tool] }))).toEqual({
      generation_config: {
        max_output_tokens: 128,
        thinking_level: "high",
        thinking_summaries: "none",
        tool_choice: "auto"
      },
      input: [
        { content: [{ text: "Earlier", type: "text" }], type: "user_input" },
        { content: [{ text: "Earlier answer", type: "text" }], type: "model_output" },
        { content: [{ text: "Current question", type: "text" }], type: "user_input" }
      ],
      model: "gemini-3.6-flash",
      store: false,
      stream: true,
      system_instruction: "Be precise.\n\nDeveloper instructions:\nUse the approved tools.",
      tools: [{
        description: "Look up one record.",
        name: "records__lookup",
        parameters: tool.inputSchema,
        type: "function"
      }]
    });
  });

  it("keeps exact signed thought order through a durable private continuation", () => {
    const persisted = JSON.parse(JSON.stringify([
      { signature: "bounded-private-thought-signature", type: "thought" },
      { content: [{ text: "I will use the tool.", type: "text" }], type: "model_output" },
      {
        arguments: { id: "42" },
        id: "call-1",
        name: tool.name,
        signature: "bounded-private-function-signature",
        type: "function_call"
      },
      { call_id: "call-1", name: tool.name, result: "record 42", type: "function_result" }
    ])) as unknown[];
    const runRequest = request({
      forceNonStreaming: true,
      providerToolMessages: persisted,
      toolChoice: "none",
      tools: [tool]
    });
    const body = buildGeminiInteractionsRequest(runRequest);

    expect(body.input.slice(-4)).toEqual(persisted);
    expect(body.stream).toBe(false);
    expect(body.store).toBe(false);
    expect(buildGeminiInteractionsRequestPreview(runRequest).body.input.slice(-4)).toEqual([
      { type: "thought" },
      { content: [{ text: "I will use the tool.", type: "text" }], type: "model_output" },
      { arguments: { id: "42" }, id: "call-1", name: tool.name, type: "function_call" },
      { call_id: "call-1", name: tool.name, result: "record 42", type: "function_result" }
    ]);
  });

  it("uses native image/PDF payloads only on the wire and redacts the preview", () => {
    const runRequest = request({
      attachmentIds: ["IMAGE_ID_CANARY", "PDF_ID_CANARY", "DOCUMENT_ID_CANARY"],
      attachments: [
        {
          byteSize: 3,
          dataUrl: "data:image/png;base64,QUJD",
          extractedText: null,
          fileName: "IMAGE_FILENAME_CANARY",
          id: "IMAGE_ID_CANARY",
          kind: "image",
          metadata: { remoteUrl: "IMAGE_METADATA_CANARY" },
          mimeType: "image/png",
          status: "ready"
        },
        {
          base64Data: "REVG",
          byteSize: 3,
          extractedText: "UNUSED_PDF_TEXT_CANARY",
          fileName: "PDF_FILENAME_CANARY",
          id: "PDF_ID_CANARY",
          kind: "pdf",
          metadata: { storageKey: "PDF_METADATA_CANARY" },
          mimeType: "application/pdf",
          status: "ready"
        },
        {
          byteSize: 8,
          extractedText: "DOCUMENT_TEXT_CANARY",
          fileName: "DOCUMENT_FILENAME_CANARY",
          id: "DOCUMENT_ID_CANARY",
          kind: "document",
          metadata: { remoteUrl: "DOCUMENT_METADATA_CANARY" },
          mimeType: "text/plain",
          status: "ready"
        }
      ]
    });

    expect(buildGeminiInteractionsRequest(runRequest).input.at(-1)).toMatchObject({
      content: [
        { text: "Current question", type: "text" },
        { data: "QUJD", mime_type: "image/png", type: "image" },
        { data: "REVG", mime_type: "application/pdf", type: "document" },
        { text: expect.stringContaining("DOCUMENT_TEXT_CANARY"), type: "text" }
      ]
    });
    const preview = buildGeminiInteractionsRequestPreview(runRequest);
    const previewJson = JSON.stringify(preview);
    for (const canary of [
      "QUJD",
      "REVG",
      "IMAGE_FILENAME_CANARY",
      "IMAGE_ID_CANARY",
      "IMAGE_METADATA_CANARY",
      "UNUSED_PDF_TEXT_CANARY",
      "PDF_FILENAME_CANARY",
      "PDF_ID_CANARY",
      "PDF_METADATA_CANARY",
      "DOCUMENT_TEXT_CANARY",
      "DOCUMENT_FILENAME_CANARY",
      "DOCUMENT_ID_CANARY",
      "DOCUMENT_METADATA_CANARY"
    ]) {
      expect(previewJson).not.toContain(canary);
    }
    expect(previewJson).toContain("[base64 image data omitted]");
    expect(previewJson).toContain("[base64 PDF data omitted]");
    expect(previewJson).toContain("[Document attachment text omitted]");
    expect(previewJson).toContain("[attachment media type omitted]");
    expect(preview.redactions).toEqual([
      "attachment_base64",
      "attachment_extracted_text",
      "attachment_media_type",
      "grounding_suggestions",
      "provider_signatures"
    ]);
  });

  it("enables only native Google Search and rejects mixed hosted/client tools", () => {
    const body = buildGeminiInteractionsRequest(request({
      searchPlan: { mode: "model_choice", options: [hostedGoogleSearch()] },
      searchStrategy: "organization-google-search"
    }));
    expect(body.tools).toEqual([{ type: "google_search" }]);

    expect(() => buildGeminiInteractionsRequest(request({
      searchPlan: { mode: "model_choice", options: [hostedGoogleSearch()] },
      searchStrategy: "organization-google-search",
      tools: [tool]
    }))).toThrow("gemini_interactions_tool_combination_unsupported");

    expect(buildGeminiInteractionsRequest(request({
      searchPlan: { mode: "all_selected", options: [] },
      searchStrategy: "gemini-google-search"
    }))).not.toHaveProperty("tools");
  });

  it("fails closed instead of dropping malformed continuation records", () => {
    expect(() => buildGeminiInteractionsRequest(request({ providerToolMessages: ["bad"] })))
      .toThrow("gemini_interactions_continuation_invalid");
    expect(() => buildGeminiInteractionsRequest(request({
      providerToolMessages: [{ type: "thought" }],
      tools: [tool]
    }))).toThrow("gemini_interactions_continuation_invalid");
  });
});
