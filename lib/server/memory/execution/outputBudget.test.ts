import { describe, expect, it, vi } from "vitest";
import { buildDeepSeekResponsesStructuredOutputRequest, createDeepSeekResponsesStructuredOutputAdapter } from "../../providers/structuredOutput";
import { memoryStructuredOutputRequest } from "./outputBudget";
import type { MemorySecretFreeExecutionSnapshot } from "./snapshot";
import { applySystemModelReasoningEffort } from "../../providerRuntime/systemModelRole";
import { MEMORY_STRICT_OUTPUT_ROLES } from "./roles";

function snapshot(): MemorySecretFreeExecutionSnapshot {
  return {
    version: 3,
    logicalRole: "MEMORY_FACT_EXTRACT",
    compatibilityRequirement: { pipelineVersion: "memory-fixture-pipeline-v1" },
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
  name: "memory_result", maxOutputTokens: 448,
  schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
  systemPrompt: "Return the strict result.", userPrompt: "Synthetic Memory input."
};

describe("admitted Memory output allowance", () => {
  it("uses the frozen common policy for new v4 work while retaining the v3 ceiling", () => {
    const old = snapshot();
    old.providerExecutionSnapshot.model.defaultParams.maxOutputTokens = 131_072;
    old.providerExecutionSnapshot.model.capabilities.maxOutputTokens = 131_072;
    const admitted = { ...old, version: 4 as const, generationBudget: {
      version: 1 as const, maxOutputTokens: 131_072, contextWindow: 1_000_000, timeoutMs: 300_000 } };
    expect(memoryStructuredOutputRequest(old, request).maxOutputTokens).toBe(65_536);
    const prepared = memoryStructuredOutputRequest(admitted, request);
    expect(prepared.maxOutputTokens).toBe(131_072);
    expect(buildDeepSeekResponsesStructuredOutputRequest(deepSeekModel(admitted), prepared))
      .toMatchObject({ max_output_tokens: 131_072, reasoning: { effort: "high" } });
    expect(memoryStructuredOutputRequest({ ...admitted, generationBudget: { ...admitted.generationBudget, contextWindow: 2048 } }, request).maxOutputTokens)
      .toBeLessThan(1844);
  });
  it.each(MEMORY_STRICT_OUTPUT_ROLES)("does not impose a hidden payload cap on new %s work", (logicalRole) => {
    const admitted = { ...snapshot(), logicalRole };
    for (const maxOutputTokens of [128, 256, 448, 1024, 1600, 2400]) {
      expect(memoryStructuredOutputRequest(admitted, { ...request, maxOutputTokens, reasoningEffort: "none" }))
        .toMatchObject({ maxOutputTokens: 8_192, reasoningEffort: "none", reasoningBudgetIncluded: true });
    }
  });
  it("respects recorded model and structured-output ceilings rather than a mutable model-name table", () => {
    const admitted = snapshot();
    admitted.providerExecutionSnapshot.model.defaultParams.maxOutputTokens = 100_000;
    expect(memoryStructuredOutputRequest(admitted, request).maxOutputTokens).toBe(32_768);
    admitted.providerExecutionSnapshot.model.capabilities.maxOutputTokens = 100_000;
    expect(memoryStructuredOutputRequest(admitted, request).maxOutputTokens).toBe(65_536);
    delete admitted.providerExecutionSnapshot.model.defaultParams.maxOutputTokens;
    admitted.providerExecutionSnapshot.model.capabilities.defaultMaxOutputTokens = 4_096;
    expect(memoryStructuredOutputRequest(admitted, request).maxOutputTokens).toBe(4_096);
  });

  it("uses the admitted allowance without reasoning and preserves low model ceilings", () => {
    const admitted = snapshot();
    expect(memoryStructuredOutputRequest(admitted, { ...request, reasoningEffort: "none" }))
      .toMatchObject({ maxOutputTokens: 8_192, reasoningEffort: "none" });
    admitted.providerExecutionSnapshot.model.defaultParams.reasoning = { enabled: false, effort: "high" };
    expect(memoryStructuredOutputRequest(admitted, request)).toMatchObject({ maxOutputTokens: 8_192, reasoningEffort: "none" });
    expect(memoryStructuredOutputRequest({ ...admitted, providerExecutionSnapshot:
      applySystemModelReasoningEffort(admitted.providerExecutionSnapshot, "low") }, request))
      .toMatchObject({ maxOutputTokens: 8_192, reasoningEffort: "low" });
    admitted.providerExecutionSnapshot.model.capabilities.maxOutputTokens = 256;
    const prepared = memoryStructuredOutputRequest(admitted, request);
    expect(buildDeepSeekResponsesStructuredOutputRequest(deepSeekModel(admitted), prepared))
      .toMatchObject({ max_output_tokens: 256, reasoning: { effort: "none" } });
    Object.assign(admitted.providerExecutionSnapshot.model, {
      capabilities: { ...admitted.providerExecutionSnapshot.model.capabilities,
        reasoning: false, reasoningEfforts: undefined, defaultReasoningEffort: undefined }, defaultParams: {}
    });
    expect(memoryStructuredOutputRequest(admitted, request).maxOutputTokens).toBe(256);
    delete admitted.providerExecutionSnapshot.model.capabilities.maxOutputTokens;
    expect(memoryStructuredOutputRequest(admitted, request).maxOutputTokens).toBe(65_536);
  });

  it.each(["high", "none"])("leaves input and safety headroom in a small context window with %s reasoning", (effort) => {
    const admitted = snapshot();
    admitted.providerExecutionSnapshot.model.defaultParams.reasoning = { effort };
    admitted.providerExecutionSnapshot.model.capabilities.contextWindow = 2_048;
    const short = memoryStructuredOutputRequest(admitted, request);
    const longer = memoryStructuredOutputRequest(admitted, { ...request, userPrompt: "x".repeat(4_000) });
    expect(short.maxOutputTokens).toBeLessThan(1_844);
    expect(longer.maxOutputTokens).toBeLessThan(short.maxOutputTokens! - 900);
    expect(() => memoryStructuredOutputRequest(admitted, { ...request, userPrompt: "x".repeat(8_192) }))
      .toThrow("structured_output_request_invalid");
  });

  it("sends the unchanged request of earlier accepted version 2 work", () => {
    const legacy = { ...snapshot(), version: 2 as const };
    expect(memoryStructuredOutputRequest(legacy, request)).toBe(request);
    expect(memoryStructuredOutputRequest({ ...legacy, logicalRole: "MEMORY_CONTROL" }, request)).toBe(request);
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
    await expect(adapter.execute(memoryStructuredOutputRequest(admitted, { ...request, maxOutputTokens }), { onUsage }))
      .resolves.toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ outputTokens: 3_010, reasoningTokens: 3_000 }));
  });
});
