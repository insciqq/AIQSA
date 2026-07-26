import { describe, expect, it } from "vitest";
import type { RunTool } from "../tools/types";
import {
  buildGeminiInteractionsRequest,
  buildGeminiInteractionsRequestPreview
} from "./geminiInteractionsRequest";
import type { ProviderRunRequest } from "./types";

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
      attachments: [
        {
          byteSize: 3,
          dataUrl: "data:image/png;base64,YWJj",
          extractedText: null,
          fileName: "image.png",
          id: "image-1",
          kind: "image",
          metadata: {},
          mimeType: "image/png",
          status: "ready"
        },
        {
          base64Data: "ZGVm",
          byteSize: 3,
          extractedText: null,
          fileName: "file.pdf",
          id: "pdf-1",
          kind: "pdf",
          metadata: {},
          mimeType: "application/pdf",
          status: "ready"
        }
      ]
    });

    expect(buildGeminiInteractionsRequest(runRequest).input.at(-1)).toMatchObject({
      content: [
        { text: "Current question", type: "text" },
        { data: "YWJj", mime_type: "image/png", type: "image" },
        { data: "ZGVm", mime_type: "application/pdf", type: "document" }
      ]
    });
    expect(JSON.stringify(buildGeminiInteractionsRequestPreview(runRequest))).not.toContain("YWJj");
    expect(JSON.stringify(buildGeminiInteractionsRequestPreview(runRequest))).not.toContain("ZGVm");
  });

  it("enables only native Google Search and rejects mixed hosted/client tools", () => {
    const body = buildGeminiInteractionsRequest(request({ searchStrategy: "gemini-google-search" }));
    expect(body.tools).toEqual([{ type: "google_search" }]);

    expect(() => buildGeminiInteractionsRequest(request({
      searchStrategy: "gemini-google-search",
      tools: [tool]
    }))).toThrow("gemini_interactions_tool_combination_unsupported");
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
