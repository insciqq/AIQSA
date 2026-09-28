import { describe, expect, it, vi } from "vitest";
import { TOOL_SYNTHESIS_FAILURE } from "../../contracts/runs";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { runProviderToolLoop } from "./providerToolLoop";
import { deepSeekResponsesToolBridge } from "../tools/bridges";
import type { RunTool } from "../tools/types";
import { createDeepSeekResponsesAdapter } from "../providers/deepSeekResponses";
import { buildDeepSeekResponsesRequest, buildDeepSeekResponsesRequestPreview } from "../providers/deepSeekResponsesRequest";
import type { ProviderRunRequest } from "../providers/types";

const tool: RunTool = {
  capability: "mcp", description: "Inspect a synthetic fixture", inputSchema: { type: "object" }, name: "inspect_fixture"
};
const nativeCall = '<｜DSML｜function_calls><｜DSML｜invoke name="inspect_fixture">PRIVATE_ARGUMENT_CANARY</｜DSML｜invoke></｜DSML｜function_calls>';
const safePrefix = "The completed inspection found one entry.\n";

function request(stream: boolean): ProviderRunRequest {
  return {
    attachmentIds: [], attachments: [], chatId: "synthetic-chat",
    content: { blocks: [{ text: "Summarize the inspection", type: "text" }] },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { contextWindow: 32_000, nativePdfInput: false, nativeSearch: false, pdf: false,
      reasoning: false, streaming: true, toolCalling: true, vision: false },
    modelId: "synthetic-model", params: { maxOutputTokens: 128, stream },
    prompt: { developer: null, system: null }, provider: "deepseek",
    searchPlan: { mode: "all_selected", options: [] }, toolChoice: "none", toolMode: "auto", tools: [tool]
  };
}

function fixture(text: string, deltas: string[] = [text], options: {
  structuredCall?: boolean;
  terminal?: boolean;
} = {}) {
  const response = {
    id: "synthetic-response", status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text }] },
      ...(options.structuredCall ? [{ type: "function_call", call_id: "forbidden-call", name: tool.name, arguments: "{}" }] : [])
    ],
    usage: { input_tokens: 17, output_tokens: 9, total_tokens: 26 }
  };
  const frame = (type: string, fields: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  const client = {
    create: vi.fn(async () => response),
    stream: vi.fn(async () => new Response([
      frame("response.created", { response: { id: response.id, status: "in_progress" } }),
      ...deltas.map((delta) => frame("response.output_text.delta", { delta })),
      ...(options.terminal === false ? [] : [frame("response.completed", { response })])
    ].join(""), { headers: { "content-type": "text/event-stream" } }))
  };
  return { adapter: createDeepSeekResponsesAdapter({ client }), client };
}

async function collect(stream: ReturnType<ReturnType<typeof createDeepSeekResponsesAdapter>["stream"]>) {
  const events: ModelRunSseEvent[] = [];
  let next = await stream.next();
  while (!next.done) {
    events.push(next.value);
    next = await stream.next();
  }
  return { events, result: next.value,
    text: events.flatMap((event) => event.type === "token" ? [event.data.delta] : []).join("") };
}

describe("DeepSeek no-tool synthesis", () => {
  it("omits declarations in the request and preview while preserving settled tool history", () => {
    const candidate = { ...request(true), providerToolMessages: [
      { type: "function_call", call_id: "settled-call", name: tool.name, arguments: "{}" },
      { type: "function_call_output", call_id: "settled-call", output: "One inspected entry" }
    ] };
    for (const body of [buildDeepSeekResponsesRequest(candidate), buildDeepSeekResponsesRequestPreview(candidate).body]) {
      expect(body.tool_choice).toBe("none");
      expect(body).not.toHaveProperty("tools");
      expect(body.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "function_call", call_id: "settled-call", name: tool.name }),
        expect.objectContaining({ type: "function_call_output", call_id: "settled-call" })
      ]));
    }
    expect(buildDeepSeekResponsesRequest(candidate).input).toContainEqual(candidate.providerToolMessages[1]);
    expect(buildDeepSeekResponsesRequest({ ...candidate, toolChoice: "auto" }).tools).toHaveLength(1);
  });

  it.each([false, true])("keeps ordinary completed answers and usage unchanged with streaming=%s", async (stream) => {
    const { adapter } = fixture("Count < 2", ["Count ", "<", " 2"]);
    const output = await collect(adapter.stream(request(stream)));
    expect(output.text).toBe("Count < 2");
    expect(output.result.finalText).toBe("Count < 2");
    expect(output.result).not.toHaveProperty("synthesisToolCallForbidden");
    expect(output.result.usage).toMatchObject({ inputTokens: 17, outputTokens: 9 });
  });

  it.each([false, true])("rejects native calls without publishing their contents with streaming=%s", async (stream) => {
    const { adapter, client } = fixture(safePrefix + nativeCall, [safePrefix, ...nativeCall]);
    const output = await collect(adapter.stream(request(stream)));
    expect(output.text).toBe(safePrefix);
    expect(output.result).toMatchObject({ finalText: safePrefix, synthesisToolCallForbidden: true,
      toolCalls: [], usage: { inputTokens: 17, outputTokens: 9, totalTokens: 26 } });
    expect(JSON.stringify(output)).not.toContain("DSML");
    expect(JSON.stringify(output)).not.toContain("PRIVATE_ARGUMENT_CANARY");
    expect(stream ? client.stream : client.create).toHaveBeenCalledOnce();
  });

  it("detects native markup in a terminal-only SSE answer", async () => {
    const { adapter } = fixture(safePrefix + nativeCall, []);
    const output = await collect(adapter.stream(request(true)));
    expect(output.result).toMatchObject({ finalText: safePrefix, synthesisToolCallForbidden: true });
    expect(output.text).toBe("");
    expect(JSON.stringify(output)).not.toContain("PRIVATE_ARGUMENT_CANARY");
  });

  it("leaves normal tool-enabled responses to the structured protocol", async () => {
    const { adapter } = fixture(nativeCall);
    const output = await collect(adapter.stream({ ...request(true), toolChoice: "auto" }));
    expect(output.text).toBe(nativeCall);
    expect(output.result).not.toHaveProperty("synthesisToolCallForbidden");
  });

  it.each([false, true])("fails the exhausted tool loop once and retains terminal accounting with streaming=%s", async (stream) => {
    const { adapter, client } = fixture(safePrefix + nativeCall, [safePrefix, ...nativeCall]);
    const executeTool = vi.fn();
    const onUsage = vi.fn();
    const onProviderResult = vi.fn();
    const deltas: string[] = [];
    const outcome = await runProviderToolLoop({
      adapter, bridge: deepSeekResponsesToolBridge, budgets: { maxConcurrency: 1, maxToolCalls: 0, maxToolRounds: 0 },
      executeTool, initialRequest: request(stream), onProviderResult, onUsage, parallelToolCalls: false, tools: [tool],
      onSignal: (signal) => { if (signal.type === "text_delta") deltas.push(signal.delta); }
    });
    expect(outcome).toMatchObject({ status: "failed", failure: TOOL_SYNTHESIS_FAILURE, toolCalls: 0, providerRounds: 1 });
    expect(deltas.join("")).toBe(safePrefix);
    expect(executeTool).not.toHaveBeenCalled();
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ inputTokens: 17, outputTokens: 9 }),
      expect.anything(), { completeness: "terminal", round: 1 });
    expect(onProviderResult).toHaveBeenCalledOnce();
    expect(JSON.stringify(onProviderResult.mock.calls)).not.toContain("PRIVATE_ARGUMENT_CANARY");
    expect(stream ? client.stream : client.create).toHaveBeenCalledOnce();
  });

  it("keeps the existing failure for a genuine structured call after tools were disabled", async () => {
    const { adapter } = fixture("Partial answer", ["Partial answer"], { structuredCall: true });
    const executeTool = vi.fn();
    const outcome = await runProviderToolLoop({ adapter, bridge: deepSeekResponsesToolBridge,
      budgets: { maxConcurrency: 1, maxToolCalls: 0, maxToolRounds: 0 }, executeTool,
      initialRequest: request(true), parallelToolCalls: false, tools: [tool] });
    expect(outcome).toMatchObject({ status: "failed", failure: TOOL_SYNTHESIS_FAILURE });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("preserves upstream truncation without publishing a split native marker", async () => {
    const { adapter } = fixture(safePrefix + nativeCall, [safePrefix, "<｜DS"], { terminal: false });
    const events: ModelRunSseEvent[] = [];
    await expect((async () => {
      for await (const event of adapter.stream(request(true))) events.push(event);
    })()).rejects.toThrow("deepseek_stream_truncated");
    expect(events.flatMap((event) => event.type === "token" ? [event.data.delta] : []).join("")).toBe(safePrefix);
  });
});
