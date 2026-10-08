import { createGeminiInteractionsAdapter } from "../providers/geminiInteractions";
import type { GeminiInteractionsClient } from "../providers/geminiInteractionsTransport";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ProviderAdapter, ProviderRunRequest } from "../providers/types";
import {
  createAnthropicMessagesAdapter,
  createFetchAnthropicMessagesClient,
  type AnthropicStreamEvent
} from "../providers/anthropicMessages";
import { calculateContextBudgetLimits } from "../../domain/contextBudget";
import { createCompatibleResponsesAdapter } from "../providers/compatibleResponses";
import { compatibleDroppedRoundDecision, createFetchOpenAIResponsesClient } from "../providers/openaiResponsesTransport";
import { sleepWithSignal } from "../providers/providerRetry";
import { providerStreamDrop } from "../providers/streamDrop";
import { anthropicMessagesToolBridge, geminiInteractionsToolBridge, openAIResponsesToolBridge } from "../tools/bridges";
import { runProviderToolLoop, toolSynthesisDecision } from "./providerToolLoop";
import { openRouterMixedTools } from "@/tests/support/openRouterTools";
import { openRouterChatToolBridge } from "../tools/bridges";
import { createOpenRouterChatAdapter } from "../providers/openRouterChat";
import type { RunTool, ToolExecutionResult } from "../tools/types";
import { executeReadToolResult, READ_TOOL_RESULT_NAME, readToolResultTool } from "../tools/readToolResult";
import { projectObservationForProvider } from "../toolObservations/projection";
import { captureMcpObservation, observationReadBudget, observationWholeDeliveryBatches, wholeDeliveryAllowance } from "../toolObservations/sourceAdapters";
import { memoryToolObservations } from "@/tests/support/toolObservations";
import { conversationContextPolicy } from "./contextCompactionContract";
import { prepareCompactedProviderRequest } from "./contextCompactionConsumer";
import { createContextCompactionPublisher } from "./contextCompactionEvents";
import { contextObservationsFromResults, toolTranscriptUnits, unitCoverageRef } from "./contextCompactionPlanner";
import { applyContextSummaryToRequest } from "./contextCompactionSummarizer";
import type { ProviderToolLoopContinuation } from "./providerToolLoop";
import { applyProviderRequestContextBudget, measureSessionContext, observationBatchShare } from "./runContextBudget";

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
  it.each(["success", "miss", "wrong", "failed", "checkpoint", "cancelled"] as const)("bounds a required-tool correction and withholds ungrounded drafts: %s", async (mode) => {
    const requests: ProviderRunRequest[] = [];
    const usageRounds: number[] = [];
    const text: string[] = [];
    const order: string[] = [];
    const controller = new AbortController();
    const executeTool = vi.fn(async (call: { id: string; name: string }, context: { round: number }) => {
      order.push(`execute:${context.round}`);
      return { status: "complete" as const, value: { callId: call.id, name: call.name,
        status: "complete" as const, content: [{ type: "text" as const, text: "evidence" }] } };
    });
    const correction = vi.fn(async () => {
      order.push("checkpoint");
      if (mode === "checkpoint") throw new Error("checkpoint unavailable");
      if (mode === "cancelled") controller.abort();
    });
    const thinking = { type: "reasoning", reasoning_text: "original private reasoning" };
    const adapter: ProviderAdapter = { buildRequestPreview: () => ({}), async *stream(round) {
      requests.push(round);
      const index = requests.length;
      order.push(`provider:${index}`);
      if (mode === "failed" && index === 1) throw new Error("unknown outcome");
      const calls = mode === "wrong" && index === 1
        ? [{ arguments: {}, id: "wrong", name: "beta" }]
        : mode === "success" && index === 2 ? [{ arguments: {}, id: "required", name: "alpha" }] : [];
      const finalText = index === 3 ? "grounded answer" : "unverified draft";
      yield { type: "token", data: { delta: finalText } };
      return { finalText, finalProviderResponsePreview: {}, toolCalls: calls,
        providerToolCallMessage: [thinking, { role: "assistant", content: finalText }],
        usage: { inputTokens: index, outputTokens: 1 } };
    } };
    const outcome = await runProviderToolLoop({ adapter, bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 1, maxToolRounds: 1 }, executeTool,
      initialRequest: request({ forcedToolName: "alpha", toolChoice: "required", params: { reasoning: { effort: "high" } } }),
      onRequiredToolCorrection: correction, onUsage: (_usage, _request, context) => { usageRounds.push(context.round); },
      onSignal: signal => { if (signal.type === "text_delta") text.push(signal.delta); }, parallelToolCalls: false,
      signal: controller.signal,
      tools: ["alpha", "beta"].map(name => ({ name, capability: "mcp" as const, description: name, inputSchema: { type: "object" } }))
    });
    expect(text).toEqual(mode === "success" ? ["grounded answer"] : []);
    expect(executeTool).toHaveBeenCalledTimes(mode === "success" ? 1 : 0);
    expect(requests.map(value => value.params)).toEqual(requests.map(() => ({ reasoning: { effort: "high" } })));
    if (mode === "success" || mode === "miss") {
      expect(requests[1]?.toolChoice).toBe("auto");
      expect(requests[1]?.providerToolMessages).toEqual([thinking, { role: "assistant", content: "unverified draft" },
        { role: "user", content: expect.stringContaining("alpha") }]);
      expect(order.indexOf("checkpoint")).toBeLessThan(order.indexOf("provider:2"));
    }
    if (mode === "success") {
      expect(outcome).toMatchObject({ status: "complete", providerRounds: 3, toolRounds: 1, toolCalls: 1 });
      expect(requests.map(value => value.toolChoice)).toEqual(["required", "auto", "none"]);
      expect(order).toContain("execute:2");
      expect(usageRounds).toEqual([1, 2, 3]);
    } else if (mode === "cancelled") {
      expect(outcome.status).toBe("cancelled");
      expect(requests).toHaveLength(1);
    } else {
      expect(outcome).toMatchObject({ status: "failed", toolCalls: 0,
        failure: { code: mode === "checkpoint" ? "run_result_publication_failed" : mode === "failed" ? "provider_round_failed" : "required_tool_call_missing" } });
      expect(requests).toHaveLength(mode === "miss" ? 2 : 1);
    }
    expect(correction).toHaveBeenCalledTimes(mode === "wrong" || mode === "failed" ? 0 : 1);
  });

  it("retains the required obligation when resuming a claimed corrective round", async () => {
    const stream = vi.fn(async function* () {
      return { finalText: "still no call", finalProviderResponsePreview: {}, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const correction = vi.fn();
    const executeTool = vi.fn();
    const outcome = await runProviderToolLoop({ adapter: { buildRequestPreview: () => ({}), stream },
      bridge: openRouterChatToolBridge, budgets: { maxConcurrency: 1, maxToolCalls: 2, maxToolRounds: 2 },
      executeTool, initialRequest: request({ toolChoice: "required", forcedToolName: "alpha" }),
      parallelToolCalls: false, tools: [{ name: "alpha", capability: "mcp", description: "A", inputSchema: { type: "object" } }],
      onRequiredToolCorrection: correction, resume: { continuation: { providerResponseId: null, providerToolMessages: [], requiredToolCorrection: true },
        progress: { providerRounds: 1, toolRounds: 0, toolCalls: 0 } }
    });
    expect(outcome).toMatchObject({ status: "failed", providerRounds: 2, failure: { code: "required_tool_call_missing" } });
    expect(stream).toHaveBeenCalledOnce();
    expect(executeTool).not.toHaveBeenCalled();
    expect(correction).not.toHaveBeenCalled();
  });

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
            { id: "discover", name: "find_tools", arguments: { query: "Read the synthetic service" } },
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
      initialRequest: request({ forcedToolName: "alpha", toolChoice: "required" }),
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
    // Only the forced round names its tool; the next round cannot inherit it.
    expect(requests.map((candidate) => candidate.forcedToolName)).toEqual(["alpha", undefined]);
    expect(requests[1]).not.toHaveProperty("forcedToolName");
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
      contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages }),
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

describe("context-length rejection rebuild", () => {
  const alpha: RunTool = { capability: "mcp", description: "A", inputSchema: { type: "object" }, name: "alpha" };
  const turn = (id: string, index: number) => ({ content: { blocks: [{ text: `${id} ${"h".repeat(5_000)}`, type: "text" as const }] },
    id, role: index % 2 ? "assistant" as const : "user" as const });
  // About half of a 17,488-token budget: the planner judged every round fitting.
  const branch = [...Array.from({ length: 6 }, (_, index) => turn(`h${index}`, index)),
    { content: { blocks: [{ text: "question", type: "text" as const }] }, id: "current", role: "user" as const }];
  const initial = (overrides: Partial<ProviderRunRequest> = {}) => request({
    context: { messages: branch, mode: "branch_path" },
    contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages: branch }),
    modelCapabilities: { ...request().modelCapabilities, contextWindow: 20_000, defaultMaxOutputTokens: 512, toolCalling: true },
    params: { stream: true },
    toolObservationVersion: 1,
    ...overrides
  });
  const rejection = (counts: Readonly<Record<string, number>> = {}) => Object.assign(new Error("OpenAI request failed with status 400"),
    { code: "provider_context_length_exceeded", status: 400, providerMessage: "PRIVATE_PROVIDER_MESSAGE_CANARY", ...counts });
  const estimate = (value: ProviderRunRequest) =>
    measureSessionContext({ bridge: openAIResponsesToolBridge, request: value }).approximateInputTokens;

  function harness(steps: readonly ("final" | "reject" | "text_reject" | "tool" | "unknown_usage_reject" | "billed_reject")[], input: Readonly<{
    allowContextRebuild?: boolean;
    initialRequest?: ProviderRunRequest;
  }> = {}) {
    const requests: ProviderRunRequest[] = [];
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(roundRequest) {
        requests.push(roundRequest);
        const step = steps[requests.length - 1];
        if (step === "reject") throw rejection();
        // The follow-up executor forwards an unknown partial report for every failed dispatch.
        if (step === "unknown_usage_reject" || step === "billed_reject") {
          yield { data: step === "billed_reject" ? { inputTokens: 900 } : { completeness: "partial" }, type: "usage" };
          throw rejection();
        }
        if (step === "text_reject") {
          yield { data: { delta: "partial" }, type: "token" };
          throw rejection();
        }
        return {
          finalProviderResponsePreview: {},
          finalText: step === "tool" ? "" : "answer",
          ...(step === "tool" ? { toolCalls: [{ arguments: {}, id: `call-${requests.length}`, name: "alpha" }] } : {}),
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
        };
      }
    };
    const prepared: ProviderRunRequest[] = [];
    const executeTool = vi.fn(async (call: { id: string; name: string }) => ({ status: "complete" as const,
      value: { callId: call.id, content: [{ text: "evidence", type: "text" as const }], name: call.name, status: "complete" as const } }));
    const onUsage = vi.fn();
    const beforeProviderRound = vi.fn();
    const run = () => runProviderToolLoop({
      adapter,
      ...(input.allowContextRebuild === false ? {} : { allowContextRebuild: true }),
      beforeProviderRound,
      bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 4, maxToolRounds: 3 },
      executeTool,
      initialRequest: input.initialRequest ?? initial(),
      onUsage: (usage, _request, context) => onUsage(context),
      parallelToolCalls: false,
      // The run's consumer: under a tightened budget it buys notes before any
      // history leaves the rebuilt round.
      prepareRequest: (roundRequest) => {
        prepared.push(roundRequest);
        return prepareCompactedProviderRequest({
          bridge: openAIResponsesToolBridge,
          failure: (code, message) => Object.assign(new Error(message), { code }),
          publisher: createContextCompactionPublisher(async () => undefined),
          receipts: { claim: async () => undefined, dispatch: async () => undefined, settle: async () => undefined },
          request: roundRequest,
          signal: new AbortController().signal,
          summaryAdapter: { async *stream() {
            const output = JSON.stringify({ notes: "Turns h0-h5 discussed the earlier question.", sourceRefs: [] });
            yield { data: { delta: output }, type: "token" as const };
            return { finalProviderResponsePreview: {}, finalText: output, usage: {} };
          } }
        });
      },
      tools: [alpha]
    });
    return { beforeProviderRound, executeTool, onUsage, prepared, requests, run };
  }

  it("rebuilds a rejected round once under a tightened budget and dispatches the smaller request", async () => {
    const loop = harness(["tool", "reject", "final"]);
    const outcome = await loop.run();

    expect(outcome).toMatchObject({ final: { finalText: "answer" }, status: "complete", toolCalls: 1 });
    expect(loop.requests).toHaveLength(3);
    const [, rejected, rebuilt] = loop.requests as [ProviderRunRequest, ProviderRunRequest, ProviderRunRequest];
    const budgetTokens = Math.floor(estimate(rejected) * 0.75);
    expect(rejected).not.toHaveProperty("contextCompactionRebuild");
    expect(rebuilt.contextCompactionRebuild).toEqual({ version: 1, round: 2, budgetTokens });
    expect(rebuilt.context!.messages.length).toBeLessThan(rejected.context!.messages.length);
    expect(estimate(rebuilt)).toBeLessThanOrEqual(budgetTokens);
    // The settled tool result stays; the tool is never executed again.
    expect(JSON.stringify(rebuilt.providerToolMessages)).toContain("evidence");
    expect(loop.executeTool).toHaveBeenCalledOnce();
    // The rejected dispatch invents no usage; the round keeps one terminal record.
    expect(loop.onUsage.mock.calls.map(([context]) => context)).toEqual([
      { completeness: "terminal", round: 1 }, { completeness: "terminal", round: 2 }
    ]);
    expect(loop.beforeProviderRound.mock.calls.map(([value]) => value.round)).toEqual([1, 2]);
    expect(loop.prepared.map((value) => value.contextCompactionRebuild?.round)).toEqual([undefined, undefined, 2]);
  });

  it("fails a second rejection with the precise code and never rebuilds twice in a run", async () => {
    for (const steps of [["tool", "reject", "reject"], ["reject", "tool", "reject"]] as const) {
      const loop = harness(steps);
      const outcome = await loop.run();
      expect(outcome).toMatchObject({ failure: { code: "provider_context_length_exceeded", stage: "provider",
        message: expect.stringContaining("context window (HTTP 400)") }, status: "failed" });
      expect(loop.requests).toHaveLength(3);
      // A rebuilt round's record stays on every later round of the run.
      expect(loop.requests[2]?.contextCompactionRebuild).toEqual(loop.requests[1]?.contextCompactionRebuild ?? expect.anything());
      expect(loop.executeTool).toHaveBeenCalledOnce();
      expect(loop.onUsage.mock.calls.map(([context]) => context.completeness)).toEqual(["terminal"]);
      expect(JSON.stringify(outcome)).not.toContain("PRIVATE_");
    }
  });

  it("rebuilds from the counts a real Anthropic refusal states, past the adapter's lifecycle summary", async () => {
    const requests: ProviderRunRequest[] = [];
    // The production transport classifies the provider's 400 in memory.
    const refusing = createFetchAnthropicMessagesClient({ apiKey: "synthetic", fetchFn: async () => Response.json({ type: "error",
      error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum PRIVATE_PROVIDER_MESSAGE_CANARY" } },
    { status: 400 }) });
    const adapter = createAnthropicMessagesAdapter({ client: { async *stream(body, options) {
      if (requests.length === 1) return yield* refusing.stream(body, options);
      yield { message: { id: "msg-rebuilt", usage: { input_tokens: 5 } }, type: "message_start" };
      yield { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" };
      yield { delta: { text: "answer", type: "text_delta" }, index: 0, type: "content_block_delta" };
      yield { index: 0, type: "content_block_stop" };
      yield { delta: { stop_reason: "end_turn" }, type: "message_delta", usage: { output_tokens: 1 } };
      yield { type: "message_stop" };
    } } });
    const recording: ProviderAdapter = { buildRequestPreview: adapter.buildRequestPreview,
      stream: (roundRequest, options) => { requests.push(roundRequest); return adapter.stream(roundRequest, options); } };
    const onEvent = vi.fn();
    const outcome = await runProviderToolLoop({
      adapter: recording, allowContextRebuild: true, bridge: anthropicMessagesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 2, maxToolRounds: 2 }, executeTool: vi.fn(),
      initialRequest: initial({ modelId: "claude-test", params: { maxTokens: 512, stream: true, thinking: { enabled: false } },
        provider: "anthropic" }),
      onEvent, parallelToolCalls: false,
      prepareRequest: (roundRequest) => {
        const budgeted = applyProviderRequestContextBudget({ bridge: anthropicMessagesToolBridge, request: roundRequest });
        if (!budgeted.ok) throw Object.assign(new Error(budgeted.error.message), { code: budgeted.error.code });
        return budgeted.request;
      },
      tools: [alpha]
    });
    expect(outcome).toMatchObject({ final: { finalText: "answer" }, status: "complete" });
    expect(requests).toHaveLength(2);
    const reported = calculateContextBudgetLimits({ contextWindow: 200_000, maxOutputTokens: 512, provider: "anthropic" }).budgetTokens;
    const requestTokens = measureSessionContext({ bridge: anthropicMessagesToolBridge, request: requests[0]! }).approximateInputTokens;
    expect(requests[1]?.contextCompactionRebuild).toEqual({ version: 1, round: 1,
      budgetTokens: Math.floor(reported * requestTokens / 250_000) });
    // Its lifecycle summary reached the owner before the refusal and is no answer output.
    expect(onEvent.mock.calls.filter(([event]) => event.type === "artifact" && event.data.artifactType === "summary").length)
      .toBeGreaterThan(1);
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_");
  });

  it("rebuilds after a compatible Responses stream fails with context_length_exceeded before any output", async () => {
    let posts = 0;
    const sse = (events: readonly Record<string, unknown>[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""), { headers: { "content-type": "text/event-stream" } });
    const adapter = createCompatibleResponsesAdapter({ client: {
      cancel: vi.fn(), create: vi.fn(), retrieve: vi.fn(),
      async stream() {
        posts += 1;
        return posts === 1
          // A refusal delivered in the stream: created, then failed without usage or output.
          ? sse([{ response: { id: "resp-refused", status: "in_progress" }, type: "response.created" },
            { response: { error: { code: "context_length_exceeded", message: "PRIVATE_PROVIDER_MESSAGE_CANARY" }, id: "resp-refused",
              output: [], status: "failed", usage: null }, type: "response.failed" }])
          : sse([{ response: { id: "resp-rebuilt", status: "in_progress" }, type: "response.created" },
            { delta: "answer", type: "response.output_text.delta" },
            { response: { id: "resp-rebuilt", output: [{ content: [{ text: "answer", type: "output_text" }], role: "assistant",
              type: "message" }], status: "completed", usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } },
            type: "response.completed" }]);
      }
    } });
    const dispatched: ProviderRunRequest[] = [];
    const outcome = await runProviderToolLoop({
      adapter: { buildRequestPreview: adapter.buildRequestPreview,
        stream: (roundRequest, options) => { dispatched.push(roundRequest); return adapter.stream(roundRequest, options); } },
      allowContextRebuild: true, bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 2, maxToolRounds: 2 }, executeTool: vi.fn(),
      initialRequest: initial({ provider: "openai-compatible" }), parallelToolCalls: false,
      prepareRequest: (roundRequest) => {
        const budgeted = applyProviderRequestContextBudget({ bridge: openAIResponsesToolBridge, request: roundRequest });
        if (!budgeted.ok) throw Object.assign(new Error(budgeted.error.message), { code: budgeted.error.code });
        return budgeted.request;
      },
      tools: [alpha]
    });
    expect(outcome).toMatchObject({ final: { finalText: "answer" }, status: "complete" });
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]?.contextCompactionRebuild).toEqual({ version: 1, round: 1,
      budgetTokens: Math.floor(estimate(dispatched[0]!) * 0.75) });
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_");
  });

  it("fails a compatible dispatch lost after delivery as unknown, keeping its usage unknown and never rebuilding", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => { throw new TypeError("synthetic connection lost after dispatch"); });
    const adapter = createCompatibleResponsesAdapter({ client: createFetchOpenAIResponsesClient({ apiKey: "synthetic",
      baseUrl: "https://lb.example.test/v1", fetchFn, initialRequestRetry: { maxAttempts: 3, sleep: async () => undefined },
      requestIsolation: true }) });
    const dispatched: ProviderRunRequest[] = [];
    const onUsage = vi.fn();
    const outcome = await runProviderToolLoop({
      adapter: { buildRequestPreview: adapter.buildRequestPreview,
        stream: (roundRequest, options) => { dispatched.push(roundRequest); return adapter.stream(roundRequest, options); } },
      allowContextRebuild: true, bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 2, maxToolRounds: 2 }, executeTool: vi.fn(),
      initialRequest: initial({ provider: "openai-compatible" }),
      onUsage: (usage, _request, context) => onUsage(usage, context), parallelToolCalls: false,
      prepareRequest: (roundRequest) => {
        const budgeted = applyProviderRequestContextBudget({ bridge: openAIResponsesToolBridge, request: roundRequest });
        if (!budgeted.ok) throw Object.assign(new Error(budgeted.error.message), { code: budgeted.error.code });
        return budgeted.request;
      },
      tools: [alpha]
    });
    expect(outcome).toMatchObject({ status: "failed", failure: { code: "provider_request_outcome_unknown", stage: "provider",
      message: expect.stringMatching(/outcome and any provider charge are unknown/u) } });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(dispatched).toHaveLength(1);
    // The dispatched round keeps a partial record without invented counts.
    expect(onUsage.mock.calls).toEqual([[{}, { completeness: "partial", round: 1 }]]);
  });

  it("fails with the provider's refusal when the tightened budget cannot hold the irreducible request", async () => {
    // Nearly all of the estimate is the current message, which never leaves.
    const loop = harness(["reject", "final"], { initialRequest: initial({ context: { messages: [turn("h0", 0), turn("h1", 1),
      { content: { blocks: [{ text: "h".repeat(40_000), type: "text" }] }, id: "current", role: "user" }], mode: "branch_path" } }) });
    const outcome = await loop.run();
    expect(outcome).toMatchObject({ failure: { code: "provider_context_length_exceeded", stage: "provider" }, status: "failed" });
    expect(loop.requests).toHaveLength(1);
    expect(loop.prepared).toHaveLength(2);
    expect(loop.prepared[1]?.contextCompactionRebuild).toMatchObject({ round: 1 });
    expect(loop.onUsage).not.toHaveBeenCalled();
  });

  it("treats an unknown usage report as unpaid but never rebuilds a round that billed", async () => {
    const unknown = harness(["unknown_usage_reject", "final"]);
    expect(await unknown.run()).toMatchObject({ final: { finalText: "answer" }, status: "complete" });
    expect(unknown.requests).toHaveLength(2);
    expect(unknown.onUsage.mock.calls.map(([context]) => context)).toEqual([{ completeness: "terminal", round: 1 }]);

    const billed = harness(["billed_reject", "final"]);
    expect(await billed.run()).toMatchObject({ failure: { code: "provider_context_length_exceeded" }, status: "failed" });
    expect(billed.requests).toHaveLength(1);
    expect(billed.onUsage.mock.calls.map(([context]) => context)).toEqual([{ completeness: "partial", round: 1 }]);
  });

  it("never rebuilds after accepted output, without the owner's opt-in or outside v1", async () => {
    const emitted = harness(["text_reject"]);
    expect(await emitted.run()).toMatchObject({ failure: { code: "provider_context_length_exceeded" }, status: "failed" });
    expect(emitted.requests).toHaveLength(1);
    // Output reached the user: the round is paid evidence, not an unpaid refusal.
    expect(emitted.onUsage.mock.calls.map(([context]) => context)).toEqual([{ completeness: "partial", round: 1 }]);

    for (const loop of [harness(["reject", "final"], { allowContextRebuild: false }),
      harness(["reject", "final"], { initialRequest: initial({ toolObservationVersion: 0 }) })]) {
      expect(await loop.run()).toMatchObject({ failure: { code: "provider_context_length_exceeded" }, status: "failed" });
      expect(loop.requests).toHaveLength(1);
      expect(loop.onUsage).not.toHaveBeenCalled();
    }
  });
});

it("continues after a tool when store:false omits created metadata, without replaying the action", async () => {
  const response = (created: Record<string, unknown>, completed: Record<string, unknown>) => new Response([
    `event: interaction.created\ndata: ${JSON.stringify({ event_type: "interaction.created", interaction: created })}\n\n`,
    `event: interaction.status_update\ndata: ${JSON.stringify({ event_type: "interaction.status_update", interaction_id: created.id, status: "in_progress" })}\n\n`,
    `event: interaction.completed\ndata: ${JSON.stringify({ event_type: "interaction.completed", interaction: completed })}\n\n`,
    "event: done\ndata: [DONE]\n\n"
  ].join(""), { headers: { "content-type": "text/event-stream" } });
  const signedCall = { type: "function_call", id: "call-1", name: "lookup_note",
    arguments: {}, signature: "synthetic-private-signature" };
  const streamInteraction = vi.fn<GeminiInteractionsClient["streamInteraction"]>()
    .mockResolvedValueOnce(response({ id: "", status: "in_progress" }, {
      id: "", status: "requires_action", steps: [signedCall]
    }))
    .mockResolvedValueOnce(response({ object: "interaction", model: "gemini-3.8-flash" }, {
      status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }] }]
    }));
  const executeTool = vi.fn(async () => ({ status: "complete" as const, value: {
    callId: "call-1", name: "lookup_note", status: "complete" as const,
    content: [{ type: "text" as const, text: "Synthetic note" }]
  } }));
  const outcome = await runProviderToolLoop({
    adapter: createGeminiInteractionsAdapter({ client: { streamInteraction, createInteraction: vi.fn() } }),
    bridge: geminiInteractionsToolBridge,
    budgets: { maxConcurrency: 1, maxToolCalls: 1, maxToolRounds: 2,
      providerRoundTimeoutMs: 5000, toolCallTimeoutMs: 1000 },
    executeTool, initialRequest: request({ provider: "gemini", modelId: "gemini-3.8-flash", params: { stream: true } }), parallelToolCalls: false,
    tools: [{ capability: "mcp", name: "lookup_note", description: "Read a synthetic note",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } }]
  });
  expect(outcome).toMatchObject({ status: "complete", providerRounds: 2, final: { finalText: "ok" } });
  expect(executeTool).toHaveBeenCalledOnce();
  expect(streamInteraction).toHaveBeenCalledTimes(2);
  const continuation = streamInteraction.mock.calls[1]![0];
  expect(continuation).toMatchObject({ store: false, stream: true });
  expect(continuation).not.toHaveProperty("previous_interaction_id");
  expect(continuation.input).toEqual(expect.arrayContaining([signedCall,
    expect.objectContaining({ type: "function_result", call_id: "call-1" })]));
});

/**
 * Synthetic reproduction of the incident class: a run that reads about fifty
 * large tool results (structured JSON, plain text, errors, a few results the
 * store did not retain) and recalls earlier ones under context pressure.
 * Neutral fake tools; no provider, server or tool name is special.
 */
describe("synthetic many-result recall scenario", () => {
  const OBJECTS = 50;
  const tool = (name: string, description: string): RunTool => ({ capability: "mcp", description, inputSchema: { type: "object" }, name });
  const listTool = tool("mcp_objects_list", "List the objects.");
  const fetchTool = tool("mcp_objects_fetch", "Fetch one object.");
  const peekTool = tool("mcp_objects_peek", "Peek at one object.");
  const binding = { version: 1 as const, source: "mcp" as const, serverId: "objects-server", originalName: "objects",
    revisionId: "objects-revision", fingerprint: "a".repeat(64) };
  const filler = (seed: string, chars: number) => Array.from({ length: Math.ceil(chars / 64) }, (_, index) =>
    createHash("sha256").update(`${seed}:${index}`).digest("hex")).join("").slice(0, chars);
  const original = (index: number) => {
    const chars = 2_000 + (index * 977) % 6_000;
    const text = index % 2 === 0
      ? JSON.stringify({ id: `object-${index}`, marker: `OBJECT_${index}_FACT`, status: index % 3 ? "open" : "answered",
        comments: filler(`object-${index}`, chars) })
      : `OBJECT_${index}_FACT plain status ${index % 3 ? "open" : "answered"} ${filler(`object-${index}`, chars)}`;
    return { isError: index % 9 === 0, structuredContent: null, text: [text], unsupportedContentTypes: [] };
  };
  /** The scripted model: list, fetch every object, recall a few earlier ones
   * through the reader, peek at some (results the store did not retain), answer. */
  type Step = Readonly<{ name: string; arguments: Record<string, unknown> }>;
  const PEEKS = new Set([3, 17, 29, 41, 47]);
  const RECALLS = new Set([12, 24, 36, 48]);

  function scenario() {
    const observations = memoryToolObservations();
    const actor = { runId: "synthetic-run", userId: "synthetic-owner" };
    const settled: ToolExecutionResult[] = [];
    const handles = new Map<number, string>();
    const log: Array<Readonly<{ kind: "answer"; request: ProviderRunRequest }> | Readonly<{ kind: "summary"; request: ProviderRunRequest }>> = [];
    const steps: Step[] = [{ arguments: {}, name: listTool.name }];
    for (let index = 1; index <= OBJECTS; index += 1) {
      steps.push({ arguments: { id: `object-${index}` }, name: fetchTool.name });
      if (PEEKS.has(index)) steps.push({ arguments: { id: `object-${index}` }, name: peekTool.name });
      if (RECALLS.has(index)) steps.push({ arguments: { recall: index - 8 }, name: READ_TOOL_RESULT_NAME });
    }
    const summaryAdapter: Pick<ProviderAdapter, "stream"> = { async *stream(next) {
      log.push({ kind: "summary", request: next });
      const body = (next.content.blocks[0] as { text: string }).text;
      const facts = [...new Set(body.match(/OBJECT_[A-Z0-9]+_FACT/gu) ?? [])];
      const output = JSON.stringify({ notes: `Processed: ${facts.join(", ") || "none"}. Remaining objects follow.`, sourceRefs: [] });
      yield { data: { delta: output }, type: "token" };
      return { finalProviderResponsePreview: {}, finalText: output, usage: { inputTokens: 3, outputTokens: 1 } };
    } };
    let step = 0;
    const adapter: ProviderAdapter = { buildRequestPreview: () => ({}), async *stream(roundRequest) {
      log.push({ kind: "answer", request: roundRequest });
      const next = steps[step];
      step += 1;
      if (!next) return { finalProviderResponsePreview: {}, finalText: "All objects reviewed.", usage: { inputTokens: 1, outputTokens: 1 } };
      const args = next.name === READ_TOOL_RESULT_NAME
        ? { handle: handles.get(Number(next.arguments.recall))!, maxBytes: 2_000, offset: 0 } : next.arguments;
      return { finalProviderResponsePreview: {}, finalText: "", usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: [{ arguments: args, id: `call-${step}`, name: next.name }] };
    } };
    const executeTool = async (call: { arguments: Record<string, unknown>; id: string; name: string }) => {
      let value: ToolExecutionResult;
      if (call.name === READ_TOOL_RESULT_NAME) {
        value = await executeReadToolResult(observations.service(), { arguments: call.arguments, id: call.id, name: call.name }, actor);
      } else if (call.name === peekTool.name) {
        // Delivered without a server observation (degraded or unretained).
        value = { callId: call.id, content: [{ text: `PEEK_${String(call.arguments.id)} small preview`, type: "text" }],
          name: call.name, status: "complete" };
      } else {
        const index = call.name === listTool.name ? 0 : Number(String(call.arguments.id).slice("object-".length));
        value = await captureMcpObservation({ service: observations.service(), producer: { ...actor, toolCallId: call.id },
          wholeDelivery: wholeDeliveryAllowance(Number.POSITIVE_INFINITY) },
        { arguments: call.arguments, id: call.id, name: call.name }, binding, async () => index === 0
          ? { isError: false, structuredContent: null, unsupportedContentTypes: [],
            text: [`OBJECT_LIST_FACT ${Array.from({ length: OBJECTS }, (_, item) => `object-${item + 1}`).join(" ")}`] }
          : original(index));
        if (index > 0 && value.observation) handles.set(index, value.observation.handle);
      }
      settled.push(value);
      return { status: "complete" as const, value };
    };
    const messages = [{ content: { blocks: [{ text: "Review every object and list which comments still wait for an answer.",
      type: "text" as const }] }, id: "current", role: "user" as const }];
    const initialRequest = request({ content: messages[0]!.content, context: { messages, mode: "branch_path" },
      contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages }),
      modelCapabilities: { ...request().modelCapabilities, contextWindow: 16_000, defaultMaxOutputTokens: 1_000, toolCalling: true },
      params: {}, toolObservationVersion: 1 });
    const run = () => runProviderToolLoop({
      adapter, bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 320, maxToolRounds: 160 },
      executeTool, initialRequest, parallelToolCalls: false,
      prepareRequest: (roundRequest) => prepareCompactedProviderRequest({
        bridge: openAIResponsesToolBridge, failure: (code, message) => Object.assign(new Error(message), { code }),
        observations: contextObservationsFromResults(settled),
        publisher: createContextCompactionPublisher(async () => undefined),
        receipts: { claim: async () => undefined, dispatch: async () => undefined, settle: async () => undefined },
        request: roundRequest, signal: new AbortController().signal, summaryAdapter
      }),
      projectToolResultForProvider: projectObservationForProvider,
      tools: [readToolResultTool, listTool, fetchTool, peekTool]
    });
    return { log, run, steps };
  }

  const key = (unit: { callIds: readonly string[] }) => unit.callIds.join(",");
  const unitText = (request: ProviderRunRequest, unit: { start: number; end: number }) =>
    JSON.stringify((request.providerToolMessages ?? []).slice(unit.start, unit.end));
  const markerOf = (text: string) => /OBJECT_[A-Z0-9]+_FACT/u.exec(text)?.[0] ?? null;

  it("finishes with an answer, and nothing leaves or is masked before committed notes read it whole", async () => {
    const { log, run, steps } = scenario();
    const outcome = await run();
    expect(outcome).toMatchObject({ final: { finalText: "All objects reviewed." }, status: "complete", toolCalls: steps.length });
    const answers = log.flatMap((entry) => entry.kind === "answer" ? [entry.request] : []);
    const summaries = log.filter((entry) => entry.kind === "summary");
    expect(summaries.length).toBeGreaterThan(0);
    // Every dispatched round fits its budget.
    for (const sent of answers) expect(sent.contextCompaction!.afterTokens).toBeLessThanOrEqual(sent.contextCompaction!.budgetTokens!);

    /** The text a unit first reached the model with, unmasked, by its call ids. */
    const firstSeen = new Map<string, string>();
    /** How each unit last reached the model: exact, masked, or gone. */
    const state = new Map<string, "exact" | "gone" | "masked">();
    let released = 0;
    let masked = 0;
    for (let round = 0; round < answers.length; round += 1) {
      const current = answers[round]!;
      const position = log.findIndex((entry) => entry.kind === "answer" && entry.request === current);
      const readBefore = log.slice(0, position).flatMap((entry) => entry.kind === "summary"
        ? [(entry.request.content.blocks[0] as { text: string }).text] : []).join("\n");
      const units = toolTranscriptUnits(current.providerToolMessages ?? []).filter((unit) => unit.settled);
      const present = new Map(units.map((unit) => [key(unit), unit]));
      for (const unit of units) if (!firstSeen.has(key(unit))) firstSeen.set(key(unit), unitText(current, unit));
      const refs = new Set(current.contextCompactionSummary?.sourceRefs ?? []);
      for (const [unitKey, text] of firstSeen) {
        const unit = present.get(unitKey);
        const now = unit ? unitText(current, unit) : null;
        const isPeek = text.includes("PEEK_");
        if (isPeek) {
          // A result without a server observation never enters notes and stays exact.
          expect(now).toBe(text);
          expect(readBefore).not.toContain(text.match(/PEEK_object-\d+/u)![0]);
          continue;
        }
        const next = now === text ? "exact" : now === null ? "gone" : "masked";
        const previous = state.get(unitKey) ?? "exact";
        state.set(unitKey, next);
        if (next === previous || next === "exact") continue;
        // Newly masked or gone: committed notes of this run cover it, and a
        // summary call read it whole before this dispatch.
        if (next === "gone") released += 1; else masked += 1;
        expect(refs.has(unitCoverageRef({ callIds: unitKey.split(",") }))).toBe(true);
        const marker = markerOf(text);
        if (marker) expect(readBefore).toContain(marker);
      }
    }
    expect(released + masked).toBeGreaterThan(0);
    // The summarizer knows the task and keeps facts with their source handles.
    for (const entry of summaries) {
      expect(entry.request.prompt.system).toContain("current=\"true\" is the user's current task");
      // Every call that reads source material reads the task with it; a
      // reduction combines part notes that already kept what the task needs.
      if (!entry.request.prompt.system!.includes("notes of consecutive parts")) {
        expect((entry.request.content.blocks[0] as { text: string }).text).toContain('current="true"');
      }
    }
    expect(summaries.some((entry) => /tor1_[a-f0-9]{32}/u.test((entry.request.content.blocks[0] as { text: string }).text))).toBe(true);
  });
});

/**
 * The paid stand's shape: one list call, then parallel batches of 8–64 KB
 * detail calls (every seventh an error) on a 32k window whose fixed part (the
 * prompt and every loaded tool definition) takes about 10.5k tokens, with read
 * rounds between them; each call round carries the model's reasoning item.
 * Previews outside the batch allowance, then a flat quarter-budget allowance
 * beside that fixed part (and concurrent reads all counting on the same
 * room), once made the irreducible newest batch exceed the budget
 * (context_too_large before any compaction cycle). Each batch is now sized
 * against the request that carries it.
 */
describe("parallel batches of large retained results on a small window", () => {
  const RECORDS = 50;
  const READS_PER_ROUND = 10;
  const tool = (name: string, description = name, properties: Record<string, unknown> = {}): RunTool =>
    ({ capability: "mcp", description, inputSchema: { type: "object", properties }, name });
  const listTool = tool("mcp_records_list");
  const detailTool = tool("mcp_records_details");
  const binding = { version: 1 as const, source: "mcp" as const, serverId: "records-server", originalName: "records",
    revisionId: "records-revision", fingerprint: "b".repeat(64) };
  const VOCABULARY = ["record", "status", "owner", "history", "reply", "pending", "review", "detail"];
  const prose = (seed: string, count: number) => Array.from({ length: count }, (_, index) =>
    VOCABULARY[createHash("sha256").update(`${seed}:${index}`).digest()[0]! % VOCABULARY.length]).join(" ");
  /** "Load all" of a large MCP inventory: tool definitions dominate the fixed part. */
  const inventory = Array.from({ length: 31 }, (_, index) => tool(`mcp_inventory_tool_${index}`, prose(`tool-${index}`, 120),
    Object.fromEntries(Array.from({ length: 4 }, (_, field) =>
      [`field_${field}`, { type: "string", description: prose(`field-${index}-${field}`, 18) }]))));
  const recordId = (index: number) => `rec-${String(index % RECORDS + 1).padStart(3, "0")}`;
  const isReferenceResult = (result: ToolExecutionResult) => result.content.length === 1 && result.content[0]!.type === "json" &&
    Object.keys(result.content[0]!.value as object).sort().join(",") === "observation,reader";
  const detail = (index: number) => {
    if ((index + 1) % 7 === 0) return { isError: true, structuredContent: null, text: [`Record ${recordId(index)} is temporarily unavailable.`], unsupportedContentTypes: [] };
    // As the stand's fixture: JSON with a structured history for even ids
    // (dense in quotes the provider transcript escapes again), text for odd ones.
    const bytes = 8 * 1024 + createHash("sha256").update(`size:${index}`).digest().readUInt16BE(0) % (56 * 1024);
    const history = Array.from({ length: Math.ceil(bytes / 90) }, (_, step) =>
      ({ author: prose(`author-${index}-${step}`, 1), note: prose(`note-${index}-${step}`, 9), step: step + 1 }));
    const text = index % 2 === 0
      ? JSON.stringify({ history, id: recordId(index), status: "open", title: `RECORD_${index + 1}_FACT` })
      : [`Record ${recordId(index)}: RECORD_${index + 1}_FACT`, ...history.map((entry) => `${entry.step}. ${entry.author}: ${entry.note}`)].join("\n");
    return { isError: false, structuredContent: null, unsupportedContentTypes: [], text: [text.slice(0, bytes)] };
  };

  // `drift` overstates a batch's allowance, as when the request that finally
  // carries it costs more than estimated when it was sized (the stand's
  // 25-call run missed the budget by about 250 tokens).
  it.each([{ drift: 0, parallel: 25 }, { drift: 0, parallel: 43 }, { drift: 1_500, parallel: 25 }])(
    "keeps $parallel parallel calls per batch (allowance drift $drift) within the budget beside a 10.5k-token fixed part",
    async ({ drift, parallel }) => {
    const observations = memoryToolObservations();
    const actor = { runId: "records-run", userId: "records-owner" };
    const settled: ToolExecutionResult[] = [];
    const answers: ProviderRunRequest[] = [];
    let summaries = 0;
    const messages = [{ content: { blocks: [{ text: "Review every record and report which ones still wait for a reply.", type: "text" as const }] },
      id: "current", role: "user" as const }];
    const initialRequest = request({ content: messages[0]!.content, context: { messages, mode: "branch_path" },
      contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages }),
      modelCapabilities: { ...request().modelCapabilities, contextWindow: 32_768, defaultMaxOutputTokens: 4_096, toolCalling: true },
      params: {}, prompt: { developer: null, system: prose("system", 1_500) }, toolObservationVersion: 1 });
    const batches = observationWholeDeliveryBatches();
    const shares = new Map<number, number>();
    let latest = initialRequest;
    const detailHandles: string[] = [];
    // Rounds: list; details; reads; more details; reads; answer.
    const plan = (round: number): Array<{ arguments: Record<string, unknown>; id: string; name: string }> => {
      if (round === 1) return [{ arguments: {}, id: "list", name: listTool.name }];
      if (round === 2 || round === 4) {
        const first = round === 2 ? 0 : parallel;
        return Array.from({ length: parallel }, (_, index) =>
          ({ arguments: { id: recordId(first + index), index: first + index }, id: `detail-${round}-${index}`, name: detailTool.name }));
      }
      if (round === 3 || round === 5) {
        const first = round === 3 ? 0 : parallel;
        return detailHandles.slice(first, first + READS_PER_ROUND).filter(Boolean)
          .map((handle, index) => ({ arguments: { handle, maxBytes: 6 * 1024 }, id: `read-${round}-${index}`, name: READ_TOOL_RESULT_NAME }));
      }
      return [];
    };
    const adapter: ProviderAdapter = { buildRequestPreview: () => ({}), async *stream(roundRequest) {
      answers.push(roundRequest);
      const calls = plan(answers.length);
      const usage = { inputTokens: 1, outputTokens: 1 };
      // A reasoning model's encrypted reasoning travels with its calls and stays with the newest batch.
      const reasoning = { encrypted_content: Buffer.from(prose(`reasoning-${answers.length}`, 400)).toString("base64"),
        id: `rs-${answers.length}`, summary: [], type: "reasoning" };
      return calls.length ? { finalProviderResponsePreview: {}, finalText: "", usage, toolCalls: calls,
        providerToolCallMessage: [reasoning, ...calls.map((call) => ({ arguments: JSON.stringify(call.arguments), call_id: call.id,
          name: call.name, status: "completed", type: "function_call" }))] }
        : { finalProviderResponsePreview: {}, finalText: "Records reviewed.", usage };
    } };
    const summaryAdapter: Pick<ProviderAdapter, "stream"> = { async *stream(next) {
      summaries += 1;
      const facts = [...new Set((next.content.blocks[0] as { text: string }).text.match(/RECORD_\d+_FACT/gu) ?? [])];
      // Notes of about the summarizer's floor, bought in the cycle that prepares the next round.
      const output = JSON.stringify({ notes: `Seen: ${facts.join(", ") || "none"}. ${prose(`notes-${summaries}`, 500)}`.slice(0, 3_500),
        sourceRefs: [] });
      yield { data: { delta: output }, type: "token" };
      return { finalProviderResponsePreview: {}, finalText: output, usage: { inputTokens: 3, outputTokens: 1 } };
    } };
    const outcome = await runProviderToolLoop({
      adapter, bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 4, maxToolCalls: 320, maxToolRounds: 20 },
      executeTool: async (call, context) => {
        const allowance = batches.allowance(context.round, 0);
        let value: ToolExecutionResult;
        if (call.name === READ_TOOL_RESULT_NAME) {
          value = await executeReadToolResult(observations.service(), { arguments: call.arguments, id: call.id, name: call.name }, actor,
            undefined, observationReadBudget(allowance));
        } else {
          const index = call.name === listTool.name ? -1 : Number(call.arguments.index);
          value = await captureMcpObservation({ service: observations.service(), producer: { ...actor, toolCallId: call.id }, wholeDelivery: allowance },
            { arguments: call.arguments, id: call.id, name: call.name }, binding, async () => index < 0
              ? { isError: false, structuredContent: null, unsupportedContentTypes: [],
                text: [JSON.stringify(Array.from({ length: RECORDS }, (_, item) => recordId(item)))] }
              : detail(index));
          if (index >= 0 && value.observation) detailHandles[index] = value.observation.handle;
        }
        settled.push(value);
        return { status: "complete" as const, value };
      },
      initialRequest, parallelToolCalls: true,
      // As execution does: size each batch against the request that carries it.
      persistToolBatch: ({ calls, continuation, round }) => {
        const share = observationBatchShare({ bridge: openAIResponsesToolBridge, calls,
          observations: contextObservationsFromResults(settled),
          request: { ...latest, providerToolMessages: [...continuation.providerToolMessages] } });
        shares.set(round, share.tokens);
        batches.begin(round, { ...share, tokens: share.tokens + drift });
      },
      prepareRequest: async (roundRequest) => {
        latest = await prepareCompactedProviderRequest({
          bridge: openAIResponsesToolBridge, failure: (code, message) => Object.assign(new Error(message), { code }),
          observations: contextObservationsFromResults(settled),
          publisher: createContextCompactionPublisher(async () => undefined),
          receipts: { claim: async () => undefined, dispatch: async () => undefined, settle: async () => undefined },
          request: roundRequest, signal: new AbortController().signal, summaryAdapter
        });
        return latest;
      },
      projectToolResultForProvider: projectObservationForProvider,
      tools: [readToolResultTool, listTool, detailTool, ...inventory]
    });

    expect(outcome).toMatchObject({ final: { finalText: "Records reviewed." }, status: "complete" });
    const budget = answers[0]!.contextCompaction!.budgetTokens!;
    // The fixed part alone is about 10.5k estimated tokens, as on the stand.
    expect(answers[0]!.contextCompaction!.beforeTokens).toBeGreaterThan(9_500);
    expect(answers[0]!.contextCompaction!.beforeTokens).toBeLessThan(11_500);
    for (const sent of answers) expect(sent.contextCompaction!.afterTokens).toBeLessThanOrEqual(budget);
    // A detail batch beside the fixed part, its own floor (references and the
    // calls with their reasoning) and the notes still to come receives less
    // than the flat quarter share; that share once overflowed the 43-call batch.
    for (const round of [2, 4]) expect(shares.get(round)).toBeGreaterThan(0);
    expect(shares.get(4)).toBeLessThan(Math.floor(budget / 4));
    if (parallel === 43) expect(shares.get(2)).toBeLessThan(Math.floor(budget / 4));
    // Results an overstated allowance delivered whole or as previews reach the
    // model as their references when the request that carries them would not
    // fit: they had never been seen, so nothing leaves without notes.
    const firstOutput = (callId: string) => answers.flatMap((sent) => sent.providerToolMessages ?? [])
      .map((message) => message as { call_id?: string; output?: string; type?: string })
      .find((message) => message.call_id === callId && message.type === "function_call_output")?.output ?? "";
    const asReference = (text: string) => {
      try { return ["is_error,observation,reader", "observation,reader"].includes(Object.keys(JSON.parse(text) as object).sort().join(",")); }
      catch { return false; }
    };
    const degraded = settled.filter((result) => result.name === detailTool.name && !isReferenceResult(result) &&
      asReference(firstOutput(result.callId)));
    if (drift > 0) expect(degraded.length).toBeGreaterThan(0);
    else expect(degraded).toEqual([]);
    const details = settled.filter((result) => result.name === detailTool.name);
    // Every detail stays retained and readable; beyond the batch allowance it arrives as its reference.
    expect(details.every((result) => result.observation)).toBe(true);
    expect(details.filter(isReferenceResult).length).toBeGreaterThan(0);
    // The model reads what it needs; a read beyond its batch is deferred, never cut below a preview.
    const reads = settled.filter((result) => result.name === READ_TOOL_RESULT_NAME);
    expect(reads.some((result) => result.status === "complete")).toBe(true);
    for (const read of reads.filter((result) => result.status === "error")) {
      expect(read.content).toEqual([{ type: "json", value: expect.objectContaining({ code: "tool_observation_read_deferred" }) }]);
    }
    // Notes are bought as the rounds accumulate, before older results leave.
    expect(summaries).toBeGreaterThan(0);
  });
});

describe("tool-free synthesis when the budget ends tool use", () => {
  const tools: RunTool[] = [{ capability: "mcp", description: "A", inputSchema: { type: "object" }, name: "alpha" }];
  const previous = {
    call: { arguments: {}, id: "old", name: "alpha" }, ordinal: 0, round: 40,
    result: { status: "complete" as const, value: { callId: "old", name: "alpha", status: "complete" as const,
      content: [{ type: "text" as const, text: "obtained data" }] } }
  };
  const instruction = (reason: string, unexecuted: boolean) =>
    `Tool use is now disabled for this run: ${reason}.${unexecuted ? " Some planned tool calls were not executed." : ""} ` +
    "Answer now using only the results already obtained, and state explicitly which parts were not verified or not completed.";

  function scripted(rounds: ReadonlyArray<Readonly<{ calls?: number; prefix?: string; text: string }>>) {
    const requests: ProviderRunRequest[] = [];
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(roundRequest) {
        requests.push(roundRequest);
        const round = rounds[requests.length - 1]!;
        if (round.text) yield { type: "token", data: { delta: round.text } };
        return {
          finalProviderResponsePreview: {}, finalText: round.text,
          toolCalls: Array.from({ length: round.calls ?? 0 }, (_, index) => ({
            arguments: { index }, id: `${round.prefix ?? "call"}-${index}`, name: "alpha" })),
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
        };
      }
    };
    return { adapter, requests };
  }

  it("refuses a batch over the remaining call budget and answers in one tool-free round", async () => {
    const { adapter, requests } = scripted([{ calls: 6, text: "planning more" }, { text: "partial answer, unverified rest" }]);
    const executeTool = vi.fn();
    const persistToolBatch = vi.fn();
    const transitions: Array<{ continuation: ProviderToolLoopContinuation; round: number }> = [];
    const budgets: unknown[] = [];
    const signals: string[] = [];
    const usage: Array<[number, string]> = [];
    const prepared: ProviderRunRequest[] = [];
    const outcome = await runProviderToolLoop({
      adapter, bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 4, maxToolCalls: 320, maxToolRounds: 100 },
      executeTool, initialRequest: request(), parallelToolCalls: true, persistToolBatch, tools,
      onFinalSynthesis: budget => { budgets.push(budget); },
      onFinalSynthesisTransition: input => { transitions.push(input); },
      onSignal: signal => { signals.push(signal.type === "message_reset" ? `reset:${signal.round}` : `text:${signal.delta}`); },
      onUsage: (_usage, _request, context) => { usage.push([context.round, context.completeness]); },
      prepareRequest: roundRequest => { prepared.push(roundRequest); return roundRequest; },
      resume: { continuation: { providerResponseId: null, providerToolMessages: [{ type: "prior" }] },
        previousToolResults: [previous], progress: { providerRounds: 40, toolCalls: 317, toolRounds: 39 }, seenCallIds: ["old"] }
    });

    expect(outcome).toMatchObject({ status: "complete", final: { finalText: "partial answer, unverified rest" },
      providerRounds: 42, toolCalls: 317, toolRounds: 39 });
    expect(executeTool).not.toHaveBeenCalled();
    expect(persistToolBatch).not.toHaveBeenCalled();
    const firstMessages = requests[0]!.providerToolMessages!;
    expect(firstMessages).toEqual([{ type: "prior" }, { call_id: "old", output: "obtained data", type: "function_call_output" }]);
    expect(transitions).toEqual([{ round: 41, continuation: {
      finalSynthesis: "budget_exhausted", providerResponseId: null, providerToolMessages: firstMessages } }]);
    // The refused round's assistant items never reach synthesis; the previous
    // round's results do, then the server-owned instruction ends the request.
    expect(requests.map(value => value.toolChoice)).toEqual(["auto", "none"]);
    expect(requests[1]!.providerToolMessages).toEqual([...firstMessages,
      { role: "user", content: instruction("the tool-call budget is exhausted", true) }]);
    expect(JSON.stringify(requests[1]!.providerToolMessages)).not.toContain("call-0");
    // The instruction is budgeted with the request but never persisted.
    expect(prepared[1]!.providerToolMessages!.at(-1)).toEqual(requests[1]!.providerToolMessages!.at(-1));
    expect(JSON.stringify(transitions)).not.toContain("Tool use is now disabled");
    expect(budgets).toEqual([{ kind: "calls", limit: 320 }]);
    expect(signals).toEqual(["text:planning more", "reset:41", "text:partial answer, unverified rest"]);
    expect(usage).toEqual([[41, "terminal"], [42, "terminal"]]);
  });

  it("executes a batch that exactly fills the budget, then answers without the unexecuted-calls sentence", async () => {
    const { adapter, requests } = scripted([{ calls: 3, text: "" }, { text: "answer" }]);
    const executeTool = vi.fn(async (call: { id: string; name: string }) => ({ status: "complete" as const,
      value: { callId: call.id, name: call.name, status: "complete" as const, content: [{ type: "text" as const, text: "ok" }] } }));
    const transition = vi.fn();
    const budgets: unknown[] = [];
    const outcome = await runProviderToolLoop({
      adapter, bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 4, maxToolCalls: 320, maxToolRounds: 100 },
      executeTool, initialRequest: request(), parallelToolCalls: true, tools, onFinalSynthesisTransition: transition,
      onFinalSynthesis: budget => { budgets.push(budget); },
      resume: { continuation: { providerResponseId: null, providerToolMessages: [] },
        progress: { providerRounds: 40, toolCalls: 317, toolRounds: 39 } }
    });
    expect(outcome).toMatchObject({ status: "complete", toolCalls: 320 });
    expect(executeTool).toHaveBeenCalledTimes(3);
    expect(transition).not.toHaveBeenCalled();
    expect(requests[1]!.toolChoice).toBe("none");
    expect(requests[1]!.providerToolMessages!.at(-1)).toEqual({ role: "user",
      content: instruction("the tool-call budget is exhausted", false) });
    expect(budgets).toEqual([{ kind: "calls", limit: 320 }]);
  });

  it("names the round budget when the tool-round limit ends tool use", async () => {
    const { adapter, requests } = scripted([{ calls: 1, text: "" }, { text: "answer" }]);
    await runProviderToolLoop({
      adapter, bridge: geminiInteractionsToolBridge, budgets: { maxConcurrency: 1, maxToolCalls: 10, maxToolRounds: 1 },
      executeTool: async call => ({ status: "complete", value: { callId: call.id, name: call.name, status: "complete",
        content: [{ type: "text", text: "ok" }] } }),
      initialRequest: request({ provider: "gemini" }), parallelToolCalls: false, tools
    });
    expect(requests[1]!.providerToolMessages!.at(-1)).toEqual({ type: "user_input",
      content: [{ type: "text", text: instruction("the tool-round budget is exhausted", false) }] });
  });

  it("keeps the synthesis failure when a provider ignores the tool-free choice after a refused batch", async () => {
    const { adapter } = scripted([{ calls: 6, text: "" }, { calls: 1, prefix: "late", text: "" }]);
    const executeTool = vi.fn();
    const outcome = await runProviderToolLoop({
      adapter, bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 4, maxToolCalls: 5, maxToolRounds: 100 },
      executeTool, initialRequest: request(), parallelToolCalls: true, tools
    });
    expect(outcome).toMatchObject({ status: "failed", failure: { code: "synthesis_tool_call_forbidden" }, toolCalls: 0 });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("fails before synthesis I/O when the refused round cannot be checkpointed", async () => {
    const { adapter, requests } = scripted([{ calls: 6, text: "" }, { text: "never" }]);
    const outcome = await runProviderToolLoop({
      adapter, bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 4, maxToolCalls: 5, maxToolRounds: 100 },
      executeTool: vi.fn(), initialRequest: request(), parallelToolCalls: true, tools,
      onFinalSynthesisTransition: () => { throw new Error("checkpoint conflict"); }
    });
    expect(outcome).toMatchObject({ status: "failed", failure: { code: "tool_loop_checkpoint_failed", stage: "persistence" } });
    expect(requests).toHaveLength(1);
  });

  it("answers without tools or a budget signal after a round of only blocked repeats, with projection notes", async () => {
    const { adapter, requests } = scripted([{ calls: 2, text: "" }, { text: "answer from earlier results" }]);
    const budgets: unknown[] = [];
    const outcome = await runProviderToolLoop({
      adapter, bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 4, maxToolCalls: 320, maxToolRounds: 100 },
      executeTool: async call => ({ status: "complete", value: { callId: call.id, name: call.name, status: "error",
        content: [{ type: "json", value: { error: "tool_call_repeat_blocked", repeatOf: [1, 2] } }] } }),
      initialRequest: request(), parallelToolCalls: true, tools,
      isRepeatBlockedCall: () => true,
      toolResultNoteForProvider: () => "Not executed: this call already returned the same data twice (rounds 1, 2). Use those results.",
      onFinalSynthesis: budget => { budgets.push(budget); }
    });
    expect(outcome).toMatchObject({ status: "complete", toolCalls: 2 });
    expect(requests[1]!.toolChoice).toBe("none");
    const messages = requests[1]!.providerToolMessages!;
    expect(messages.at(-1)).toEqual({ role: "user", content: instruction("repeated identical calls returned no new data", true) });
    expect(JSON.stringify(messages.filter(message => (message as { type?: string }).type === "function_call_output")))
      .toContain("Not executed: this call already returned the same data twice (rounds 1, 2).");
    expect(budgets).toEqual([]);
  });

  it("keeps a round with an executed call open for tools", async () => {
    const { adapter, requests } = scripted([{ calls: 2, text: "" }, { text: "done" }]);
    await runProviderToolLoop({
      adapter, bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 4, maxToolCalls: 320, maxToolRounds: 100 },
      executeTool: async call => ({ status: "complete", value: { callId: call.id, name: call.name, status: "complete",
        content: [{ type: "text", text: "data" }] } }),
      initialRequest: request(), parallelToolCalls: true, tools,
      isRepeatBlockedCall: call => call.id === "call-0"
    });
    expect(requests[1]!.toolChoice).toBe("auto");
    expect(JSON.stringify(requests[1]!.providerToolMessages)).not.toContain("Tool use is now disabled");
  });

  const timeInstruction = "Tool use is now disabled for this run: the time limit of this turn is close. " +
    "Planned tool calls may not have been executed. " +
    "Answer now using only the results already obtained, and state explicitly which parts were not verified or not completed.";

  it("lets a batch running when the time budget ends settle, then answers once without tools or a budget signal", async () => {
    const { adapter, requests } = scripted([{ calls: 2, text: "" }, { text: "partial answer" }]);
    let timeUsedUp = false;
    const executeTool = vi.fn(async (call: { id: string; name: string }) => {
      timeUsedUp = true;
      return { status: "complete" as const, value: { callId: call.id, name: call.name, status: "complete" as const,
        content: [{ type: "text" as const, text: "ok" }] } };
    });
    const transition = vi.fn();
    const budgets: unknown[] = [];
    const outcome = await runProviderToolLoop({
      adapter, bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 4, maxToolCalls: 320, maxToolRounds: 100 },
      executeTool, initialRequest: request(), parallelToolCalls: true, tools, onFinalSynthesisTransition: transition,
      onFinalSynthesis: budget => { budgets.push(budget); }, timeBudgetExhausted: () => timeUsedUp
    });
    expect(outcome).toMatchObject({ status: "complete", final: { finalText: "partial answer" }, toolCalls: 2, toolRounds: 1 });
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(transition).not.toHaveBeenCalled();
    expect(requests.map(value => value.toolChoice)).toEqual(["auto", "none"]);
    expect(requests[1]!.providerToolMessages!.at(-1)).toEqual({ role: "user", content: timeInstruction });
    expect(budgets).toEqual([]);
  });

  it("refuses a batch returned after the time budget ends into the checkpointed synthesis and names time as its cause", async () => {
    const { adapter, requests } = scripted([{ calls: 3, text: "planning" }, { text: "answer from earlier results" }]);
    const executeTool = vi.fn();
    const persistToolBatch = vi.fn();
    const transitions: Array<{ continuation: ProviderToolLoopContinuation; round: number }> = [];
    const dispatchMarks: number[] = [];
    const budgets: unknown[] = [];
    const usage: Array<[number, string]> = [];
    const outcome = await runProviderToolLoop({
      adapter, bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 4, maxToolCalls: 320, maxToolRounds: 100 },
      executeTool, initialRequest: request(), parallelToolCalls: true, persistToolBatch, tools,
      onFinalSynthesis: budget => { budgets.push(budget); },
      onFinalSynthesisTransition: input => { transitions.push(input); },
      beforeSynthesisDispatch: ({ round }) => { dispatchMarks.push(round); },
      onUsage: (_usage, _request, context) => { usage.push([context.round, context.completeness]); },
      // Used up while the first round is planned.
      timeBudgetExhausted: () => requests.length > 0
    });
    expect(outcome).toMatchObject({ status: "complete", final: { finalText: "answer from earlier results" }, toolCalls: 0 });
    expect(executeTool).not.toHaveBeenCalled();
    expect(persistToolBatch).not.toHaveBeenCalled();
    expect(transitions).toEqual([{ round: 1, continuation: expect.objectContaining({ finalSynthesis: "budget_exhausted" }) }]);
    expect(dispatchMarks).toEqual([2]);
    expect(requests.map(value => value.toolChoice)).toEqual(["auto", "none"]);
    expect(requests[1]!.providerToolMessages!.at(-1)).toEqual({ role: "user", content: timeInstruction });
    expect(JSON.stringify(transitions)).not.toContain("Tool use is now disabled");
    expect(budgets).toEqual([]);
    expect(usage).toEqual([[1, "terminal"], [2, "terminal"]]);
  });

  it("decides time only where live execution knows it; recovery keeps the checkpointed call-budget decision", () => {
    const decide = (timeExhausted?: boolean) => toolSynthesisDecision({
      budgets: { maxToolCalls: 320, maxToolRounds: 100 }, continuation: { finalSynthesis: "budget_exhausted" },
      initialToolChoice: "auto", noProgress: false, progress: { toolCalls: 4, toolRounds: 2 },
      ...(timeExhausted === undefined ? {} : { timeExhausted })
    });
    expect(decide()).toEqual({ budget: { kind: "calls", limit: 320 }, reason: "budget_exhausted" });
    expect(decide(false)).toEqual({ budget: { kind: "calls", limit: 320 }, reason: "budget_exhausted" });
    expect(decide(true)).toEqual({ budget: null, reason: "time" });
    expect(toolSynthesisDecision({ budgets: { maxToolCalls: 320, maxToolRounds: 100 }, continuation: {},
      initialToolChoice: "none", noProgress: false, progress: { toolCalls: 0, toolRounds: 0 }, timeExhausted: true })).toBeNull();
  });

  it("keeps the no-progress cause over a used-up time budget", async () => {
    const { adapter, requests } = scripted([{ calls: 1, text: "" }, { text: "answer" }]);
    let blocked = false;
    await runProviderToolLoop({
      adapter, bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 4, maxToolCalls: 320, maxToolRounds: 100 },
      executeTool: async call => { blocked = true; return { status: "complete", value: { callId: call.id, name: call.name,
        status: "error", content: [{ type: "json", value: { error: "tool_call_repeat_blocked", repeatOf: [1, 2] } }] } }; },
      initialRequest: request(), parallelToolCalls: true, tools, isRepeatBlockedCall: () => true,
      timeBudgetExhausted: () => blocked
    });
    expect(requests[1]!.providerToolMessages!.at(-1)).toEqual({ role: "user",
      content: instruction("repeated identical calls returned no new data", true) });
  });

  it("keeps the approval cause over a used-up time budget", async () => {
    const { adapter, requests } = scripted([{ calls: 1, text: "" }, { text: "answer" }]);
    let gated = false;
    await runProviderToolLoop({
      adapter, bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 4, maxToolCalls: 320, maxToolRounds: 100 },
      executeTool: async call => { gated = true; return { status: "complete", value: { callId: call.id, name: call.name,
        status: "error", content: [{ type: "json", value: { error: "mcp_approval_required" } }] } }; },
      initialRequest: request(), parallelToolCalls: true, tools, isApprovalGatedCall: () => true,
      timeBudgetExhausted: () => gated
    });
    expect(requests.map(value => value.toolChoice)).toEqual(["auto", "none"]);
    expect(requests[1]!.providerToolMessages!.at(-1)).toEqual({ role: "user",
      content: instruction("a tool call waits for the user's approval in the chat", true) });
  });

  it("sends the Anthropic instruction as a text block the adapter keeps", async () => {
    const { adapter, requests } = scripted([{ calls: 6, text: "" }, { text: "answer" }]);
    await runProviderToolLoop({
      adapter, bridge: anthropicMessagesToolBridge, budgets: { maxConcurrency: 4, maxToolCalls: 5, maxToolRounds: 100 },
      executeTool: vi.fn(), initialRequest: request({ provider: "anthropic" }), parallelToolCalls: true, tools
    });
    expect(requests[1]!.providerToolMessages!.at(-1)).toEqual({ role: "user",
      content: [{ type: "text", text: instruction("the tool-call budget is exhausted", true) }] });
  });
});

describe("synthesis after a refused batch never inherits reader-dependent references", () => {
  it("re-plans synthesis from the refused round's unprepared transcript, not its degraded projection", async () => {
    const tools: RunTool[] = [{ capability: "mcp", description: "A", inputSchema: { type: "object" }, name: "alpha" }];
    const requests: ProviderRunRequest[] = [];
    const prepared: ProviderRunRequest[] = [];
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(roundRequest) {
        requests.push(roundRequest);
        const index = requests.length;
        return { finalProviderResponsePreview: {}, finalText: index === 3 ? "answer" : "",
          toolCalls: index === 1 ? [{ arguments: {}, id: "first", name: "alpha" }]
            : index === 2 ? Array.from({ length: 6 }, (_, call) => ({ arguments: { call }, id: `more-${call}`, name: "alpha" })) : [],
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
      }
    };
    // Like the planner's newest-batch degradation: only while the reader is
    // callable may an unseen result arrive as its reference.
    const prepareRequest = (roundRequest: ProviderRunRequest) => {
      prepared.push(roundRequest);
      return roundRequest.toolChoice === "none" ? roundRequest : { ...roundRequest,
        providerToolMessages: roundRequest.providerToolMessages?.map(message =>
          JSON.stringify(message).includes("FULL_DATA") ? { call_id: "first", output: "REFERENCE_ONLY", type: "function_call_output" } : message) };
    };
    const outcome = await runProviderToolLoop({
      adapter, bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 4, maxToolCalls: 3, maxToolRounds: 10 },
      executeTool: async call => ({ status: "complete", value: { callId: call.id, name: call.name, status: "complete",
        content: [{ type: "text", text: "FULL_DATA" }] } }),
      initialRequest: request(), parallelToolCalls: true, prepareRequest, tools
    });
    expect(outcome).toMatchObject({ status: "complete" });
    // The refused round itself saw only the reference ...
    expect(JSON.stringify(requests[1]!.providerToolMessages)).toContain("REFERENCE_ONLY");
    // ... but its tool-free synthesis is planned from the real result.
    expect(JSON.stringify(prepared[2]!.providerToolMessages)).toContain("FULL_DATA");
    expect(JSON.stringify(requests[2]!.providerToolMessages)).toContain("FULL_DATA");
    expect(JSON.stringify(requests[2]!.providerToolMessages)).not.toContain("REFERENCE_ONLY");
  });
});

describe("dropped Codex LB round retry", () => {
  const alpha: RunTool = { capability: "mcp", description: "A", inputSchema: { type: "object" }, name: "alpha" };
  const artifact: RunTool = { capability: "artifact", description: "Artifact", inputSchema: { type: "object" }, name: "create_artifact" };
  const encoder = new TextEncoder();
  /** One SSE body read chunk by chunk; `failure` breaks the read after them. */
  const sse = (events: readonly unknown[], failure?: unknown) => {
    const chunks = events.map((event) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    let index = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]!);
        else if (failure) controller.error(failure);
        else controller.close();
      }
    }), { headers: { "content-type": "text/event-stream" } });
  };
  const created = (id: string) => ({ response: { id, status: "in_progress" }, type: "response.created" });
  const delta = (text: string) => ({ delta: text, type: "response.output_text.delta" });
  const failed = (id: string, error: Record<string, unknown>, usage?: Record<string, number>) =>
    ({ response: { error, id, output: [], status: "failed", ...(usage ? { usage } : {}) }, type: "response.failed" });
  const completed = (id: string, text: string, call?: string) => ({ response: { id, status: "completed",
    output: call ? [{ arguments: "{}", call_id: call, id: `fc-${call}`, name: "alpha", type: "function_call" }]
      : [{ content: [{ text, type: "output_text" }], role: "assistant", type: "message" }],
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } }, type: "response.completed" });
  const steps = {
    "502": () => new Response(JSON.stringify({ error: { code: "server_error", message: "PRIVATE_PROVIDER_MESSAGE_CANARY" } }),
      { headers: { "content-type": "application/json" }, status: 502 }),
    "502_retry_after": () => new Response("{}", { headers: { "retry-after": "2" }, status: 502 }),
    "502_retry_after_long": () => new Response("{}", { headers: { "retry-after": "301" }, status: 502 }),
    truncated: () => sse([created("resp-drop"), delta("Dropped par")]),
    error_event: () => sse([created("resp-drop"), delta("Dropped par"),
      { code: "server_error", message: "PRIVATE_PROVIDER_MESSAGE_CANARY", type: "error" }]),
    response_failed: () => sse([created("resp-drop"), delta("Dropped par"),
      failed("resp-drop", { code: "server_error", message: "PRIVATE_PROVIDER_MESSAGE_CANARY" }, { input_tokens: 9, output_tokens: 1, total_tokens: 10 })]),
    reset: () => sse([created("resp-drop"), delta("Dropped par")], Object.assign(new Error("aborted"), { code: "ECONNRESET" })),
    context_failed: () => sse([created("resp-drop"), delta("Dropped par"),
      failed("resp-drop", { code: "context_length_exceeded", message: "PRIVATE_PROVIDER_MESSAGE_CANARY" })]),
    content_filter: () => sse([created("resp-drop"), delta("Dropped par"), failed("resp-drop", { code: "content_filter", message: "x" })]),
    tool_arguments: () => sse([created("resp-drop"),
      { item: { arguments: "", call_id: "art-1", id: "fc-art", name: "create_artifact", type: "function_call" }, output_index: 0,
        type: "response.output_item.added" },
      { delta: "{\"title\"", item_id: "fc-art", output_index: 0, type: "response.function_call_arguments.delta" }]),
    hosted_search: () => sse([created("resp-drop"), { item_id: "ws-1", output_index: 0, type: "response.web_search_call.in_progress" }]),
    final: () => sse([created("resp-final"), delta("Final answer"), completed("resp-final", "Final answer")]),
    final_tool: () => sse([created("resp-tool"), completed("resp-tool", "", "call-1")])
  } satisfies Record<string, () => Response>;
  type Step = keyof typeof steps;

  function harness(sequence: readonly Step[], input: Readonly<{
    admitted?: boolean;
    onUsage?: (usage: unknown, context: unknown) => void;
    reopen?: () => Promise<boolean>;
    roundTimeoutMs?: number;
    signal?: AbortSignal;
    sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
    tools?: readonly RunTool[];
  }> = {}) {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const step = sequence[bodies.length - 1];
      if (!step) throw new Error("unexpected_request");
      return steps[step]();
    });
    const adapter = createCompatibleResponsesAdapter({ client: createFetchOpenAIResponsesClient({ apiKey: "synthetic",
      baseUrl: "https://lb.example.test/backend-api/codex", fetchFn, initialRequestRetry: { maxAttempts: 3, sleep: async () => undefined },
      requestIsolation: true }) });
    const observe = vi.fn();
    const reopen = vi.fn(async (_value: Readonly<{ attempt: number; publishedText: boolean; round: number }>) =>
      input.reopen ? input.reopen() : true);
    const sleeps: number[] = [];
    const usage: Array<[unknown, unknown]> = [];
    const text: string[] = [];
    const executeTool = vi.fn(async (call: { id: string; name: string }) => ({ status: "complete" as const,
      value: { callId: call.id, content: [{ text: "evidence", type: "text" as const }], name: call.name, status: "complete" as const } }));
    const run = () => runProviderToolLoop({
      adapter, bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 2, maxToolRounds: 2,
        ...(input.roundTimeoutMs ? { providerRoundTimeoutMs: input.roundTimeoutMs } : {}) },
      executeTool, initialRequest: request({ params: { stream: true }, provider: "openai-compatible" }),
      onSignal: (signal) => { if (signal.type === "text_delta") text.push(signal.delta); },
      onToolArguments: async () => undefined,
      onUsage: (value, _request, context) => {
        usage.push([value, context]);
        input.onUsage?.(value, context);
      },
      parallelToolCalls: false,
      ...(input.admitted === false ? {} : { roundRetry: {
        policy: { decision: compatibleDroppedRoundDecision, maxAttempts: 3, observe },
        random: () => 0, reopen,
        sleep: input.sleep ?? (async (delayMs: number) => { sleeps.push(delayMs); })
      } }),
      ...(input.signal ? { signal: input.signal } : {}),
      tools: [...(input.tools ?? [alpha])]
    });
    return { bodies, executeTool, fetchFn, observe, reopen, run, sleeps, text, usage };
  }
  const unknownPartial = [{}, { completeness: "partial", round: 1 }];
  const withoutRoutingKey = ({ prompt_cache_key: _key, ...body }: Record<string, unknown>) => body;

  it.each([
    ["502", null, false],
    ["truncated", "truncated", true],
    ["error_event", "error_event", true],
    ["response_failed", "response_failed", true],
    ["reset", "reset", true]
  ] as const)("sends the round again after a %s, replacing its text", async (step, drop, publishedText) => {
    const loop = harness([step, "final"]);
    const outcome = await loop.run();
    expect(outcome).toMatchObject({ final: { finalText: "Final answer" }, providerRounds: 1, status: "complete" });
    expect(loop.fetchFn).toHaveBeenCalledTimes(2);
    // The same prepared request, destination and model; only the routing key is per request.
    expect(withoutRoutingKey(loop.bodies[1]!)).toEqual(withoutRoutingKey(loop.bodies[0]!));
    expect(loop.bodies[1]!.prompt_cache_key).not.toBe(loop.bodies[0]!.prompt_cache_key);
    // Each request is one accounted operation: the dropped one with what it reported.
    expect(loop.usage).toEqual([
      step === "response_failed"
        ? [expect.objectContaining({ inputTokens: 9, outputTokens: 1 }), { completeness: "partial", round: 1 }]
        : unknownPartial,
      [expect.objectContaining({ inputTokens: 5, outputTokens: 2 }), { completeness: "terminal", round: 1 }]
    ]);
    expect(loop.sleeps).toEqual([125]);
    expect(loop.reopen).toHaveBeenCalledExactlyOnceWith({ attempt: 2, publishedText, round: 1 });
    expect(loop.text).toEqual([...(publishedText ? ["Dropped par"] : []), "Final answer"]);
    expect(loop.observe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: "retry", attempt: 1, delayMs: 125 }));
    const failure: unknown = loop.observe.mock.calls[0]![0].error;
    expect(providerStreamDrop(failure)).toBe(drop);
    if (step === "502") expect(failure).toMatchObject({ status: 502 });
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_");
  });

  it("gives up after the third dropped request with the last drop as the round's failure", async () => {
    const loop = harness(["502", "truncated", "502"]);
    const outcome = await loop.run();
    expect(outcome).toMatchObject({ failure: { code: "provider_server_error", httpStatus: 502, stage: "provider" }, status: "failed" });
    expect(loop.fetchFn).toHaveBeenCalledTimes(3);
    expect(loop.usage).toEqual([unknownPartial, unknownPartial, unknownPartial]);
    expect(loop.sleeps).toEqual([125, 250]);
    expect(loop.reopen.mock.calls.map(([value]) => value)).toEqual([
      { attempt: 2, publishedText: false, round: 1 }, { attempt: 3, publishedText: true, round: 1 }]);
    expect(loop.observe.mock.calls.map(([value]) => [value.action, value.attempt])).toEqual([["retry", 1], ["retry", 2], ["stop", 3]]);
  });

  it.each([
    ["tool arguments streamed", "tool_arguments", { tools: [alpha, artifact] }],
    ["a hosted tool ran", "hosted_search", {}],
    ["a context-length refusal", "context_failed", {}],
    ["a content-filter refusal", "content_filter", {}],
    ["a Retry-After beyond the shared ceiling", "502_retry_after_long", {}],
    ["a binding without the admission", "502", { admitted: false }]
  ] as const)("keeps the failure after %s", async (_name, step, options) => {
    const loop = harness([step, "final"], options);
    const outcome = await loop.run();
    expect(outcome.status).toBe("failed");
    expect(loop.fetchFn).toHaveBeenCalledOnce();
    expect(loop.reopen).not.toHaveBeenCalled();
    expect(loop.sleeps).toEqual([]);
    expect(loop.usage).toHaveLength(1);
  });

  it("waits for a 502's Retry-After before the next request", async () => {
    const loop = harness(["502_retry_after", "final"]);
    expect(await loop.run()).toMatchObject({ status: "complete" });
    expect(loop.sleeps).toEqual([2_000]);
  });

  it("keeps the drop when the dropped request's usage was not recorded or the round cannot re-open", async () => {
    const unrecorded = harness(["truncated", "final"], { onUsage: (_usage, context) => {
      if ((context as { completeness: string }).completeness === "partial") throw new Error("synthetic_accounting_unavailable");
    } });
    expect(await unrecorded.run()).toMatchObject({ failure: { code: "provider_round_failed" }, status: "failed" });
    expect(unrecorded.fetchFn).toHaveBeenCalledOnce();
    expect(unrecorded.observe).not.toHaveBeenCalled();

    const conflict = harness(["truncated", "final"], { reopen: async () => false });
    expect(await conflict.run()).toMatchObject({ failure: { code: "provider_round_failed" }, status: "failed" });
    expect(conflict.fetchFn).toHaveBeenCalledOnce();
    expect(conflict.reopen).toHaveBeenCalledOnce();
  });

  it("ends the wait at once on Stop or the run's deadline without another request", async () => {
    for (const reason of [undefined, Object.assign(new Error("workspace_tool_timeout"), { code: "workspace_tool_timeout" })]) {
      const controller = new AbortController();
      const loop = harness(["truncated", "final"], { signal: controller.signal, sleep: (delayMs, signal) => {
        controller.abort(reason);
        return sleepWithSignal(delayMs, signal);
      } });
      expect(await loop.run()).toMatchObject({ status: "cancelled" });
      expect(loop.fetchFn).toHaveBeenCalledOnce();
      expect(loop.reopen).not.toHaveBeenCalled();
      expect(loop.usage).toEqual([unknownPartial]);
    }
  });

  it("bounds the round and its waits by the round deadline", async () => {
    const loop = harness(["truncated", "final"], { roundTimeoutMs: 20, sleep: sleepWithSignal });
    expect(await loop.run()).toMatchObject({ failure: { code: "provider_round_timeout" }, status: "failed" });
    expect(loop.fetchFn).toHaveBeenCalledOnce();
    expect(loop.reopen).not.toHaveBeenCalled();
  });

  it("runs the tool calls of the round's completed request once", async () => {
    const loop = harness(["truncated", "final_tool", "final"]);
    expect(await loop.run()).toMatchObject({ final: { finalText: "Final answer" }, status: "complete", toolCalls: 1 });
    expect(loop.executeTool).toHaveBeenCalledOnce();
    expect(loop.usage.map(([, context]) => context)).toEqual([
      { completeness: "partial", round: 1 }, { completeness: "terminal", round: 1 }, { completeness: "terminal", round: 2 }]);
    expect(loop.reopen).toHaveBeenCalledOnce();
  });
});
