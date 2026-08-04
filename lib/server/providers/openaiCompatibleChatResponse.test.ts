import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { describe, expect, it } from "vitest";
import type { ProviderRunResult } from "./types";
import {
  streamOpenAICompatibleChatJsonResponse,
  streamOpenAICompatibleChatSseResponse,
  type OpenAICompatibleChatResponseContext
} from "./openaiCompatibleChatResponse";
import { DEFAULT_PROVIDER_STREAM_LIMITS } from "./network";

const responseContext: OpenAICompatibleChatResponseContext = {
  modelId: "vendor/model-1",
  provider: "custom-connection-1"
};

async function collect(
  stream: AsyncGenerator<ModelRunSseEvent, ProviderRunResult>
): Promise<{ events: ModelRunSseEvent[]; result: ProviderRunResult }> {
  const events: ModelRunSseEvent[] = [];
  let next = await stream.next();

  while (!next.done) {
    events.push(next.value);
    next = await stream.next();
  }

  return { events, result: next.value };
}

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      }
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
}

describe("OpenAI-compatible Chat Completions response", () => {
  const remoteSecret = "sk-aiqsa-remote-error-regression-123456789";

  it("normalizes a JSON answer, response id, usage, and safe provider evidence", async () => {
    const normalized = await collect(
      streamOpenAICompatibleChatJsonResponse(
        {
          choices: [{ finish_reason: "stop", message: { content: "Hello" } }],
          id: "completion-1",
          model: "vendor/model-1",
          object: "chat.completion",
          usage: {
            completion_tokens: 5,
            completion_tokens_details: { reasoning_tokens: 2 },
            prompt_tokens: 11,
            prompt_tokens_details: { cached_tokens: 3 },
            total_tokens: 16
          }
        },
        responseContext
      )
    );

    expect(normalized.events).toEqual([
      {
        data: {
          artifactType: "summary",
          payload: {
            model: "vendor/model-1",
            provider: "custom-connection-1",
            responseId: "completion-1",
            stage: "answer"
          }
        },
        type: "artifact"
      },
      { data: { delta: "Hello" }, type: "token" }
    ]);
    expect(normalized.result).toMatchObject({
      finalProviderResponsePreview: {
        finishReason: "stop",
        id: "completion-1",
        provider: "custom-connection-1",
        text: "Hello"
      },
      finalText: "Hello",
      providerResponseId: "completion-1",
      toolCalls: [],
      usage: {
        cachedInputTokens: 3,
        inputTokens: 11,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 16
      }
    });
  });

  it("parses JSON tool calls and preserves the assistant message for replay", async () => {
    const message = {
      content: null,
      role: "assistant",
      tool_calls: [
        {
          function: { arguments: '{"query":"one"}', name: "lookup" },
          id: "call-1",
          type: "function"
        }
      ]
    };
    const normalized = await collect(
      streamOpenAICompatibleChatJsonResponse(
        { choices: [{ finish_reason: "tool_calls", message }], id: "completion-tools" },
        responseContext
      )
    );

    expect(normalized.result.finalText).toBe("");
    expect(normalized.result.providerToolCallMessage).toEqual(message);
    expect(normalized.result.toolCalls).toEqual([
      {
        arguments: { query: "one" },
        id: "call-1",
        name: "lookup",
        raw: message.tool_calls[0]
      }
    ]);
  });

  it("normalizes SSE text, terminal usage, and completion evidence", async () => {
    const normalized = await collect(
      streamOpenAICompatibleChatSseResponse(
        sseResponse([
          'data: {"id":"stream-1","model":"vendor/model-1","choices":[{"delta":{"content":"Hel"}}]}\n\n',
          'data: {"id":"stream-1","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\n',
          "data: [DONE]\n\n"
        ]),
        responseContext
      )
    );

    expect(normalized.events).toEqual([
      {
        data: {
          artifactType: "summary",
          payload: {
            model: "vendor/model-1",
            provider: "custom-connection-1",
            responseId: "stream-1",
            stage: "answer"
          }
        },
        type: "artifact"
      },
      { data: { delta: "Hel" }, type: "token" },
      {
        data: {
          cacheWriteInputTokens: 0,
          cachedInputTokens: 0,
          inputTokens: 7,
          outputTokens: 2,
          reasoningTokens: 0,
          totalTokens: 9
        },
        type: "usage"
      },
      { data: { delta: "lo" }, type: "token" }
    ]);
    expect(normalized.result).toMatchObject({
      finalText: "Hello",
      providerResponseId: "stream-1",
      usage: {
        inputTokens: 7,
        outputTokens: 2,
        reasoningTokens: 0,
        totalTokens: 9
      }
    });
  });

  it("assembles streamed tool-call argument fragments", async () => {
    const normalized = await collect(
      streamOpenAICompatibleChatSseResponse(
        sseResponse([
          'data: {"id":"stream-tools","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-2","type":"function","function":{"name":"lookup","arguments":"{\\"query\\":"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"two\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
          "data: [DONE]\n\n"
        ]),
        responseContext
      )
    );

    expect(normalized.result.toolCalls).toMatchObject([
      { arguments: { query: "two" }, id: "call-2", name: "lookup" }
    ]);
    expect(normalized.result.providerToolCallMessage).toMatchObject({
      content: null,
      role: "assistant",
      tool_calls: [
        {
          function: { arguments: '{"query":"two"}', name: "lookup" },
          id: "call-2",
          type: "function"
        }
      ]
    });
  });

  it("accepts the exact visible-output limit and rejects one character over before yielding it", async () => {
    const exact = await collect(streamOpenAICompatibleChatSseResponse(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        "data: [DONE]\n\n"
      ]),
      responseContext,
      undefined,
      { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 5 }
    ));
    expect(exact.result.finalText).toBe("Hello");

    const overflow = streamOpenAICompatibleChatSseResponse(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"!"}}]}\n\n'
      ]),
      responseContext,
      undefined,
      { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 5 }
    );
    await expect(overflow.next()).resolves.toMatchObject({ value: { type: "artifact" } });
    await expect(overflow.next()).resolves.toMatchObject({ value: { type: "token" } });
    await expect(overflow.next()).rejects.toMatchObject({
      code: "provider_output_too_large",
      maxChars: 5,
      observedChars: 6,
      retainedTextKind: "visible_output"
    });
  });

  it("bounds streamed tool arguments at the exact limit and rejects one character over", async () => {
    const response = (secondFragment: string) => sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"lookup","arguments":"{\\"x\\":"}}]}}]}\n\n',
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
        function: { arguments: secondFragment },
        index: 0
      }] } }] })}\n\n`,
      "data: [DONE]\n\n"
    ]);
    const exact = await collect(streamOpenAICompatibleChatSseResponse(
      response("1}"),
      responseContext,
      undefined,
      { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 7 }
    ));
    expect(exact.result.toolCalls).toMatchObject([{ arguments: { x: 1 } }]);

    await expect(collect(streamOpenAICompatibleChatSseResponse(
      response("10}"),
      responseContext,
      undefined,
      { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 7 }
    ))).rejects.toMatchObject({
      code: "provider_output_too_large",
      maxChars: 7,
      observedChars: 8,
      retainedTextKind: "tool_arguments"
    });

    const structuredResponse = (query: string) => sseResponse([
      `data: ${JSON.stringify({ choices: [{ message: { tool_calls: [{
        function: { arguments: { query }, name: "lookup" },
        id: "call-structured"
      }] } }] })}\n\n`,
      "data: [DONE]\n\n"
    ]);
    await expect(collect(streamOpenAICompatibleChatSseResponse(
      structuredResponse("Hello"),
      responseContext,
      undefined,
      { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 17 }
    ))).resolves.toMatchObject({ result: { toolCalls: [{ arguments: { query: "Hello" } }] } });
    await expect(collect(streamOpenAICompatibleChatSseResponse(
      structuredResponse("Hello!"),
      responseContext,
      undefined,
      { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 17 }
    ))).rejects.toMatchObject({
      code: "provider_output_too_large",
      retainedTextKind: "tool_arguments"
    });
  });

  it("bounds streamed tool ids and names at the protocol limit", async () => {
    const response = (id: string, name: string) => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
        function: { arguments: "{}", name },
        id,
        index: 0
      }] } }] })}\n\n`,
      "data: [DONE]\n\n"
    ]);
    const exact = await collect(streamOpenAICompatibleChatSseResponse(
      response("i".repeat(512), "n".repeat(512)),
      responseContext
    ));
    expect(exact.result.toolCalls).toMatchObject([{
      id: "i".repeat(512),
      name: "n".repeat(512)
    }]);

    await expect(collect(streamOpenAICompatibleChatSseResponse(
      response("i".repeat(513), "lookup"),
      responseContext
    ))).rejects.toThrow("openai_compatible_chat_stream_tool_call_invalid");
    await expect(collect(streamOpenAICompatibleChatSseResponse(
      response("call-1", "n".repeat(513)),
      responseContext
    ))).rejects.toThrow("openai_compatible_chat_stream_tool_call_invalid");
  });

  it("fails closed on malformed, truncated, empty, and untrusted error responses", async () => {
    await expect(
      collect(
        streamOpenAICompatibleChatJsonResponse(
          { choices: [{ message: { content: "" } }] },
          responseContext
        )
      )
    ).rejects.toThrow("openai_compatible_chat_terminal_response_invalid");

    await expect(
      collect(
        streamOpenAICompatibleChatSseResponse(
          sseResponse(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']),
          responseContext
        )
      )
    ).rejects.toThrow("openai_compatible_chat_stream_truncated");

    await expect(
      collect(
        streamOpenAICompatibleChatJsonResponse(
          { error: { message: `${remoteSecret} unavailable` } },
          responseContext
        )
      )
    ).rejects.toThrow("openai_compatible_chat_response_error");

    const streamError = streamOpenAICompatibleChatSseResponse(
      sseResponse([`data: {"error":{"message":"${remoteSecret}"}}\n\n`]),
      responseContext
    );
    let failure: unknown;
    try {
      await streamError.next();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ message: "openai_compatible_chat_stream_error" });
    expect((failure as Error).message).not.toContain(remoteSecret);
  });
});
