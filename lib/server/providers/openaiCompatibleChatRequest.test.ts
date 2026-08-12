import { describe, expect, it } from "vitest";
import type { ProviderRunRequest } from "./types";
import {
  buildOpenAICompatibleChatRequest,
  buildOpenAICompatibleChatRequestPreview
} from "./openaiCompatibleChatRequest";

function request(overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "Current question", type: "text" }] },
    context: {
      messages: [
        {
          content: { blocks: [{ text: "Earlier question", type: "text" }] },
          id: "message-1",
          role: "user"
        },
        {
          content: { blocks: [{ text: "Earlier answer", type: "text" }] },
          id: "message-2",
          role: "assistant"
        },
        {
          content: { blocks: [{ text: "Current question", type: "text" }] },
          id: "message-3",
          role: "user"
        }
      ],
      mode: "branch_path"
    },
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: true,
      reasoning: false,
      toolCalling: true,
      vision: true
    },
    modelId: "vendor/model-1",
    params: {
      cache_control: { type: "ephemeral" },
      maxOutputTokens: 128,
      plugins: [{ id: "file-parser" }],
      provider: { only: ["vendor"] },
      session_id: "must-not-leak",
      stream: true,
      temperature: 0
    },
    previousProviderResponseId: "ignored-provider-state",
    prompt: {
      developer: "Use the supplied tool when needed.",
      system: "Be concise."
    },
    provider: "custom-connection-1",
    searchStrategy: null,
    toolChoice: "auto",
    tools: [
      {
        capability: "mcp",
        description: "Look up a value",
        inputSchema: {
          properties: { query: { type: "string" } },
          required: ["query"],
          type: "object"
        },
        name: "lookup",
        strict: true
      }
    ],
    ...overrides
  };
}

describe("OpenAI-compatible Chat Completions request", () => {
  it("serializes required tool choice", () => {
    expect(buildOpenAICompatibleChatRequest(request({
      toolChoice: "required"
    })).tool_choice).toBe("required");
  });

  it("replays context and emits only the reviewed Chat Completions subset", () => {
    const runRequest = request();
    const body = buildOpenAICompatibleChatRequest(runRequest);
    const preview = buildOpenAICompatibleChatRequestPreview(runRequest);

    expect(body).toEqual({
      max_completion_tokens: 128,
      messages: [
        {
          content: "Be concise.\n\nDeveloper instructions:\nUse the supplied tool when needed.",
          role: "system"
        },
        { content: "Earlier question", role: "user" },
        { content: "Earlier answer", role: "assistant" },
        { content: "Current question", role: "user" }
      ],
      model: "vendor/model-1",
      parallel_tool_calls: false,
      stream: true,
      temperature: 0,
      tool_choice: "auto",
      tools: [
        {
          function: {
            description: "Look up a value",
            name: "lookup",
            parameters: {
              properties: { query: { type: "string" } },
              required: ["query"],
              type: "object"
            },
            strict: true
          },
          type: "function"
        }
      ]
    });

    expect(body).not.toHaveProperty("stream_options");
    expect(preview.body).not.toHaveProperty("stream_options");

    for (const key of ["cache_control", "metadata", "plugins", "provider", "session_id"]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("requests streaming usage only for an explicitly opted-in model", () => {
    const runRequest = request({
      modelCapabilities: {
        ...request().modelCapabilities,
        streamUsage: true
      }
    });
    const body = buildOpenAICompatibleChatRequest(runRequest);
    const preview = buildOpenAICompatibleChatRequestPreview(runRequest);

    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(preview.body.stream_options).toEqual({ include_usage: true });
  });

  it("appends provider tool messages and keeps full manual replay despite a response id", () => {
    const body = buildOpenAICompatibleChatRequest(
      request({
        forceNonStreaming: true,
        providerToolMessages: [
          {
            content: null,
            role: "assistant",
            tool_calls: [
              {
                function: { arguments: '{"query":"one"}', name: "lookup" },
                id: "call-1",
                type: "function"
              }
            ]
          },
          { content: "result", role: "tool", tool_call_id: "call-1" },
          { role: "invalid" }
        ]
      })
    );

    expect(body.stream).toBe(false);
    expect(body).not.toHaveProperty("stream_options");
    expect(body.messages.slice(-2)).toEqual([
      {
        content: null,
        role: "assistant",
        tool_calls: [
          {
            function: { arguments: '{"query":"one"}', name: "lookup" },
            id: "call-1",
            type: "function"
          }
        ]
      },
      { content: "result", role: "tool", tool_call_id: "call-1" }
    ]);
    expect(body.messages).toContainEqual({ content: "Earlier question", role: "user" });
  });

  it("serializes a reviewed compatible reasoning field without adding temperature", () => {
    const body = buildOpenAICompatibleChatRequest(request({
      modelId: "vendor/reasoning-model",
      params: {
        maxOutputTokens: 64,
        reasoning: { effort: "medium" },
        stream: false
      },
      provider: "openai_compatible"
    }));

    expect(body).toMatchObject({
      max_completion_tokens: 64,
      model: "vendor/reasoning-model",
      reasoning_effort: "medium",
      stream: false
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("stream_options");
  });

  it("maps effort and pro mode identically in actual requests and previews", () => {
    const runRequest = request({
      params: {
        maxOutputTokens: 64,
        reasoning: { effort: "max", mode: "pro" },
        stream: false
      },
      provider: "openai_compatible"
    });
    const options = {
      reasoningRequestMapping: {
        effortPath: "reason.effort",
        modePath: "reason.mode"
      }
    } as const;
    const body = buildOpenAICompatibleChatRequest(runRequest, options);
    const preview = buildOpenAICompatibleChatRequestPreview(runRequest, options);

    expect(body).toMatchObject({ reason: { effort: "max", mode: "pro" } });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(preview.body).toMatchObject({ reason: { effort: "max", mode: "pro" } });
    expect(preview.body).not.toHaveProperty("stream_options");
  });

  it("redacts attachment and continuation canaries while preserving transport payloads", () => {
    const runRequest = request({
      attachmentIds: ["IMAGE_ID_CANARY", "DOCUMENT_ID_CANARY"],
      attachments: [
        {
          byteSize: 12,
          dataUrl: "data:image/png;base64,IMAGE_BYTES_CANARY",
          extractedText: null,
          fileName: "IMAGE_FILENAME_CANARY",
          id: "IMAGE_ID_CANARY",
          kind: "image",
          metadata: { remoteUrl: "IMAGE_METADATA_CANARY" },
          mimeType: "image/png",
          status: "ready"
        },
        {
          byteSize: 16,
          extractedText: "DOCUMENT_TEXT_CANARY",
          fileName: "DOCUMENT_FILENAME_CANARY",
          id: "DOCUMENT_ID_CANARY",
          kind: "document",
          metadata: { storageKey: "DOCUMENT_METADATA_CANARY" },
          mimeType: "text/plain",
          status: "ready"
        }
      ],
      providerToolMessages: [
        {
          content: null,
          opaque: "ASSISTANT_OPAQUE_CANARY",
          role: "assistant",
          tool_calls: [{
            function: {
              arguments: "{\"secret\":\"TOOL_ARGUMENT_CANARY\"}",
              name: "lookup",
              signature: "FUNCTION_SIGNATURE_CANARY"
            },
            id: "call-1",
            opaque: "TOOL_CALL_OPAQUE_CANARY",
            type: "function"
          }]
        },
        {
          content: "TOOL_OUTPUT_CANARY",
          opaque: "TOOL_OUTPUT_OPAQUE_CANARY",
          role: "tool",
          tool_call_id: "call-1"
        }
      ]
    });

    const preview = buildOpenAICompatibleChatRequestPreview(runRequest);
    const actual = JSON.stringify(buildOpenAICompatibleChatRequest(runRequest));
    const safe = JSON.stringify(preview);

    for (const canary of [
      "IMAGE_BYTES_CANARY",
      "IMAGE_FILENAME_CANARY",
      "IMAGE_ID_CANARY",
      "IMAGE_METADATA_CANARY",
      "DOCUMENT_TEXT_CANARY",
      "DOCUMENT_FILENAME_CANARY",
      "DOCUMENT_ID_CANARY",
      "DOCUMENT_METADATA_CANARY",
      "ASSISTANT_OPAQUE_CANARY",
      "TOOL_ARGUMENT_CANARY",
      "FUNCTION_SIGNATURE_CANARY",
      "TOOL_CALL_OPAQUE_CANARY",
      "TOOL_OUTPUT_CANARY",
      "TOOL_OUTPUT_OPAQUE_CANARY"
    ]) {
      expect(safe).not.toContain(canary);
    }
    for (const canary of [
      "IMAGE_BYTES_CANARY",
      "DOCUMENT_TEXT_CANARY",
      "DOCUMENT_FILENAME_CANARY",
      "TOOL_ARGUMENT_CANARY",
      "FUNCTION_SIGNATURE_CANARY",
      "TOOL_OUTPUT_CANARY"
    ]) {
      expect(actual).toContain(canary);
    }
    expect(safe).toContain("[image data url omitted]");
    expect(safe).toContain("[Document attachment text omitted]");
    expect(safe).toContain("[tool output omitted]");
    expect(preview.redactions).toEqual([
      "attachment_extracted_text",
      "image_data_url",
      "provider_continuation_opaque_fields"
    ]);
    expect(preview.provider).toBe("custom-connection-1");
    expect(preview.replayedContext.map(({ id }) => id)).toEqual([
      "message-1",
      "message-2",
      "message-3"
    ]);
  });
});
