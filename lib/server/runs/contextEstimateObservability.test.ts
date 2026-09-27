// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderRunRequest } from "../providers/types";
import { openAIResponsesToolBridge } from "../tools/bridges";
import type { ProviderToolBridge } from "../tools/types";
import { serializeEvent } from "../observability/runtime.cjs";
import { providerRequestTokenEstimate } from "./runContextBudget";

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../observability", () => ({ logEvent }));
const { observeContextEstimate } = await import("./contextEstimateObservability");

const PRIVATE = "PRIVATE_PROMPT_TEXT";

function request(provider: string, modelId = "model"): ProviderRunRequest {
  return {
    attachmentIds: [], attachments: [], chatId: "chat-1",
    content: { blocks: [{ text: `${PRIVATE} Сколько заказов было возвращено?`, type: "text" }] },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { contextWindow: 128_000, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
    modelId, params: {}, prompt: { developer: null, system: `${PRIVATE} system` }, provider,
    providerToolMessages: [{ call_id: "call-1", output: `{"records":[{"id":"${PRIVATE}"}]}`, type: "function_call_output" }],
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto"
  };
}

afterEach(() => logEvent.mockClear());

describe("context estimate observability", () => {
  it("records the reported-to-estimated input ratio per family, with numbers only", () => {
    const input = request("anthropic", "claude-sonnet-5");
    const estimated = providerRequestTokenEstimate(input, openAIResponsesToolBridge);
    observeContextEstimate(openAIResponsesToolBridge, input, { inputTokens: 1_234, outputTokens: 10 });
    expect(logEvent).toHaveBeenCalledOnce();
    const [event, fields] = logEvent.mock.calls[0]!;
    expect(event).toBe("context_estimate");
    expect(fields).toEqual({
      estimate_family: "anthropic",
      estimated_tokens: estimated,
      providerFamily: "anthropic",
      ratio_permille: Math.round((1_234 * 1_000) / estimated),
      reported_input_tokens: 1_234
    });
    expect(JSON.stringify(fields)).not.toContain(PRIVATE);
    // The runtime allowlist keeps exactly these numeric and enumerated fields.
    const record = JSON.parse(serializeEvent("context_estimate", { ...fields, prompt: PRIVATE } as never)!);
    expect(record).toMatchObject({ ...fields, event: "context_estimate", level: "info" });
    expect(JSON.stringify(record)).not.toContain(PRIVATE);
  });

  it("names the estimate family of an OpenAI-compatible route", () => {
    observeContextEstimate(openAIResponsesToolBridge, request("openai_compatible", "gpt-5.4"), { inputTokens: 500 });
    observeContextEstimate(openAIResponsesToolBridge, request("openai_compatible", "llama-3.3-70b"), { inputTokens: 500 });
    expect(logEvent.mock.calls.map(([, fields]) => [fields.providerFamily, fields.estimate_family])).toEqual([
      ["openai_compatible", "openai"], ["openai_compatible", "unknown"]
    ]);
  });

  it("stays silent without a profile or without a reported input count", () => {
    observeContextEstimate(openAIResponsesToolBridge, request("fake"), { inputTokens: 100 });
    observeContextEstimate(openAIResponsesToolBridge, request("openai"), {});
    observeContextEstimate(openAIResponsesToolBridge, request("openai"), { inputTokens: 0 });
    observeContextEstimate(openAIResponsesToolBridge, request("openai"), { inputTokens: null, completeness: "partial" });
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("never lets a measurement failure reach the round", () => {
    const broken: ProviderToolBridge = { ...openAIResponsesToolBridge, serializeTool: () => { throw new Error(PRIVATE); } };
    const input = { ...request("openai"), tools: [{ capability: "mcp" as const, description: "d", inputSchema: { type: "object" }, name: "mcp_tool" }] };
    expect(() => observeContextEstimate(broken, input, { inputTokens: 100 })).not.toThrow();
    expect(logEvent).not.toHaveBeenCalled();
  });
});
