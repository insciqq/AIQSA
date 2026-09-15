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
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    toolMode: "auto",
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
      system: "Be precise."
    },
    provider: "gemini",
    searchPlan: { mode: "all_selected", options: [] },
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

function expectNoBlankGeminiTextParts(body: Record<string, unknown>): void {
  const input = body.input as Array<{ content?: Array<Record<string, unknown>> }>;

  for (const step of input) {
    for (const part of step.content ?? []) {
      if (part.type === "text") {
        expect(part.text).toEqual(expect.any(String));
        expect((part.text as string).trim()).not.toBe("");
      }
    }
  }
}

describe("Gemini Interactions request builder", () => {
  it("serializes required tool choice", () => {
    expect(buildGeminiInteractionsRequest(request({
      toolChoice: "required",
      tools: [tool]
    })).generation_config.tool_choice).toBe("any");
  });

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
      "attachment_filename",
      "attachment_media_type",
      "grounding_suggestions",
      "selected_skill_instructions",
      "provider_signatures"
    ]);
  });

  it.each(["image", "pdf"] as const)("preserves a large %s payload held in a two-byte string", (kind) => {
    const base64 = Buffer.alloc(16 * 1024 * 1024, 42).toString("base64");
    const mimeType = kind === "image" ? "image/png" : "application/pdf";
    // Slicing away a non-ASCII prefix leaves the same valid Base64 content
    // in V8's two-byte representation, where a whole-payload regex can overflow.
    const payload = kind === "image" ? `data:${mimeType};base64,${base64}` : base64;
    const twoBytePayload = (`\u0100${payload}`).slice(1);
    const attachment = {
      byteSize: 16 * 1024 * 1024,
      extractedText: null,
      fileName: "изображение или документ",
      id: "large-attachment",
      kind,
      metadata: {},
      mimeType,
      status: "ready" as const,
      ...(kind === "image" ? { dataUrl: twoBytePayload } : { base64Data: twoBytePayload })
    };
    const runRequest = request({ attachmentIds: [attachment.id], attachments: [attachment] });
    const body = buildGeminiInteractionsRequest(runRequest);
    const content = body.input.at(-1)?.content as Array<{ data?: string }>;
    expect(content.at(-1)?.data).toBe(base64);
    expect(JSON.stringify(buildGeminiInteractionsRequestPreview(runRequest))).not.toContain(base64);

    const malformed = `${twoBytePayload.slice(0, -4)}AA=A`;
    expect(() => buildGeminiInteractionsRequest(request({ attachments: [{
      ...attachment,
      ...(kind === "image" ? { dataUrl: malformed } : { base64Data: malformed })
    }] }))).toThrow(`${kind}_attachment_data_invalid`);
  });

  it.each(["", "A", "AAAA=", "AA=A", "A===", "====", "AA-_", "AAAA\n", "AAАA"])(
    "rejects malformed attachment Base64 %j", (base64) => {
      for (const kind of ["image", "pdf"] as const) {
        const mimeType = kind === "image" ? "image/png" : "application/pdf";
        const attachment = {
          byteSize: 3, extractedText: null, fileName: "attachment", id: "invalid", kind,
          metadata: {}, mimeType, status: "ready" as const,
          ...(kind === "image" ? { dataUrl: `data:${mimeType};base64,${base64}` } : { base64Data: base64 })
        };
        expect(() => buildGeminiInteractionsRequest(request({ attachments: [attachment] })))
          .toThrow(kind === "pdf" && !base64 ? "pdf_attachment_data_unavailable" : `${kind}_attachment_data_invalid`);
      }
    }
  );

  it.each(["QQ==", "QUI=", "QUJD", "+/8=", "a012"])("preserves valid Base64 alphabet and padding %s", (base64) => {
    for (const kind of ["image", "pdf"] as const) {
      const mimeType = kind === "image" ? "image/png" : "application/pdf";
      const body = buildGeminiInteractionsRequest(request({ attachments: [{
        byteSize: Buffer.from(base64, "base64").length, extractedText: null, fileName: "attachment", id: "valid", kind,
        metadata: {}, mimeType, status: "ready",
        ...(kind === "image" ? { dataUrl: `data:${mimeType};base64,${base64}` } : { base64Data: base64 })
      }] }));
      expect(body.input.at(-1)?.content).toContainEqual({
        data: base64, mime_type: mimeType, type: kind === "image" ? "image" : "document"
      });
    }
  });

  it.each([
    "data:image/jpeg;base64,QUJD",
    "data:image/png;charset=utf-8;base64,QUJD",
    "data:image/png;BASE64,QUJD",
    "https://example.test/image.png",
    "data:image/png,QUJD"
  ])("rejects an image URL with a mismatched type or invalid prefix %s", (dataUrl) => {
    expect(() => buildGeminiInteractionsRequest(request({ attachments: [{
      byteSize: 3, extractedText: null, fileName: "image.png", id: "wrong-type", kind: "image",
      metadata: {}, mimeType: "image/png", status: "ready", dataUrl
    }] }))).toThrow("image_attachment_data_invalid");
  });

  it("uses extracted text without PDF bytes on the fallback route", () => {
    const base = request();
    const body = buildGeminiInteractionsRequest(request({
      attachmentIds: ["pdf-fallback"],
      attachments: [{
        base64Data: "PRIVATE_FALLBACK_PDF_BYTES",
        byteSize: 16,
        extractedText: "PDF_FALLBACK_TEXT",
        fileName: "fallback.pdf",
        id: "pdf-fallback",
        kind: "pdf",
        metadata: {},
        mimeType: "application/pdf",
        status: "ready"
      }],
      modelCapabilities: { ...base.modelCapabilities, nativePdfInput: false }
    }));
    const serialized = JSON.stringify(body);

    expect(serialized).toContain("PDF_FALLBACK_TEXT");
    expect(serialized).not.toContain("PRIVATE_FALLBACK_PDF_BYTES");
    expect(serialized).not.toContain('"mime_type":"application/pdf"');
  });

  it("represents attachment-only history without replaying private attachment data", () => {
    const fileName = "HISTORY_FILENAME_CANARY.txt";
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
                  fileName,
                  storageKey: "HISTORY_STORAGE_KEY_CANARY",
                  type: "file"
                },
                {
                  attachmentId: "HISTORY_UNKNOWN_ID_CANARY",
                  privateValue: "HISTORY_UNKNOWN_PRIVATE_CANARY",
                  type: "unknown"
                }
              ]
            },
            id: "attachment-only-user",
            role: "user"
          },
          {
            content: { blocks: [{ text: "I reviewed the attachments.", type: "text" }] },
            id: "assistant-answer",
            role: "assistant"
          },
          {
            content: { blocks: [{ text: "Answer briefly.", type: "text" }] },
            id: "current-user-message",
            role: "user"
          }
        ],
        mode: "branch_path"
      }
    });
    const body = buildGeminiInteractionsRequest(runRequest);
    const preview = buildGeminiInteractionsRequestPreview(runRequest);
    const bodyJson = JSON.stringify(body);
    const previewJson = JSON.stringify(preview);

    expect(body.input[0]).toEqual({
      content: [{
        text: `[image attachment]\n[file attachment: ${fileName}]\n[attachment]`,
        type: "text"
      }],
      type: "user_input"
    });
    expect(preview.body.input[0]).toEqual({
      content: [{
        text: "[image attachment]\n[file attachment]\n[attachment]",
        type: "text"
      }],
      type: "user_input"
    });
    for (const canary of [
      "HISTORY_IMAGE_ID_CANARY",
      "HISTORY_IMAGE_BYTES_CANARY",
      "HISTORY_IMAGE_MEDIA_TYPE_CANARY",
      "HISTORY_FILE_ID_CANARY",
      "HISTORY_EXTRACTED_TEXT_CANARY",
      "HISTORY_STORAGE_KEY_CANARY",
      "HISTORY_UNKNOWN_ID_CANARY",
      "HISTORY_UNKNOWN_PRIVATE_CANARY"
    ]) {
      expect(bodyJson).not.toContain(canary);
      expect(previewJson).not.toContain(canary);
    }
    expect(bodyJson).toContain(fileName);
    expect(previewJson).not.toContain(fileName);
    expect(preview.redactions).toContain("attachment_filename");
    expectNoBlankGeminiTextParts(body);
    expectNoBlankGeminiTextParts(preview.body);
  });

  it("uses ordered attachment markers when current attachment payloads yield no content", () => {
    const currentContent = {
      blocks: [
        { attachmentId: "document-1", fileName: "blank.txt", type: "file" },
        { attachmentId: "unknown-1", type: "unknown" }
      ]
    };
    const runRequest = request({
      attachmentIds: ["document-1", "unknown-1"],
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
        },
        {
          byteSize: 0,
          extractedText: null,
          fileName: "unknown.bin",
          id: "unknown-1",
          kind: "unknown",
          metadata: {},
          mimeType: "application/octet-stream",
          status: "ready"
        }
      ],
      content: currentContent,
      context: {
        messages: [{ content: currentContent, id: "current-user", role: "user" }],
        mode: "branch_path"
      }
    });
    const body = buildGeminiInteractionsRequest(runRequest);
    const preview = buildGeminiInteractionsRequestPreview(runRequest);

    expect(body.input).toEqual([{
      content: [{ text: "[file attachment: blank.txt]\n[attachment]", type: "text" }],
      type: "user_input"
    }]);
    expect(preview.body.input).toEqual([{
      content: [{ text: "[file attachment]\n[attachment]", type: "text" }],
      type: "user_input"
    }]);
    expectNoBlankGeminiTextParts(body);
    expectNoBlankGeminiTextParts(preview.body);
  });

  it("enables only native Google Search and rejects mixed hosted/client tools", () => {
    const body = buildGeminiInteractionsRequest(request({
      searchPlan: { mode: "model_choice", options: [hostedGoogleSearch()] }
    }));
    expect(body.tools).toEqual([{ type: "google_search" }]);

    expect(() => buildGeminiInteractionsRequest(request({
      searchPlan: { mode: "model_choice", options: [hostedGoogleSearch()] },
      tools: [tool]
    }))).toThrow("gemini_interactions_tool_combination_unsupported");

    expect(buildGeminiInteractionsRequest(request({
      searchPlan: { mode: "all_selected", options: [] }
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
