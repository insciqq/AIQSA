import { describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ProviderAdapter, ProviderRunRequest } from "../providers/types";
import { openAIResponsesToolBridge } from "../tools/bridges";
import { runProviderToolLoop } from "./providerToolLoop";

function request(): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "question", type: "text" }] },
    context: { messages: [], mode: "branch_path" },
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
    searchStrategy: null
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
});
