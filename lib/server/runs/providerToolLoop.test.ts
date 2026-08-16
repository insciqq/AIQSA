import { describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ProviderAdapter, ProviderRunRequest } from "../providers/types";
import { createAnthropicMessagesAdapter, type AnthropicStreamEvent } from "../providers/anthropicMessages";
import { anthropicMessagesToolBridge, openAIResponsesToolBridge } from "../tools/bridges";
import { runProviderToolLoop } from "./providerToolLoop";

function request(): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "question", type: "text" }] },
    context: { messages: [], mode: "branch_path" },
    knowledgePlan: { baseIds: [] },
    toolMode: "auto",
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: true,
      streaming: true,
      vision: false
    },
    modelId: "gpt-test",
    params: { background: true, stream: true },
    prompt: { developer: null, system: null },
    provider: "openai",
    searchPlan: { mode: "all_selected", options: [] }
  };
}

describe("provider tool loop", () => {
  it("keeps streaming/background request controls while executing an ordered parallel batch", async () => {
    const requests: ProviderRunRequest[] = [];
    const events: ModelRunSseEvent[] = [];
    const signals: string[] = [];
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(roundRequest) {
        requests.push(roundRequest);
        if (requests.length === 1) {
          yield { data: { delta: "draft" }, type: "token" };
          return {
            finalProviderResponsePreview: {},
            finalText: "draft",
            providerResponseId: "response-1",
            providerToolCallMessage: [
              { arguments: "{}", call_id: "call-a", name: "alpha", type: "function_call" },
              { arguments: "{}", call_id: "call-b", name: "beta", type: "function_call" }
            ],
            toolCalls: [
              { arguments: {}, id: "call-a", name: "alpha" },
              { arguments: {}, id: "call-b", name: "beta" }
            ],
            usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
          };
        }
        yield { data: { delta: "final" }, type: "token" };
        return {
          finalProviderResponsePreview: {},
          finalText: "final",
          providerResponseId: "response-2",
          usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0 }
        };
      }
    };
    const executeTool = vi.fn(async (call: { id: string }) => ({
      status: "complete" as const,
      value: {
        callId: call.id,
        content: [{ text: `result:${call.id}`, type: "text" as const }],
        name: call.id === "call-a" ? "alpha" : "beta",
        status: "complete" as const
      }
    }));

    const outcome = await runProviderToolLoop({
      adapter,
      bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 2, maxToolCalls: 4, maxToolRounds: 2 },
      executeTool,
      initialRequest: request(),
      onEvent: (event) => {
        events.push(event);
      },
      onSignal: (signal) => {
        signals.push(signal.type === "text_delta" ? signal.delta : signal.type);
      },
      parallelToolCalls: true,
      tools: [
        { capability: "mcp", description: "A", inputSchema: { type: "object" }, name: "alpha" },
        { capability: "mcp", description: "B", inputSchema: { type: "object" }, name: "beta" }
      ]
    });

    expect(outcome).toMatchObject({ final: { finalText: "final" }, status: "complete", toolCalls: 2 });
    expect(signals).toEqual(["draft", "message_reset", "final"]);
    expect(events).toEqual([]);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ parallelToolCalls: true, toolChoice: "auto" });
    expect(requests[1]?.providerToolMessages).toEqual([
      { arguments: "{}", call_id: "call-a", name: "alpha", type: "function_call" },
      { arguments: "{}", call_id: "call-b", name: "beta", type: "function_call" },
      { call_id: "call-a", output: "result:call-a", type: "function_call_output" },
      { call_id: "call-b", output: "result:call-b", type: "function_call_output" }
    ]);
  });

  it("forces final synthesis after the accepted call budget is used", async () => {
    const requests: ProviderRunRequest[] = [];
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(roundRequest) {
        requests.push(roundRequest);
        if (requests.length === 1) {
          return {
            finalProviderResponsePreview: {},
            finalText: "",
            toolCalls: [{ arguments: {}, id: "call-a", name: "alpha" }],
            usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
          };
        }
        return {
          finalProviderResponsePreview: {},
          finalText: "budgeted answer",
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
        };
      }
    };

    const outcome = await runProviderToolLoop({
      adapter,
      bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 1, maxToolRounds: 8 },
      executeTool: async (call) => ({
        status: "complete",
        value: {
          callId: call.id,
          content: [{ text: "result", type: "text" }],
          name: call.name,
          status: "complete"
        }
      }),
      initialRequest: request(),
      parallelToolCalls: false,
      tools: [{
        capability: "mcp",
        description: "A",
        inputSchema: { type: "object" },
        name: "alpha"
      }]
    });

    expect(outcome).toMatchObject({ final: { finalText: "budgeted answer" }, status: "complete" });
    expect(requests.map((candidate) => candidate.toolChoice)).toEqual(["auto", "none"]);
  });

  it("replays the complete recovered provider transcript without a hidden provider chain", async () => {
    const requests: ProviderRunRequest[] = [];
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(roundRequest) {
        requests.push(roundRequest);
        return {
          finalProviderResponsePreview: {},
          finalText: "continued",
          providerResponseId: "response-2",
          usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0 }
        };
      }
    };

    const outcome = await runProviderToolLoop({
      adapter,
      bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 2, maxToolCalls: 4, maxToolRounds: 2 },
      executeTool: vi.fn(),
      initialRequest: request(),
      parallelToolCalls: true,
      resume: {
        continuation: {
          providerResponseId: "response-1",
          providerToolMessages: [
            { arguments: "{}", call_id: "call-a", name: "alpha", type: "function_call" },
            { call_id: "older-call", output: "older result", type: "function_call_output" }
          ]
        },
        previousToolResults: [
          {
            call: { arguments: {}, id: "call-a", name: "alpha" },
            ordinal: 0,
            result: {
              status: "complete",
              value: {
                callId: "call-a",
                content: [{ text: "current result", type: "text" }],
                name: "alpha",
                status: "complete"
              }
            },
            round: 1
          }
        ],
        progress: { providerRounds: 1, toolCalls: 1, toolRounds: 1 },
        seenCallIds: ["call-a"]
      },
      tools: [
        { capability: "mcp", description: "A", inputSchema: { type: "object" }, name: "alpha" }
      ]
    });

    expect(outcome).toMatchObject({ final: { finalText: "continued" }, status: "complete" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.previousProviderResponseId).toBeUndefined();
    expect(requests[0]?.providerToolMessages).toEqual([
      { arguments: "{}", call_id: "call-a", name: "alpha", type: "function_call" },
      { call_id: "older-call", output: "older result", type: "function_call_output" },
      { call_id: "call-a", output: "current result", type: "function_call_output" }
    ]);
  });

  it("reports terminal-round usage even when provider-id publication stops the round", async () => {
    const operations: string[] = [];
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream() {
        return {
          finalProviderResponsePreview: {},
          finalText: "late result",
          providerResponseId: "response-late",
          usage: { inputTokens: 7, outputTokens: 3, reasoningTokens: 1 }
        };
      }
    };
    const publicationError = Object.assign(new Error("publication stopped"), {
      code: "provider_publication_stopped"
    });
    const onUsage = vi.fn(() => {
      operations.push("usage");
    });

    const outcome = await runProviderToolLoop({
      adapter,
      bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 1, maxToolRounds: 1 },
      executeTool: vi.fn(),
      initialRequest: request(),
      onProviderResult: () => {
        operations.push("publication");
        throw publicationError;
      },
      onUsage,
      parallelToolCalls: false,
      tools: []
    });

    expect(operations).toEqual(["publication", "usage"]);
    expect(onUsage).toHaveBeenCalledWith(
      { inputTokens: 7, outputTokens: 3, reasoningTokens: 1 },
      expect.objectContaining({ modelId: "gpt-test", provider: "openai" }),
      { completeness: "terminal", round: 1 }
    );
    expect(outcome).toMatchObject({
      failure: {
        code: "provider_publication_stopped",
        message: "publication stopped",
        stage: "provider"
      },
      status: "failed"
    });
  });

  it("labels the latest streamed usage as partial when a provider round fails", async () => {
    const onUsage = vi.fn();
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream() {
        yield {
          data: { inputTokens: 5, outputTokens: 2, reasoningTokens: 1, totalTokens: 7 },
          type: "usage" as const
        };
        throw new Error("provider disconnected");
      }
    };

    const outcome = await runProviderToolLoop({
      adapter,
      bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 1, maxToolRounds: 1 },
      executeTool: vi.fn(),
      initialRequest: request(),
      onUsage,
      parallelToolCalls: false,
      tools: []
    });

    expect(onUsage).toHaveBeenCalledWith(
      { inputTokens: 5, outputTokens: 2, reasoningTokens: 1, totalTokens: 7 },
      expect.objectContaining({ modelId: "gpt-test", provider: "openai" }),
      { completeness: "partial", round: 1 }
    );
    expect(outcome).toMatchObject({
      failure: { message: "provider disconnected", stage: "provider" },
      status: "failed"
    });
  });

  it("propagates an Anthropic refusal after a client tool round", async () => {
    let providerRounds = 0;
    const client = {
      async *stream(): AsyncGenerator<AnthropicStreamEvent> {
        providerRounds += 1;
        const values: AnthropicStreamEvent[] = providerRounds === 1
          ? [
              { message: { id: "msg-tool-round" }, type: "message_start" },
              {
                content_block: {
                  id: "toolu-alpha",
                  input: { query: "first" },
                  name: "alpha",
                  type: "tool_use"
                },
                index: 0,
                type: "content_block_start"
              },
              { index: 0, type: "content_block_stop" },
              {
                delta: { stop_reason: "tool_use" },
                type: "message_delta",
                usage: { output_tokens: 1 }
              },
              { type: "message_stop" }
            ]
          : [
              {
                message: {
                  id: "msg-refusal-round",
                  provider_detail: "provider-only refusal explanation",
                  usage: { input_tokens: 2 }
                },
                type: "message_start"
              },
              {
                delta: {
                  provider_detail: "provider-only refusal explanation",
                  stop_reason: "refusal"
                },
                type: "message_delta",
                usage: { output_tokens: 0 }
              },
              { type: "message_stop" }
            ];
        for (const value of values) yield value;
      }
    };
    const executeTool = vi.fn(async () => ({
      status: "complete" as const,
      value: {
        callId: "toolu-alpha",
        content: [{ text: "tool result", type: "text" as const }],
        name: "alpha",
        status: "complete" as const
      }
    }));
    const onProviderResult = vi.fn();
    const initialRequest: ProviderRunRequest = {
      ...request(),
      modelId: "claude-test",
      provider: "anthropic"
    };

    const outcome = await runProviderToolLoop({
      adapter: createAnthropicMessagesAdapter({ client }),
      bridge: anthropicMessagesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 2, maxToolRounds: 2 },
      executeTool,
      initialRequest,
      onProviderResult,
      parallelToolCalls: false,
      tools: [
        { capability: "mcp", description: "A", inputSchema: { type: "object" }, name: "alpha" }
      ]
    });

    expect(outcome).toMatchObject({
      failure: {
        code: "provider_round_failed",
        message: "anthropic_message_refusal",
        round: 2,
        stage: "provider"
      },
      providerRounds: 2,
      status: "failed",
      toolCalls: 1,
      toolRounds: 1
    });
    expect(outcome).not.toHaveProperty("final");
    expect(JSON.stringify(outcome)).not.toContain("provider-only refusal explanation");

    expect(providerRounds).toBe(2);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(onProviderResult).toHaveBeenCalledTimes(1);
  });

  it("does not execute an Anthropic client tool call without a tool_use terminal", async () => {
    const client = {
      async *stream(): AsyncGenerator<AnthropicStreamEvent> {
        yield { message: { id: "msg-invalid-tool-terminal" }, type: "message_start" };
        yield {
          content_block: {
            id: "toolu-alpha",
            input: { query: "must not execute" },
            name: "alpha",
            type: "tool_use"
          },
          index: 0,
          type: "content_block_start"
        };
        yield { index: 0, type: "content_block_stop" };
        yield {
          delta: { stop_reason: "end_turn" },
          type: "message_delta",
          usage: { output_tokens: 1 }
        };
        yield { type: "message_stop" };
      }
    };
    const executeTool = vi.fn();

    const outcome = await runProviderToolLoop({
      adapter: createAnthropicMessagesAdapter({ client }),
      bridge: anthropicMessagesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 1, maxToolRounds: 1 },
      executeTool,
      initialRequest: {
        ...request(),
        modelId: "claude-test",
        provider: "anthropic"
      },
      parallelToolCalls: false,
      tools: [
        { capability: "mcp", description: "A", inputSchema: { type: "object" }, name: "alpha" }
      ]
    });

    expect(outcome).toMatchObject({
      failure: {
        code: "provider_round_failed",
        message: "anthropic_message_terminal_invalid",
        round: 1,
        stage: "provider"
      },
      providerRounds: 1,
      status: "failed",
      toolCalls: 0,
      toolRounds: 0
    });
    expect(executeTool).not.toHaveBeenCalled();
  });
});
