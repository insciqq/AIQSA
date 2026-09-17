import { describe, expect, it, vi } from "vitest";
import { buildDeepSeekResponsesStructuredOutputRequest, createDeepSeekResponsesStructuredOutputAdapter } from "../../providers/structuredOutput";
import { MEMORY_CHAT_DIGEST_VERSIONS } from "../history/digest";
import { MEMORY_CONTEXTUAL_KEY_VERSIONS } from "../history/contextualKeys";
import { MEMORY_CONTEXTUAL_GROUNDING_VERSIONS } from "../history/contextualGrounding";
import { memoryHistoryOutputRequest, MEMORY_HISTORY_OUTPUT_PIPELINE_VERSION } from "./historyOutputBudget";
import type { MemorySecretFreeExecutionSnapshot } from "./snapshot";
import { applySystemModelReasoningEffort } from "../../providerRuntime/systemModelRole";

function snapshot(): MemorySecretFreeExecutionSnapshot {
  return {
    logicalRole: "MEMORY_HISTORY_CLASSIFY",
    compatibilityRequirement: { pipelineVersion: MEMORY_HISTORY_OUTPUT_PIPELINE_VERSION },
    providerExecutionSnapshot: {
      model: {
        adapterKind: "deepseek_responses_native", upstreamModelId: "fixture-model",
        modelClass: "answer", answerSelectable: true,
        capabilities: { reasoning: true, reasoningEfforts: ["none", "low", "high"], defaultReasoningEffort: "high",
          maxOutputTokens: 32_768, nativePdfInput: false, nativeSearch: false, pdf: false, vision: false },
        defaultParams: { maxOutputTokens: 8_192, reasoning: { effort: "high" } }
      }
    }
  } as unknown as MemorySecretFreeExecutionSnapshot;
}

function deepSeekModel(admitted: MemorySecretFreeExecutionSnapshot) {
  const model = admitted.providerExecutionSnapshot.model;
  if (model.adapterKind !== "deepseek_responses_native") throw new Error("unexpected_fixture_adapter");
  return model;
}

const request = {
  name: "history_result", maxOutputTokens: 448,
  schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
  systemPrompt: "Return the strict result.", userPrompt: "Synthetic history input."
};

describe("admitted history reasoning allowance", () => {
  it("uses the accepted output allowance for every history generation stage without changing settings or schema", () => {
    const admitted = snapshot();
    const original = JSON.stringify(admitted);
    for (const versions of [MEMORY_CONTEXTUAL_KEY_VERSIONS, MEMORY_CONTEXTUAL_GROUNDING_VERSIONS, MEMORY_CHAT_DIGEST_VERSIONS]) {
      const prepared = memoryHistoryOutputRequest({ ...admitted, compatibilityRequirement: {
        ...admitted.compatibilityRequirement, ...versions
      } }, request);
      expect(prepared).toEqual({ ...request, maxOutputTokens: 8_192, reasoningEffort: "high", reasoningBudgetIncluded: true });
      expect(buildDeepSeekResponsesStructuredOutputRequest(deepSeekModel(admitted), prepared))
        .toMatchObject({ max_output_tokens: 8_192, reasoning: { effort: "high" } });
    }
    expect(JSON.stringify(admitted)).toBe(original);
  });

  it("respects recorded model and structured-output ceilings rather than a mutable model-name table", () => {
    const admitted = snapshot();
    admitted.providerExecutionSnapshot.model.defaultParams.maxOutputTokens = 100_000;
    expect(memoryHistoryOutputRequest(admitted, request).maxOutputTokens).toBe(32_768);
    admitted.providerExecutionSnapshot.model.capabilities.maxOutputTokens = 100_000;
    expect(memoryHistoryOutputRequest(admitted, request).maxOutputTokens).toBe(65_536);
    delete admitted.providerExecutionSnapshot.model.defaultParams.maxOutputTokens;
    admitted.providerExecutionSnapshot.model.capabilities.defaultMaxOutputTokens = 4_096;
    expect(memoryHistoryOutputRequest(admitted, request).maxOutputTokens).toBe(4_096);
  });

  it("keeps small payload budgets for non-reasoning and explicit disable, including low model ceilings", () => {
    const admitted = snapshot();
    expect(memoryHistoryOutputRequest(admitted, { ...request, reasoningEffort: "none" }))
      .toMatchObject({ maxOutputTokens: 448, reasoningEffort: "none" });
    admitted.providerExecutionSnapshot.model.defaultParams.reasoning = { enabled: false, effort: "high" };
    expect(memoryHistoryOutputRequest(admitted, request)).toMatchObject({ maxOutputTokens: 448, reasoningEffort: "none" });
    expect(memoryHistoryOutputRequest({ ...admitted, providerExecutionSnapshot:
      applySystemModelReasoningEffort(admitted.providerExecutionSnapshot, "low") }, request))
      .toMatchObject({ maxOutputTokens: 8_192, reasoningEffort: "low" });
    admitted.providerExecutionSnapshot.model.capabilities.maxOutputTokens = 256;
    const prepared = memoryHistoryOutputRequest(admitted, request);
    expect(buildDeepSeekResponsesStructuredOutputRequest(deepSeekModel(admitted), prepared))
      .toMatchObject({ max_output_tokens: 256, reasoning: { effort: "none" } });
    Object.assign(admitted.providerExecutionSnapshot.model, {
      capabilities: { ...admitted.providerExecutionSnapshot.model.capabilities,
        reasoning: false, reasoningEfforts: undefined, defaultReasoningEffort: undefined }, defaultParams: {}
    });
    expect(memoryHistoryOutputRequest(admitted, request).maxOutputTokens).toBe(256);
  });

  it("leaves input and safety headroom in a small recorded context window", () => {
    const admitted = snapshot();
    admitted.providerExecutionSnapshot.model.capabilities.contextWindow = 2_048;
    const short = memoryHistoryOutputRequest(admitted, request);
    const longer = memoryHistoryOutputRequest(admitted, { ...request, userPrompt: "x".repeat(4_000) });
    expect(short.maxOutputTokens).toBeLessThan(1_844);
    expect(longer.maxOutputTokens).toBeLessThan(short.maxOutputTokens! - 900);
    expect(() => memoryHistoryOutputRequest(admitted, { ...request, userPrompt: "x".repeat(8_192) }))
      .toThrow("structured_output_request_invalid");
  });

  it("retains prior accepted semantics and leaves non-history utility roles alone", () => {
    const legacy = snapshot();
    const legacySnapshot = { ...legacy, compatibilityRequirement: { ...legacy.compatibilityRequirement,
      pipelineVersion: "memory-history-incremental-v9" } };
    expect(memoryHistoryOutputRequest(legacySnapshot, request)).toBe(request);
    expect(memoryHistoryOutputRequest({ ...legacy, logicalRole: "MEMORY_CONTROL" }, request)).toBe(request);
    expect(() => memoryHistoryOutputRequest(legacy, { ...request, reasoningEffort: "unsupported" }))
      .toThrow("structured_output_request_invalid");
  });

  it.each([448, 152, 1600])("can finish strict JSON after 3000 reasoning tokens for the former %s-token payload", async (maxOutputTokens) => {
    const admitted = snapshot();
    const create = vi.fn(async ({ max_output_tokens }: { max_output_tokens: number }) => max_output_tokens < 3_010
      ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [],
        usage: { input_tokens: 20, output_tokens: max_output_tokens, output_tokens_details: { reasoning_tokens: max_output_tokens }, total_tokens: max_output_tokens + 20 } }
      : { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"ok":true}' }] }],
        usage: { input_tokens: 20, output_tokens: 3_010, output_tokens_details: { reasoning_tokens: 3_000 }, total_tokens: 3_030 } });
    const adapter = createDeepSeekResponsesStructuredOutputAdapter({ model: deepSeekModel(admitted),
      client: { create } as never });
    await expect(adapter.execute({ ...request, maxOutputTokens, reasoningEffort: "high" }))
      .rejects.toMatchObject({ code: "structured_output_output_limit_exceeded" });
    const onUsage = vi.fn();
    await expect(adapter.execute(memoryHistoryOutputRequest(admitted, { ...request, maxOutputTokens }), { onUsage }))
      .resolves.toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ outputTokens: 3_010, reasoningTokens: 3_000 }));
  });
});
