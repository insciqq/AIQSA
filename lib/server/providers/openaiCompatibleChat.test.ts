import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { describe, expect, it, vi } from "vitest";
import {
  createOpenAICompatibleChatAdapter,
  type OpenAICompatibleChatClient
} from "./openaiCompatibleChat";
import type { ProviderRunRequest, ProviderRunResult } from "./types";

function request(overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "Hello", type: "text" }] },
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      vision: false
    },
    modelId: "vendor/model-1",
    params: { maxOutputTokens: 32, stream: false },
    prompt: { developer: null, system: null },
    provider: "custom-connection-1",
    searchStrategy: null,
    ...overrides
  };
}

async function collect(
  stream: AsyncGenerator<ModelRunSseEvent, ProviderRunResult>
): Promise<ProviderRunResult> {
  let next = await stream.next();
  while (!next.done) {
    next = await stream.next();
  }
  return next.value;
}

function sseResponse(): Response {
  return new Response(
    'data: {"id":"stream-1","choices":[{"delta":{"content":"streamed"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } }
  );
}

describe("OpenAI-compatible Chat Completions adapter", () => {
  it("uses bounded JSON transport for non-streaming requests", async () => {
    const createChatCompletion = vi.fn<OpenAICompatibleChatClient["createChatCompletion"]>(
      async () => ({
        choices: [{ message: { content: "json" } }],
        id: "json-1"
      })
    );
    const streamChatCompletion = vi.fn<OpenAICompatibleChatClient["streamChatCompletion"]>();
    const adapter = createOpenAICompatibleChatAdapter({
      client: { createChatCompletion, streamChatCompletion }
    });

    const result = await collect(adapter.stream(request()));

    expect(result.finalText).toBe("json");
    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: "vendor/model-1", stream: false }),
      { signal: undefined }
    );
    expect(createChatCompletion.mock.calls[0]?.[0]).not.toHaveProperty("stream_options");
    expect(streamChatCompletion).not.toHaveBeenCalled();
    expect(adapter.buildRequestPreview(request())).toMatchObject({
      provider: "custom-connection-1",
      replayedContext: [{ id: "current-user-message", role: "user", text: "Hello" }]
    });
  });

  it("uses SSE transport only when streaming is explicitly enabled", async () => {
    const createChatCompletion = vi.fn<OpenAICompatibleChatClient["createChatCompletion"]>();
    const streamChatCompletion = vi.fn<OpenAICompatibleChatClient["streamChatCompletion"]>(
      async () => sseResponse()
    );
    const adapter = createOpenAICompatibleChatAdapter({
      client: { createChatCompletion, streamChatCompletion }
    });

    const baseRequest = request();
    const result = await collect(adapter.stream(request({
      modelCapabilities: {
        ...baseRequest.modelCapabilities,
        streamUsage: true
      },
      params: { stream: true }
    })));

    expect(result.finalText).toBe("streamed");
    expect(streamChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: true,
        stream_options: { include_usage: true }
      }),
      { signal: undefined }
    );
    expect(createChatCompletion).not.toHaveBeenCalled();
  });
});
