import { describe, expect, it, vi } from "vitest";
import { ProviderAdmissionError, type AdmissionPrisma, type ProviderAdmissionRole } from "../providerRuntime/admission";
import { listMemoryModelRecommendations, memoryRecommendationMatches } from "./modelRecommendations";

const model = { adapterKind: "openai_responses_compatible", upstreamModelId: "gpt-5.6-terra", modelClass: "answer", answerSelectable: true,
  capabilities: { contextWindow: 128000, maxOutputTokens: 8192, reasoning: true, defaultReasoningEffort: "low", reasoningEfforts: ["low", "medium", "high"],
    toolCalling: true, nativePdfInput: false, nativeSearch: false, pdf: false, vision: false },
  defaultParams: { maxOutputTokens: 8192 } };
function role() {
  return { snapshot: { model: structuredClone(model), providerFamily: "openai_compatible" },
    verifiedStructuredOutput: true, verifiedForcedToolCall: true } as unknown as ProviderAdmissionRole;
}
const row = { id: "installed-model", connectionId: "connection", displayName: "My utility model", activeConfig: model };

describe("qualified Memory recommendations", () => {
  it("requires the qualified effort, transport, identity, budget and both exact capability proofs", () => {
    const available = role();
    expect(memoryRecommendationMatches(available, "terra-low-memory-v1", "low")).toBe(true);
    expect(memoryRecommendationMatches(available, "terra-low-memory-v1", "high")).toBe(false);
    expect(memoryRecommendationMatches(available, "terra-low-memory-v1", null)).toBe(false);
    expect(memoryRecommendationMatches(available, "unknown", "low")).toBe(false);
    const variants: ProviderAdmissionRole[] = [
      { ...available, verifiedStructuredOutput: false }, { ...available, verifiedForcedToolCall: false },
      ...[
        { upstreamModelId: "gpt-5.6-sol" }, { adapterKind: "openrouter" },
        { defaultParams: { maxOutputTokens: 512 } },
        { defaultParams: {}, capabilities: { ...model.capabilities, defaultMaxOutputTokens: undefined } },
        { capabilities: { ...model.capabilities, contextWindow: 8192 } },
        { capabilities: { ...model.capabilities, reasoningEfforts: ["high"] } }
      ].map((change) => ({ ...available, snapshot: { ...available.snapshot,
        model: { ...available.snapshot.model, ...change } } } as ProviderAdmissionRole))
    ];
    for (const variant of variants) expect(memoryRecommendationMatches(variant, "terra-low-memory-v1", "low")).toBe(false);
  });

  it("keeps missing, stale-credential and constrained targets unavailable without paid checks", async () => {
    const db = {} as AdmissionPrisma;
    const load = vi.fn().mockResolvedValue(role());
    expect(await listMemoryModelRecommendations(db, [], load)).toMatchObject([{ providerModelId: null, unavailableReason: "not_installed" }]);
    expect(load).not.toHaveBeenCalled();
    expect(await listMemoryModelRecommendations(db, [row], load)).toMatchObject([{ providerModelId: row.id, unavailableReason: null }]);
    expect(load).toHaveBeenCalledWith(db, { providerModelId: row.id });
    load.mockRejectedValueOnce(new ProviderAdmissionError("model_not_available"));
    expect(await listMemoryModelRecommendations(db, [row], load)).toMatchObject([{ unavailableReason: "verification_required" }]);
    const constrained = role(); constrained.snapshot.model.defaultParams.maxOutputTokens = 512;
    load.mockResolvedValueOnce(constrained);
    expect(await listMemoryModelRecommendations(db, [row], load)).toMatchObject([{ unavailableReason: "budget_too_small" }]);
    load.mockRejectedValueOnce(new Error("database_unavailable"));
    await expect(listMemoryModelRecommendations(db, [row], load)).rejects.toThrow("database_unavailable");
  });
});
