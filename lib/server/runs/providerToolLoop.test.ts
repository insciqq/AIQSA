import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ProviderAdapter, ProviderRunRequest } from "../providers/types";
import { createAnthropicMessagesAdapter, type AnthropicStreamEvent } from "../providers/anthropicMessages";
import { anthropicMessagesToolBridge, openAIResponsesToolBridge } from "../tools/bridges";
import { runProviderToolLoop } from "./providerToolLoop";
import { openRouterMixedTools } from "@/tests/support/openRouterTools";
import { openRouterChatToolBridge } from "../tools/bridges";
import { createOpenRouterChatAdapter } from "../providers/openRouterChat";
import type { RunTool, ToolExecutionResult } from "../tools/types";
import { readToolResultTool } from "../tools/readToolResult";
import { projectObservationForProvider } from "../toolObservations/projection";
import { conversationContextPolicy } from "./contextCompactionContract";
import { prepareCompactedProviderRequest } from "./contextCompactionConsumer";
import { createContextCompactionPublisher } from "./contextCompactionEvents";
import { contextObservationsFromResults } from "./contextCompactionPlanner";
import { applyContextSummaryToRequest } from "./contextCompactionSummarizer";
import type { ProviderToolLoopContinuation } from "./providerToolLoop";

function request(overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "question", type: "text" }] },
    context: { messages: [], mode: "branch_path" },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
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
    searchPlan: { mode: "all_selected", options: [] },
    ...overrides
  };
}

describe("provider tool loop", () => {
  it.each([
    "context_compaction_source_unavailable",
    "context_compaction_summary_failed",
    "context_compaction_summary_invalid",
    "context_compaction_summary_no_progress"
  ])("retains %s from request preparation without dispatching an answer", async (code) => {
    const stream = vi.fn();
    const executeTool = vi.fn();
    const outcome = await runProviderToolLoop({
      adapter: { buildRequestPreview: () => ({}), stream },
      bridge: openRouterChatToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 3, maxToolRounds: 2 },
      executeTool,
      initialRequest: request({ provider: "openrouter" }),
      parallelToolCalls: false,
      prepareRequest: () => { throw Object.assign(new Error("private provider detail"), { code }); },
      tools: []
    });
    expect(outcome).toMatchObject({ status: "failed", toolCalls: 0, failure: { code } });
    expect(JSON.stringify(outcome)).not.toContain("private provider detail");
    expect(stream).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it.each([false, true])("enforces prepared local concurrency %s even when strict routing omits the wire flag", async (parallelToolCalls) => {
    const operations: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const adapter = createOpenRouterChatAdapter({ client: {
      async createChatCompletion(body) {
        bodies.push(body);
        return { id: `response-${bodies.length}`, choices: [{ finish_reason: bodies.length === 1 ? "tool_calls" : "stop", message: {
          content: bodies.length === 1 ? null : "complete",
          ...(bodies.length === 1 ? { tool_calls: ["first", "second"].map((id) => ({ id, type: "function",
            function: { name: "get_session_status", arguments: "{}" } })) } : {})
        } }], usage: { prompt_tokens: 2, completion_tokens: 1 } };
      }
    } });
    const outcome = await runProviderToolLoop({
      adapter, bridge: openRouterChatToolBridge, budgets: { maxConcurrency: 2, maxToolCalls: 3, maxToolRounds: 2 },
      initialRequest: request({ provider: "openrouter" }), parallelToolCalls: true,
      prepareRequest: (round) => ({ ...round, parallelToolCalls }), tools: openRouterMixedTools(),
      persistToolBatch: () => { operations.push("persist"); },
      executeTool: async (call) => {
        operations.push(`start:${call.id}`);
        await Promise.resolve();
        operations.push(`end:${call.id}`);
        return { status: "complete", value: { callId: call.id, name: call.name, status: "complete", content: [{ type: "text", text: "ok" }] } };
      }
    });
    expect(outcome).toMatchObject({ status: "complete", toolCalls: 2 });
    expect(bodies[0]).not.toHaveProperty("parallel_tool_calls");
    expect(operations).toEqual(parallelToolCalls
      ? ["persist", "start:first", "start:second", "end:first", "end:second"]
      : ["persist", "start:first", "end:first", "start:second", "end:second"]);
    expect((bodies[1]?.messages as Record<string, unknown>[]).filter((message) => message.role === "tool").map((message) => message.tool_call_id))
      .toEqual(["first", "second"]);
  });

  it.each(["undiscovered", "duplicate"] as const)("rejects an adversarial %s batch before discovery or other side effects", async (mode) => {
    const executeTool = vi.fn();
    const persistToolBatch = vi.fn();
    const tools: RunTool[] = openRouterMixedTools();
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream() {
        return { finalText: "", finalProviderResponsePreview: {}, usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0 },
          toolCalls: [
            { id: "discover", name: "find_tools", arguments: { goal: "Read the synthetic service" } },
            { id: mode === "duplicate" ? "discover" : "future", name: mode === "duplicate" ? "find_tools" : "mcp_future_tool", arguments: {} }
          ] };
      }
    };
    const outcome = await runProviderToolLoop({ adapter, bridge: openRouterChatToolBridge,
      budgets: { maxConcurrency: 2, maxToolCalls: 3, maxToolRounds: 2 }, executeTool, persistToolBatch,
      initialRequest: request({ provider: "openrouter" }), parallelToolCalls: false, tools });
    expect(outcome).toMatchObject({ status: "failed", toolCalls: 0,
      failure: { code: mode === "duplicate" ? "provider_tool_call_id_duplicate" : "unsupported_tool_call" } });
    if (mode === "undiscovered") {
      expect(outcome).toMatchObject({
        failure: {
          message: expect.stringContaining("mcp_future_tool"),
          toolName: "mcp_future_tool"
        }
      });
    }
    expect(executeTool).not.toHaveBeenCalled();
    expect(persistToolBatch).not.toHaveBeenCalled();
  });

  it("normalizes an original Workspace name to the advertised provider alias", async () => {
    const canonicalName = "mcp_workspace_sandbox_shell_596319da11";
    const requests: ProviderRunRequest[] = [];
    const persistedNames: string[] = [];
    const executedNames: string[] = [];
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(roundRequest) {
        requests.push(roundRequest);
        if (requests.length === 1) {
          return {
            finalProviderResponsePreview: {},
            finalText: "",
            providerResponseId: "response-1",
            providerToolCallMessage: [{
              call_id: "call-shell",
              name: "sandbox_shell",
              type: "function_call"
            }],
            toolCalls: [{ arguments: { command: "pwd" }, id: "call-shell", name: "sandbox_shell" }],
            usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
          };
        }
        return {
          finalProviderResponsePreview: {},
          finalText: "done",
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
        };
      }
    };

    const outcome = await runProviderToolLoop({
      adapter,
      bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 2, maxToolRounds: 2 },
      executeTool: async (call) => {
        executedNames.push(call.name);
        return {
          status: "complete",
          value: {
            callId: call.id,
            content: [{ text: "ok", type: "text" }],
            name: call.name,
            status: "complete"
          }
        };
      },
      initialRequest: request(),
      normalizeToolCallName: (name, advertisedToolNames) =>
        name === "sandbox_shell" && advertisedToolNames.has(canonicalName) ? canonicalName : name,
      parallelToolCalls: false,
      persistToolBatch: ({ calls }) => {
        persistedNames.push(...calls.map((call) => call.name));
      },
      tools: [{ capability: "workspace", description: "Shell", inputSchema: { type: "object" }, name: canonicalName }]
    });

    expect(outcome).toMatchObject({ final: { finalText: "done" }, status: "complete", toolCalls: 1 });
    expect(persistedNames).toEqual([canonicalName]);
    expect(executedNames).toEqual([canonicalName]);
    expect(requests[1]?.providerToolMessages).toEqual([
      { call_id: "call-shell", name: canonicalName, type: "function_call" },
      { call_id: "call-shell", output: "ok", type: "function_call_output" }
    ]);
  });

  it("uses the prepared provider projection for the durable round fence", async () => {
    const fencedContinuations: unknown[] = [];
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(roundRequest) {
        if (!roundRequest.providerToolMessages?.length) {
          return {
            finalProviderResponsePreview: {},
            finalText: "",
            toolCalls: [{ arguments: {}, id: "call-1", name: "alpha" }],
            usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
          };
        }
        return {
          finalProviderResponsePreview: {},
          finalText: "done",
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
        };
      }
    };
    const outcome = await runProviderToolLoop({
      adapter,
      beforeProviderRound: ({ continuation }) => { fencedContinuations.push(continuation); },
      bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 1, maxToolRounds: 2 },
      executeTool: async call => ({ status: "complete" as const, value: {
        callId: call.id,
        content: [{ text: "large settled result", type: "text" as const }],
        name: call.name,
        status: "complete" as const
      } }),
      initialRequest: request({ toolObservationVersion: 1 }),
      parallelToolCalls: false,
      prepareRequest: (roundRequest, round) => round === 2
        ? { ...roundRequest, providerToolMessages: [{ call_id: "call-1", output: "reader reference", type: "function_call_output" }] }
        : roundRequest,
      tools: [{ capability: "mcp", description: "A", inputSchema: { type: "object" }, name: "alpha" }]
    });
    expect(outcome).toMatchObject({ final: { finalText: "done" }, status: "complete" });
    expect(fencedContinuations[1]).toMatchObject({
      providerToolMessages: [{ call_id: "call-1", output: "reader reference", type: "function_call_output" }]
    });
  });

  it("carries a committed summary across tool rounds without restoring the admission history", async () => {
    const requests: ProviderRunRequest[] = [];
    const prepare = vi.fn((roundRequest: ProviderRunRequest) => {
      if (roundRequest.contextCompactionSummary) return roundRequest;
      return {
        ...roundRequest,
        context: { mode: "branch_path" as const, messages: [{
          id: "__context-summary-summary-1", role: "assistant" as const,
          content: { blocks: [{ type: "text" as const, text: "A bounded summary." }] }
        }] },
        contextCompactionSummary: { formatVersion: 1 as const, id: "summary-1", notes: "A bounded summary.",
          sourceDigest: "a".repeat(64), sourceRefs: ["original"] }
      };
    });
    const outcome = await runProviderToolLoop({
      adapter: {
        buildRequestPreview: () => ({}),
        async *stream(roundRequest) {
          requests.push(roundRequest);
          return { finalProviderResponsePreview: {}, finalText: requests.length === 1 ? "" : "done", usage: {},
            ...(requests.length === 1 ? { toolCalls: [{ id: "read-1", name: "alpha", arguments: {} }] } : {}) };
        }
      },
      bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 2, maxToolRounds: 2 },
      executeTool: async call => ({ status: "complete", value: {
        callId: call.id, name: call.name, status: "complete", content: [{ type: "text", text: "exact tool result" }]
      } }),
      initialRequest: request({ context: { mode: "branch_path", messages: [{ id: "original", role: "user",
        content: { blocks: [{ type: "text", text: "Original lengthy history." }] } }] } }),
      parallelToolCalls: false,
      prepareRequest: prepare,
      tools: [{ capability: "mcp", description: "A", inputSchema: { type: "object" }, name: "alpha" }]
    });
    expect(outcome).toMatchObject({ status: "complete", toolCalls: 1 });
    expect(prepare.mock.calls[1]?.[0].contextCompactionSummary?.id).toBe("summary-1");
    expect(requests[1]?.context).toEqual(requests[0]?.context);
    expect(JSON.stringify(requests[1])).not.toContain("Original lengthy history.");
    expect(requests[1]?.providerToolMessages).toMatchObject([
      { type: "function_call", call_id: "read-1", name: "alpha" },
      { type: "function_call_output", call_id: "read-1", output: "exact tool result" }
    ]);
  });

  it("carries a request re-prepared during dispatch into later rounds and the durable continuation", async () => {
    const requests: ProviderRunRequest[] = [];
    const prepared: ProviderRunRequest[] = [];
    const persisted: unknown[] = [];
    const summary = { formatVersion: 1 as const, id: "cs1_dispatched", notes: "Bought after a clarification.",
      sourceDigest: "a".repeat(64), sourceRefs: ["original"] };
    const outcome = await runProviderToolLoop({
      adapter: {
        buildRequestPreview: () => ({}),
        async *stream(roundRequest) {
          requests.push(roundRequest);
          const call = requests.length < 3 ? [{ id: `call-${requests.length}`, name: "alpha", arguments: {} }] : undefined;
          return { finalProviderResponsePreview: {}, finalText: call ? "" : "done", usage: {}, ...(call ? { toolCalls: call } : {}) };
        }
      },
      bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 3, maxToolRounds: 3 },
      // The owner compacted round 2 again while dispatching it: the summary and
      // a masked projection are what the provider actually received.
      dispatchedRequest: ({ request: roundRequest, round }) => round === 2 ? {
        ...roundRequest,
        context: { mode: "branch_path", messages: [{ id: `__context-summary-${summary.id}`, role: "assistant",
          content: { blocks: [{ type: "text", text: summary.notes }] } }] },
        contextCompactionSummary: summary,
        providerToolMessages: roundRequest.providerToolMessages?.map(value =>
          (value as { type?: string }).type === "function_call_output" ? { ...(value as object), output: "reader reference" } : value)
      } : undefined,
      executeTool: async call => ({ status: "complete", value: {
        callId: call.id, name: call.name, status: "complete", content: [{ type: "text", text: `exact ${call.id}` }]
      } }),
      initialRequest: request({ context: { mode: "branch_path", messages: [{ id: "original", role: "user",
        content: { blocks: [{ type: "text", text: "Original lengthy history." }] } }] } }),
      parallelToolCalls: false,
      persistToolBatch: ({ continuation, round }) => { if (round === 2) persisted.push(continuation); },
      prepareRequest: roundRequest => { prepared.push(roundRequest); return roundRequest; },
      tools: [{ capability: "mcp", description: "A", inputSchema: { type: "object" }, name: "alpha" }]
    });
    expect(outcome).toMatchObject({ status: "complete", toolCalls: 2 });
    expect(prepared[2]?.contextCompactionSummary?.id).toBe(summary.id);
    expect(JSON.stringify(requests[2])).not.toContain("Original lengthy history.");
    expect(persisted[0]).toMatchObject({ providerToolMessages: [
      { type: "function_call", call_id: "call-1" },
      { type: "function_call_output", call_id: "call-1", output: "reader reference" },
      { type: "function_call", call_id: "call-2" }
    ] });
    expect(requests[2]?.providerToolMessages).toMatchObject([
      { type: "function_call", call_id: "call-1" },
      { type: "function_call_output", call_id: "call-1", output: "reader reference" },
      { type: "function_call", call_id: "call-2" },
      { type: "function_call_output", call_id: "call-2", output: "exact call-2" }
    ]);
  });

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

  it("requires only the first tool round when preparation requires initial evidence", async () => {
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
          finalText: "grounded answer",
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
        };
      }
    };

    const outcome = await runProviderToolLoop({
      adapter,
      bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 2, maxToolRounds: 2 },
      executeTool: async (call) => ({
        status: "complete",
        value: {
          callId: call.id,
          content: [{ text: "evidence", type: "text" }],
          name: call.name,
          status: "complete"
        }
      }),
      initialRequest: request({ toolChoice: "required" }),
      parallelToolCalls: false,
      tools: [{
        capability: "mcp",
        description: "A",
        inputSchema: { type: "object" },
        name: "alpha"
      }]
    });

    expect(outcome).toMatchObject({ final: { finalText: "grounded answer" }, status: "complete" });
    expect(requests.map((candidate) => candidate.toolChoice)).toEqual(["required", "auto"]);
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
      { cachedInputTokens: null, cacheWriteInputTokens: null, completeness: "complete",
        inputTokens: 7, outputTokens: 3, reasoningTokens: 1, totalTokens: 10 },
      expect.objectContaining({ modelId: "gpt-test", provider: "openai" }),
      { completeness: "terminal", round: 1 }
    );
    expect(outcome).toMatchObject({
      failure: {
        code: "run_result_publication_failed",
        message: expect.stringContaining("application could not publish"),
        stage: "persistence"
      },
      status: "failed"
    });
  });

  it.each([new Error("PRIVATE Authorization Bearer header https://private/?token=secret"), new DOMException("PRIVATE_LOCAL_TIMEOUT", "TimeoutError")])("attributes terminal usage-write failure to persistence and never executes requested tools (%s)", async failure => {
    const dispatch = vi.fn();
    const executeTool = vi.fn();
    const onUsage = vi.fn(() => { throw failure; });
    const adapter: ProviderAdapter = { buildRequestPreview: () => ({}), async *stream() {
      dispatch();
      return { finalProviderResponsePreview: {}, finalText: "", usage: { inputTokens: 7, outputTokens: 3 },
        toolCalls: [{ id: "once", name: "alpha", arguments: {} }] };
    } };
    const outcome = await runProviderToolLoop({ adapter, bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 1, maxToolRounds: 1 }, executeTool,
      initialRequest: request(), onUsage, parallelToolCalls: false,
      tools: [{ capability: "mcp", description: "A", inputSchema: { type: "object" }, name: "alpha" }] });
    expect(outcome).toMatchObject({ status: "failed", failure: { code: "run_usage_persistence_failed", stage: "persistence" } });
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(executeTool).not.toHaveBeenCalled();
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage.mock.calls[0]).toEqual([expect.objectContaining({ inputTokens: 7, outputTokens: 3 }), expect.anything(), { completeness: "terminal", round: 1 }]);
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
      { cachedInputTokens: null, cacheWriteInputTokens: null, completeness: "complete",
        inputTokens: 5, outputTokens: 2, reasoningTokens: 1, totalTokens: 7 },
      expect.objectContaining({ modelId: "gpt-test", provider: "openai" }),
      { completeness: "partial", round: 1 }
    );
    expect(outcome).toMatchObject({
      failure: { message: "Provider round 1 failed.", stage: "provider" },
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
        message: "Provider round 2 failed.",
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
        message: "Provider round 1 failed.",
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

describe("provider tool loop with transcript compaction", () => {
  const writeFile: RunTool = { capability: "workspace", description: "Write a Workspace file.", name: "write_file",
    inputSchema: { properties: { content: { type: "string" }, path: { type: "string" } }, type: "object" } };
  const observed = (id: string): ToolExecutionResult => ({
    callId: id, content: [{ text: `Wrote ${id}`, type: "text" }], name: "write_file", status: "complete",
    observation: { byteSize: 64, checksum: createHash("sha256").update(id).digest("hex"), encoding: "json-utf8-v1",
      handle: `tor1_${createHash("sha256").update(`handle:${id}`).digest("hex").slice(0, 32)}`, maskable: true,
      source: "workspace", sourceTruncated: false, version: 1 }
  });
  function hybrid(): ProviderRunRequest {
    const messages = [{ content: { blocks: [{ text: "Write the files.", type: "text" as const }] }, id: "current", role: "user" as const }];
    return request({ content: messages[0]!.content, context: { messages, mode: "branch_path" },
      contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages, mode: "hybrid" }),
      modelCapabilities: { ...request().modelCapabilities, contextWindow: 16_000, defaultMaxOutputTokens: 1_000, toolCalling: true },
      params: {}, toolObservationVersion: 1 });
  }
  const BUDGET = 13_400;
  const transcriptCalls = (messages: readonly unknown[] | undefined) =>
    (messages ?? []).flatMap((item) => (item as { type?: string }).type === "function_call" ? [(item as { call_id: string }).call_id] : []);

  function harness(rounds: number) {
    const settled: ToolExecutionResult[] = [];
    const summaries: ProviderRunRequest[] = [];
    const summaryAdapter: Pick<ProviderAdapter, "stream"> = { async *stream(next) {
      summaries.push(next);
      const output = JSON.stringify({ notes: `Files written so far (${summaries.length}).`, sourceRefs: [] });
      yield { data: { delta: output }, type: "token" };
      return { finalProviderResponsePreview: {}, finalText: output, usage: { inputTokens: 3, outputTokens: 1 } };
    } };
    const prepareRequest = (roundRequest: ProviderRunRequest) => prepareCompactedProviderRequest({
      bridge: openAIResponsesToolBridge, failure: (code, message) => Object.assign(new Error(message), { code }),
      observations: contextObservationsFromResults(settled),
      publisher: createContextCompactionPublisher(async () => undefined),
      receipts: { claim: async () => undefined, dispatch: async () => undefined, settle: async () => undefined },
      request: roundRequest, signal: new AbortController().signal, summaryAdapter
    });
    const dispatched: ProviderRunRequest[] = [];
    const adapter: ProviderAdapter = { buildRequestPreview: () => ({}), async *stream(roundRequest) {
      dispatched.push(roundRequest);
      const index = Number(transcriptCalls(roundRequest.providerToolMessages).at(-1)?.slice(5) ?? 0) + 1;
      const call = index <= rounds
        ? [{ arguments: { content: `ARGS_${index} ${"w".repeat(6_000)}`, path: `f${index}` }, id: `call-${index}`, name: "write_file" }]
        : undefined;
      return { finalProviderResponsePreview: {}, finalText: call ? "" : "done", usage: { inputTokens: 1, outputTokens: 1 },
        ...(call ? { toolCalls: call } : {}) };
    } };
    const input = {
      adapter, bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: rounds + 1, maxToolRounds: rounds + 1 },
      executeTool: async (call: { id: string }) => {
        const value = observed(call.id);
        settled.push(value);
        return { status: "complete" as const, value };
      },
      parallelToolCalls: false,
      prepareRequest,
      projectToolResultForProvider: projectObservationForProvider,
      tools: [readToolResultTool, writeFile]
    };
    return { dispatched, input, settled, summaries };
  }

  it("dispatches, fences and checkpoints the same reduced transcript, and recovery resumes from it without a second purchase", async () => {
    const live = harness(14);
    const fenced: ProviderToolLoopContinuation[] = [];
    const persisted: ProviderToolLoopContinuation[] = [];
    const outcome = await runProviderToolLoop({ ...live.input, initialRequest: hybrid(),
      beforeProviderRound: ({ continuation }) => { fenced.push(continuation); },
      persistToolBatch: ({ continuation }) => { persisted.push(continuation); } });
    expect(outcome).toMatchObject({ status: "complete", toolCalls: 14 });
    expect(live.summaries.length).toBeGreaterThan(0);
    live.dispatched.forEach((sent, index) => {
      expect(sent.contextCompaction!.afterTokens).toBeLessThanOrEqual(BUDGET);
      // The durable fence and the batch checkpoint hold exactly what was sent.
      expect(fenced[index]!.providerToolMessages).toEqual(sent.providerToolMessages);
      if (index < persisted.length) {
        expect(persisted[index]!.providerToolMessages.slice(0, sent.providerToolMessages!.length)).toEqual(sent.providerToolMessages);
      }
      // Rounds leave oldest first, whole, and a round that left never returns.
      const calls = transcriptCalls(sent.providerToolMessages);
      const first = calls.length ? Number(calls[0]!.slice(5)) : index + 1;
      expect(calls).toEqual(Array.from({ length: index + 1 - first }, (_, offset) => `call-${first + offset}`));
    });
    const reducedRound = live.dispatched.findIndex((sent, index) => index > 0 && !transcriptCalls(sent.providerToolMessages).includes("call-1"));
    expect(reducedRound).toBeGreaterThan(0);
    expect(reducedRound).toBeLessThan(persisted.length);

    // Recovery from the checkpoint of that round: its persisted continuation,
    // the checkpoint summary re-applied and the settled batch result.
    const checkpointSummary = live.dispatched[reducedRound]!.contextCompactionSummary!;
    const recovered = harness(14);
    recovered.settled.push(...live.settled.slice(0, reducedRound + 1));
    const settledCall = live.settled[reducedRound]!;
    await runProviderToolLoop({ ...recovered.input,
      initialRequest: applyContextSummaryToRequest(hybrid(), checkpointSummary),
      resume: {
        continuation: persisted[reducedRound]!,
        previousToolResults: [{ call: { arguments: {}, id: settledCall.callId, name: "write_file" }, ordinal: 0,
          result: { status: "complete", value: settledCall }, round: reducedRound + 1 }],
        progress: { providerRounds: reducedRound + 1, toolCalls: reducedRound + 1, toolRounds: reducedRound + 1 },
        seenCallIds: live.settled.slice(0, reducedRound + 1).map((entry) => entry.callId)
      }
    });
    expect(recovered.dispatched[0]!.providerToolMessages).toEqual(live.dispatched[reducedRound + 1]!.providerToolMessages);
    // The recovered round reuses the checkpoint notes instead of buying them again.
    expect(recovered.dispatched[0]!.contextCompactionSummary?.id).toBe(checkpointSummary.id);
    expect(recovered.dispatched[0]!.contextCompactionSummary?.id).toBe(live.dispatched[reducedRound + 1]!.contextCompactionSummary?.id);
  });
});
