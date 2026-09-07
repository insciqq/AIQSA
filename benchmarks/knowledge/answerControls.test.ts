import { describe, expect, it } from "vitest";
import { buildCompatibleResponsesRequest } from "../../lib/server/providers/compatibleResponses";
import type { ProviderExecutionSnapshot } from "../../lib/server/providers/runtimeFactory";
import type { ProviderRunRequest } from "../../lib/server/providers/types";
import { answerBenchmarkControlPlan, answerBenchmarkControlReceipt, answerBenchmarkMessageRequest, assertAnswerBenchmarkControls } from "./answerControls";

function snapshot(): ProviderExecutionSnapshot {
  return { providerFamily: "openai_compatible", model: {
    adapterKind: "openai_responses_compatible", upstreamModelId: "neutral-control-model",
    defaultParams: { maxOutputTokens: 8192, reasoning: { effort: "high", summary: "none" }, temperature: 0.7 },
    capabilities: { reasoning: true, reasoningEfforts: ["low", "medium", "high"], streaming: true },
    reasoningRequestMapping: { effortPath: ["reasoning", "effort"], effortValues: { low: "low", medium: "medium", high: "high" } }
  } } as unknown as ProviderExecutionSnapshot;
}

describe("benchmark accepted run controls", () => {
  it.each([{ maxOutputTokens: "2500", reasoningEffort: "medium" }, { maxOutputTokens: "1000", reasoningEffort: "low" }])(
    "sends $maxOutputTokens/$reasoningEffort as real provider params, overriding model defaults", drafts => {
      const plan = answerBenchmarkControlPlan(snapshot(), { ...drafts, temperature: "0" });
      const body = answerBenchmarkMessageRequest({ baseId: null, controlPlan: plan,
        model: { modelId: "catalog-model", provider: "catalog-connection" }, prompt: "A neutral request." });
      expect(body).not.toHaveProperty("controlDefaults");
      const wire = buildCompatibleResponsesRequest({ ...body, modelId: "neutral-control-model", provider: "openai_compatible",
        chatId: "neutral-chat", toolMode: "none", attachmentIds: [], attachments: [],
        prompt: { system: null, developer: null }, searchPlan: { mode: "all_selected", options: [] },
        forceNonStreaming: true, tools: [] } as unknown as ProviderRunRequest);
      expect(wire).toMatchObject({ max_output_tokens: Number(drafts.maxOutputTokens), temperature: 0,
        reasoning: { effort: drafts.reasoningEffort }, stream: false });
      expect(body.knowledgePlan).toMatchObject({ mode: "none", baseIds: [], sourceIds: [] });
      const receipt = answerBenchmarkControlReceipt({ params: plan.params, reasoningEffort: plan.reasoningEffort });
      expect(() => assertAnswerBenchmarkControls(receipt, plan)).not.toThrow();
    }
  );

  it("rejects blank, unknown, unsupported and out-of-range controls before dispatch", () => {
    for (const drafts of [{ maxOutputTokens: " " }, { maxOutputTokens: "1.5" }, { maxOutputTokens: "999999999" },
      { reasoningEffort: "invented" }, { temperature: "3" }, { seed: 7 }, { backgroundMode: true }]) {
      expect(() => answerBenchmarkControlPlan(snapshot(), drafts)).toThrow(/controls_(?:invalid|unsupported)/u);
    }
  });

  it("detects silently ignored controls and separate reasoning drift with content-free errors", () => {
    const plan = answerBenchmarkControlPlan(snapshot(), { maxOutputTokens: "1000", reasoningEffort: "low", temperature: "0" });
    for (const normalized of [null, { params: {}, reasoningEffort: "medium" }, { params: plan.params, reasoningEffort: "high" },
      { params: { ...plan.params, maxOutputTokens: 128000 }, reasoningEffort: "low" }]) {
      expect(() => assertAnswerBenchmarkControls(answerBenchmarkControlReceipt(normalized), plan))
        .toThrow("answer_benchmark_accepted_controls_mismatch");
    }
    expect(plan.paramsHash).not.toEqual(answerBenchmarkControlReceipt({ params: {}, reasoningEffort: "low" })?.paramsHash);
  });

  it("keeps explicit Knowledge scope separate from evaluator-only execution", () => {
    const plan = answerBenchmarkControlPlan(snapshot(), { maxOutputTokens: "2500", reasoningEffort: "medium" });
    const body = answerBenchmarkMessageRequest({ baseId: "neutral-base", controlPlan: plan,
      model: { modelId: "catalog-model", provider: "catalog-connection" }, prompt: "A neutral question." });
    expect(body.knowledgePlan).toEqual({ baseIds: ["neutral-base"], mode: "explicit", sourceIds: [], version: 1 });
    expect(body.params).toMatchObject({ maxOutputTokens: 2500, reasoning: { effort: "medium" } });
  });
});
