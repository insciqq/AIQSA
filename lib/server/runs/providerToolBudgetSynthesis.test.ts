import { describe, expect, it, vi } from "vitest";
import { TOOL_SYNTHESIS_FAILURE } from "../../contracts/runs";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { createGeminiInteractionsAdapter } from "../providers/geminiInteractions";
import { buildGeminiInteractionsRequest } from "../providers/geminiInteractionsRequest";
import { buildAnthropicMessagesRequest } from "../providers/anthropicMessages";
import { buildOpenAIResponsesRequest } from "../providers/openaiResponsesRequest";
import { buildOpenRouterChatRequest } from "../providers/openRouterChatRequest";
import { buildCompatibleResponsesRequest } from "../providers/compatibleResponses";
import { buildOpenAICompatibleChatRequest } from "../providers/openaiCompatibleChatRequest";
import { buildDeepSeekResponsesRequest } from "../providers/deepSeekResponsesRequest";
import {
  anthropicMessagesToolBridge,
  deepSeekResponsesToolBridge,
  geminiInteractionsToolBridge,
  openAICompatibleChatToolBridge,
  openAICompatibleResponsesToolBridge,
  openAIResponsesToolBridge,
  openRouterChatToolBridge
} from "../tools/bridges";
import type { RunTool, ToolExecutionResult } from "../tools/types";
import { runProviderToolLoop } from "./providerToolLoop";
import { applyProviderRequestContextBudget } from "./runContextBudget";

const tools: RunTool[] = ["find_tools", "server_version", "search"].map((name) => ({
  capability: "mcp", description: "Synthetic operation", inputSchema: { type: "object" }, name
}));

function request(stream = true): ProviderRunRequest {
  return {
    attachmentIds: [], attachments: [], chatId: "synthetic-chat",
    content: { blocks: [{ text: "Inspect the synthetic repository", type: "text" }] },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { contextWindow: 32_000, nativePdfInput: false, nativeSearch: false, pdf: false,
      reasoning: false, streaming: true, toolCalling: true, vision: false },
    modelId: "synthetic-model", params: { maxOutputTokens: 128, stream },
    prompt: { developer: null, system: null }, provider: "gemini",
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto"
  };
}

function result(finalText = "", toolCalls?: ProviderRunResult["toolCalls"]): ProviderRunResult {
  return { finalProviderResponsePreview: {}, finalText, ...(toolCalls ? { toolCalls } : {}),
    usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0 } };
}

function frame(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ ...data, event_type: type })}\n\n`;
}

describe("bounded final synthesis", () => {
  it.each([
    [false, "text"], [false, "call"], [false, "text_and_call"],
    [true, "text"], [true, "call"], [true, "text_and_call"]
  ] as const)("keeps eight Gemini tool batches bounded with stream=%s, final=%s", async (stream, final) => {
    const bodies: Record<string, unknown>[] = [];
    const published: ProviderRunResult[] = [];
    const usages: number[] = [];
    const budgets: unknown[] = [];
    const text: string[] = [];
    const settled: ToolExecutionResult[] = [];
    const executeTool = vi.fn(async (call: { id: string; name: string }) => {
      const round = Number(call.id.slice(5));
      const value: ToolExecutionResult = {
        callId: call.id, name: call.name, status: round >= 7 ? "error" : "complete",
        content: [{ type: "text", text: round >= 7 ? "MCP unavailable" : round === 6 ? "[]" : `result-${round}` }]
      };
      settled.push(value);
      return { status: "complete" as const, value };
    });
    function response(body: Record<string, unknown>) {
      bodies.push(body);
      const round = bodies.length;
      const name = round <= 4 ? "find_tools" : round === 5 ? "server_version" : "search";
      const steps: Record<string, unknown>[] = [];
      if (round === 9 && final !== "call") {
        steps.push({ type: "model_output", content: [{ type: "text", text: "Available partial findings" }] });
      }
      if (round < 9 || final !== "text") {
        steps.push({ type: "function_call", id: `call-${round}`, name, arguments: {}, signature: `fixture-signature-${round}` });
      }
      return { id: `interaction-${round}`, status: round === 9 && final === "text" ? "completed" : "requires_action",
        // Input history and other interactions are not current output steps.
        input: body.input, previous_interaction: { steps: body.input }, steps,
        usage: { total_input_tokens: round, total_output_tokens: 1, total_tokens: round + 1 } };
    }
    const adapter = createGeminiInteractionsAdapter({ client: {
      createInteraction: async (body) => response(body),
      streamInteraction: async (body) => {
        const value = response(body);
        const frames = [frame("interaction.created", {
          interaction: { id: value.id, status: "in_progress", steps: body.input }
        })];
        value.steps.forEach((step, index) => {
          if (step.type === "model_output") {
            frames.push(frame("step.start", { index, step: { type: "model_output" } }));
            frames.push(frame("step.delta", { index, delta: { type: "text", text: "Available partial findings" } }));
          } else frames.push(frame("step.start", { index, step }));
          frames.push(frame("step.stop", { index }));
        });
        // The terminal snapshot repeats streamed steps; it must not duplicate calls.
        frames.push(frame("interaction.completed", { interaction: value }));
        frames.push("event: done\ndata: [DONE]\n\n");
        return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
      }
    } });
    const outcome = await runProviderToolLoop({
      adapter, bridge: geminiInteractionsToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 20, maxToolRounds: 8 }, executeTool,
      initialRequest: request(stream), parallelToolCalls: false, tools,
      onFinalSynthesis: (budget) => { budgets.push(budget); },
      onProviderResult: ({ result }) => { published.push(result); },
      onSignal: (signal) => { if (signal.type === "text_delta") text.push(signal.delta); },
      onUsage: (_usage, _request, context) => { usages.push(context.round); },
      prepareRequest: (candidate) => {
        const prepared = applyProviderRequestContextBudget({ bridge: geminiInteractionsToolBridge, request: candidate });
        if (!prepared.ok) throw new Error(prepared.error.code);
        return { ...prepared.request, toolChoice: "auto" };
      }
    });

    expect(bodies).toHaveLength(9);
    expect(bodies.map((body) => body.generation_config)).toEqual([
      ...Array(8).fill(expect.objectContaining({ tool_choice: "auto" })),
      expect.objectContaining({ tool_choice: "none" })
    ]);
    expect(bodies[8]?.tools).toHaveLength(3);
    const finalInput = bodies[8]?.input;
    if (!Array.isArray(finalInput)) throw new Error("Expected serialized Gemini input steps");
    expect(finalInput.filter((step) => step.type === "function_result")).toHaveLength(8);
    expect(JSON.stringify(bodies[8]?.input)).toContain("fixture-signature-8");
    expect(JSON.stringify(bodies[8]?.input)).toContain("MCP unavailable");
    expect(bodies[8]).not.toHaveProperty("previous_interaction_id");
    expect(settled.map((entry) => entry.status)).toEqual([...Array(6).fill("complete"), "error", "error"]);
    expect(settled[5]?.content).toEqual([{ type: "text", text: "[]" }]);
    expect(executeTool).toHaveBeenCalledTimes(8);
    expect(usages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(budgets).toEqual([{ kind: "rounds", limit: 8 }]);
    expect(published[8]?.toolCalls).toHaveLength(final === "text" ? 0 : 1);
    expect(text.join("")).toBe(final === "call" ? "" : "Available partial findings");
    expect(outcome).toMatchObject(final === "text"
      ? { status: "complete", final: { finalText: "Available partial findings" }, toolRounds: 8 }
      : { status: "failed", failure: TOOL_SYNTHESIS_FAILURE, toolCalls: 8, toolRounds: 8, providerRounds: 9 });
  });

  it.each([
    { name: "OpenAI", provider: "openai", build: buildOpenAIResponsesRequest, bridge: openAIResponsesToolBridge },
    { name: "OpenRouter", provider: "openrouter", build: buildOpenRouterChatRequest, bridge: openRouterChatToolBridge },
    { name: "Anthropic", provider: "anthropic", build: buildAnthropicMessagesRequest, bridge: anthropicMessagesToolBridge },
    { name: "Gemini", provider: "gemini", build: buildGeminiInteractionsRequest, bridge: geminiInteractionsToolBridge },
    { name: "DeepSeek", provider: "deepseek", build: buildDeepSeekResponsesRequest, bridge: deepSeekResponsesToolBridge },
    { name: "compatible Responses", provider: "custom", build: buildCompatibleResponsesRequest, bridge: openAICompatibleResponsesToolBridge },
    { name: "compatible Chat", provider: "custom", build: buildOpenAICompatibleChatRequest, bridge: openAICompatibleChatToolBridge }
  ])("serializes effective none and retained results for $name after context preparation", async ({ provider, build, bridge }) => {
    const call = { id: "call-8", name: "search", arguments: {} };
    const executeTool = vi.fn();
    const beforeProviderRound = vi.fn();
    let wire: Record<string, unknown> = {};
    const outcome = await runProviderToolLoop({
      adapter: { buildRequestPreview: () => ({}), async *stream(candidate) {
        wire = JSON.parse(JSON.stringify(build(candidate))) as Record<string, unknown>;
        return result("Final answer");
      } },
      bridge, budgets: { maxConcurrency: 1, maxToolCalls: 8, maxToolRounds: 12 }, executeTool,
      initialRequest: { ...request(), provider }, parallelToolCalls: false, tools, beforeProviderRound,
      prepareRequest: (candidate) => {
        const prepared = applyProviderRequestContextBudget({ bridge, request: candidate });
        if (!prepared.ok) throw new Error(prepared.error.code);
        return { ...prepared.request, toolChoice: "required" };
      },
      resume: {
        continuation: { providerResponseId: "previous-response", providerToolMessages: bridge.serializeAssistantToolCalls({ calls: [call] }) },
        previousToolResults: [{ call, ordinal: 0, round: 8, result: { status: "complete", value: {
          callId: call.id, content: [{ type: "text", text: "retained-tool-result" }], name: call.name, status: "complete"
        } } }],
        progress: { providerRounds: 8, toolCalls: 8, toolRounds: 8 }, seenCallIds: [call.id]
      }
    });
    const choice = (wire.generation_config as { tool_choice?: unknown } | undefined)?.tool_choice ?? wire.tool_choice;
    expect(choice).toEqual(provider === "anthropic" ? { type: "none" } : "none");
    expect(wire.tools).toHaveLength(3);
    expect(JSON.stringify(wire)).toContain("retained-tool-result");
    expect(beforeProviderRound).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ request: expect.objectContaining({ toolChoice: "none" }) }));
    expect(executeTool).not.toHaveBeenCalled();
    expect(outcome.status).toBe("complete");
  });

  it.each(["", "Retained "])("retains final text after prefix %j and accounts a forbidden result exactly once", async (prefix) => {
    const onUsage = vi.fn();
    const onSignal = vi.fn();
    const executeTool = vi.fn();
    const adapter: ProviderAdapter = { buildRequestPreview: () => ({}), async *stream() {
      if (prefix) yield { type: "token", data: { delta: prefix } };
      return result("Retained partial", [{ id: "extra", name: "search", arguments: {} }]);
    } };
    const outcome = await runProviderToolLoop({ adapter, bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 0, maxToolRounds: 0 }, executeTool,
      initialRequest: request(), onSignal, onUsage, parallelToolCalls: false, tools });
    expect(outcome).toMatchObject({ status: "failed", failure: TOOL_SYNTHESIS_FAILURE });
    expect(onSignal.mock.calls.map(([signal]) => signal.delta).join("")).toBe("Retained partial");
    expect(onSignal).toHaveBeenLastCalledWith({ delta: prefix ? "partial" : "Retained partial", round: 1, type: "text_delta" });
    expect(onUsage).toHaveBeenCalledOnce();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("does not dispatch final synthesis after cancellation of the settled last batch", async () => {
    const controller = new AbortController();
    const stream = vi.fn(async function* () { return result("", [{ id: "last", name: "search", arguments: {} }]); });
    const outcome = await runProviderToolLoop({
      adapter: { buildRequestPreview: () => ({}), stream }, bridge: openAIResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 1, maxToolRounds: 1 }, initialRequest: request(),
      executeTool: async (call) => ({ status: "complete", value: {
        callId: call.id, name: call.name, status: "complete", content: [{ type: "text", text: "retained" }]
      } }), afterToolBatch: () => controller.abort(), parallelToolCalls: false, signal: controller.signal, tools
    });
    expect(outcome.status).toBe("cancelled");
    expect(stream).toHaveBeenCalledOnce();
  });
});
