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
      presetId: "prompt-1",
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
  it("replays context and emits only the reviewed Chat Completions subset", () => {
    const body = buildOpenAICompatibleChatRequest(request());

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

    for (const key of ["cache_control", "metadata", "plugins", "provider", "session_id"]) {
      expect(body).not.toHaveProperty(key);
    }
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

  it("serializes the reviewed Gemini reasoning field without adding temperature", () => {
    const body = buildOpenAICompatibleChatRequest(request({
      modelId: "gemini-3.6-flash",
      params: {
        maxOutputTokens: 64,
        reasoning: { effort: "medium" },
        stream: false
      },
      provider: "gemini"
    }));

    expect(body).toMatchObject({
      max_completion_tokens: 64,
      model: "gemini-3.6-flash",
      reasoning_effort: "medium",
      stream: false
    });
    expect(body).not.toHaveProperty("temperature");
  });

  it("redacts image data in previews while preserving safe replay evidence", () => {
    const runRequest = request({
      attachmentIds: ["image-1"],
      attachments: [
        {
          byteSize: 12,
          dataUrl: "data:image/png;base64,private",
          extractedText: null,
          fileName: "private.png",
          id: "image-1",
          kind: "image",
          metadata: {},
          mimeType: "image/png",
          status: "ready"
        }
      ]
    });

    const preview = buildOpenAICompatibleChatRequestPreview(runRequest);
    const actual = JSON.stringify(buildOpenAICompatibleChatRequest(runRequest));
    const safe = JSON.stringify(preview);

    expect(actual).toContain("data:image/png;base64,private");
    expect(safe).not.toContain("data:image/png;base64,private");
    expect(safe).toContain("[image data url omitted]");
    expect(preview.provider).toBe("custom-connection-1");
    expect(preview.replayedContext.map(({ id }) => id)).toEqual([
      "message-1",
      "message-2",
      "message-3"
    ]);
  });
});
