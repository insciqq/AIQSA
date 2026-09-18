import { describe, expect, it, vi } from "vitest";
import { buildDeepSeekResponsesStructuredOutputRequest, createDeepSeekResponsesStructuredOutputAdapter } from "../../providers/structuredOutput";
import { MEMORY_CHAT_DIGEST_VERSIONS } from "../history/digest";
import { buildMemoryContextualKeyRequest, decodeMemoryContextualKeyOutputs, MEMORY_CONTEXTUAL_KEY_VERSIONS } from "../history/contextualKeys";
import { MEMORY_CONTEXTUAL_GROUNDING_VERSIONS } from "../history/contextualGrounding";
import { MEMORY_HISTORY_OUTPUT_PIPELINE_VERSION } from "./historyOutputBudget";
import { memoryStructuredOutputRequest } from "./outputBudget";
import type { MemorySecretFreeExecutionSnapshot } from "./snapshot";
import { applySystemModelReasoningEffort } from "../../providerRuntime/systemModelRole";
import { MEMORY_STRICT_OUTPUT_ROLES } from "./roles";

function snapshot(): MemorySecretFreeExecutionSnapshot {
  return {
    version: 3,
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
  it.each(["high", "none"])("uses the accepted output allowance for every history stage with %s reasoning", (effort) => {
    const admitted = snapshot();
    admitted.providerExecutionSnapshot.model.defaultParams.reasoning = { effort };
    const original = JSON.stringify(admitted);
    for (const versions of [MEMORY_CONTEXTUAL_KEY_VERSIONS, MEMORY_CONTEXTUAL_GROUNDING_VERSIONS, MEMORY_CHAT_DIGEST_VERSIONS]) {
      const prepared = memoryStructuredOutputRequest({ ...admitted, compatibilityRequirement: {
        ...admitted.compatibilityRequirement, ...versions
      } }, request);
      expect(prepared).toEqual({ ...request, maxOutputTokens: 8_192, reasoningEffort: effort, reasoningBudgetIncluded: true });
      expect(buildDeepSeekResponsesStructuredOutputRequest(deepSeekModel(admitted), prepared))
        .toMatchObject({ max_output_tokens: 8_192, reasoning: { effort } });
    }
    expect(JSON.stringify(admitted)).toBe(original);
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

  it("retains the output policy of earlier accepted history and other utility work", () => {
    const admitted = snapshot();
    const legacy = { ...admitted, version: 2 as const, compatibilityRequirement: { ...admitted.compatibilityRequirement,
      pipelineVersion: "memory-history-structured-budget-v1" } };
    expect(memoryStructuredOutputRequest(legacy, request))
      .toMatchObject({ maxOutputTokens: 8_192, reasoningEffort: "high" });
    expect(memoryStructuredOutputRequest(legacy, { ...request, reasoningEffort: "none" }))
      .toMatchObject({ maxOutputTokens: 448, reasoningEffort: "none" });
    const legacySnapshot = { ...legacy, compatibilityRequirement: { ...legacy.compatibilityRequirement,
      pipelineVersion: "memory-history-incremental-v9" } };
    expect(memoryStructuredOutputRequest(legacySnapshot, request)).toBe(request);
    expect(memoryStructuredOutputRequest({ ...legacy, logicalRole: "MEMORY_CONTROL" }, request)).toBe(request);
    expect(() => memoryStructuredOutputRequest(legacy, { ...request, reasoningEffort: "unsupported" }))
      .toThrow("structured_output_request_invalid");
  });

  it("finishes a grounded multi-statement history key exceeding the former 448-token budget without reasoning", async () => {
    const statements = [
      "The release needs an updated test plan covering search, document uploads, and saved preferences before it can be approved.",
      "The migration must retain existing settings and user data, and the rollback must be checked against a separate test installation.",
      "The owner will compare the candidate release with the previous version and confirm the fixes against the reported issues.",
      "The team will check desktop and phone layouts and review whether error messages describe a useful recovery action.",
      "The final review includes provider configuration, history retrieval, background jobs, and the ability to resume interrupted work."
    ];
    const current = { id: "round", rawSafeText: statements.join(" ") };
    const batch = [{ roundId: current.id, input: { current, prior: [] } }];
    const built = buildMemoryContextualKeyRequest(batch);
    const output = { rounds: [{ handle: "r0", language_code: "en",
      statements: statements.map(text => ({ source_refs: ["r0c"], text })) }] };
    const text = JSON.stringify(output);
    const outputTokens = 620;
    expect(outputTokens).toBeGreaterThan(built.request.maxOutputTokens!);
    const admitted = snapshot();
    admitted.providerExecutionSnapshot.model.defaultParams.reasoning = { enabled: false };
    const create = vi.fn(async ({ max_output_tokens }: { max_output_tokens: number }) => ({
      status: max_output_tokens < outputTokens ? "incomplete" : "completed",
      ...(max_output_tokens < outputTokens ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      output: [{ type: "message", content: [{ type: "output_text",
        text: max_output_tokens < outputTokens ? text.slice(0, 200) : text }] }],
      usage: { input_tokens: 1200, output_tokens: Math.min(outputTokens, max_output_tokens),
        output_tokens_details: { reasoning_tokens: 0 } }
    }));
    const adapter = createDeepSeekResponsesStructuredOutputAdapter({ model: deepSeekModel(admitted),
      client: { create } as never });
    await expect(adapter.execute({ ...built.request, reasoningEffort: "none" }))
      .rejects.toMatchObject({ code: "structured_output_output_limit_exceeded" });
    const onUsage = vi.fn();
    const prepared = memoryStructuredOutputRequest(admitted, built.request);
    const result = await adapter.execute(prepared, { onUsage });
    const decoded = decodeMemoryContextualKeyOutputs(result, batch, built.handles);
    expect(decoded[0]?.statements.map(statement => statement.text)).toEqual(statements);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ outputTokens, reasoningTokens: 0 }));
    expect(buildDeepSeekResponsesStructuredOutputRequest(deepSeekModel(admitted), prepared))
      .toMatchObject({ max_output_tokens: 8_192, reasoning: { effort: "none" } });
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
