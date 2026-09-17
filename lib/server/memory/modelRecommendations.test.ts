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
function geminiRole(native: boolean): ProviderAdmissionRole {
  const available = role();
  return { ...available, snapshot: { ...available.snapshot,
    providerFamily: native ? "gemini" : "openrouter",
    model: { ...available.snapshot.model,
      adapterKind: native ? "gemini_interactions_native" : "openrouter_chat_completions",
      upstreamModelId: native ? "gemini-3.8-flash" : "google/gemini-3.8-flash",
      modelClass: "answer", answerSelectable: true,
      ...(native ? {} : { openRouterRouting: { mode: "only_selected", providers: ["google-ai-studio"] } })
    }
  } };
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
      // Deliberately malformed authority must never establish a recommendation.
      { ...available, verifiedStructuredOutput: false } as unknown as ProviderAdmissionRole,
      { ...available, verifiedForcedToolCall: false } as unknown as ProviderAdmissionRole,
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
    const listTerra = async (rows: typeof row[]) => (await listMemoryModelRecommendations(db, rows, load))
      .find((entry) => entry.id === "terra-low-memory-v1");
    expect(await listTerra([])).toMatchObject({ providerModelId: null, unavailableReason: "not_installed" });
    expect(load).not.toHaveBeenCalled();
    expect(await listTerra([row])).toMatchObject({ providerModelId: row.id, unavailableReason: null });
    expect(load).toHaveBeenCalledWith(db, { providerModelId: row.id });
    load.mockRejectedValueOnce(new ProviderAdmissionError("model_not_available"));
    expect(await listTerra([row])).toMatchObject({ unavailableReason: "verification_required" });
    const constrained = role(); constrained.snapshot.model.defaultParams.maxOutputTokens = 512;
    load.mockResolvedValueOnce(constrained);
    expect(await listTerra([row])).toMatchObject({ unavailableReason: "budget_too_small" });
    load.mockRejectedValueOnce(new Error("database_unavailable"));
    await expect(listMemoryModelRecommendations(db, [row], load)).rejects.toThrow("database_unavailable");
  });

  it("offers native Flash alongside Terra, preserving its failed attempt and exact none setting", async () => {
    const available = role();
    const flash: ProviderAdmissionRole = { ...available, snapshot: { ...available.snapshot, providerFamily: "deepseek",
      model: { ...available.snapshot.model, adapterKind: "deepseek_responses_native", upstreamModelId: "deepseek-flash",
        answerSelectable: true, modelClass: "answer",
        capabilities: { ...available.snapshot.model.capabilities, reasoningEfforts: ["none", "low", "high"] } } } };
    const id = "deepseek-flash-none-memory-v1";
    expect(memoryRecommendationMatches(flash, id, "none")).toBe(true);
    for (const effort of ["low", "medium", "high", null]) expect(memoryRecommendationMatches(flash, id, effort)).toBe(false);
    for (const upstreamModelId of ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek/deepseek-v4.1-flash"]) {
      const other = { ...flash, snapshot: { ...flash.snapshot, model: { ...flash.snapshot.model, upstreamModelId } } };
      expect(memoryRecommendationMatches(other, id, "none")).toBe(false);
    }
    expect(memoryRecommendationMatches({ ...flash, verifiedForcedToolCall: undefined }, id, "none")).toBe(false);
    expect(memoryRecommendationMatches({ ...flash, verifiedStructuredOutput: undefined }, id, "none")).toBe(false);
    const flashRow = { ...row, id: "flash", activeConfig: flash.snapshot.model };
    const load = vi.fn().mockImplementation(async (_db, input) => input.providerModelId === "flash" ? flash : role());
    const recommendations = await listMemoryModelRecommendations({} as AdmissionPrisma, [flashRow, row], load);
    expect(recommendations[0]).toMatchObject({ id, unavailableReason: null });
    expect(recommendations.find((entry) => entry.id === "terra-low-memory-v1")).toMatchObject({ unavailableReason: null });
    expect(recommendations.find((entry) => entry.id === id)).toMatchObject({ providerModelId: "flash", reasoningEffort: "none",
      unavailableReason: null, evidence: { passedCases: 22, totalCases: 23 } });
  });

  it.each([true, false])("qualifies Gemini only at the tested identity and low effort (native=%s)", async (native) => {
    const available = geminiRole(native);
    const id = native ? "gemini-flash-native-low-memory-v2" : "gemini-flash-openrouter-low-memory-v2";
    expect(memoryRecommendationMatches(available, id, "low")).toBe(true);
    for (const effort of ["none", "minimal", "medium", "high", null]) {
      expect(memoryRecommendationMatches(available, id, effort)).toBe(false);
    }
    const older = { ...available, snapshot: { ...available.snapshot,
      model: { ...available.snapshot.model, upstreamModelId: native ? "gemini-3.5-flash" : "google/gemini-3.5-flash" }
    } };
    expect(memoryRecommendationMatches(older, id, "low")).toBe(false);
    expect(memoryRecommendationMatches(geminiRole(!native), id, "low")).toBe(false);
    expect(memoryRecommendationMatches({ ...available, verifiedForcedToolCall: undefined }, id, "low")).toBe(false);
    expect(memoryRecommendationMatches({ ...available, verifiedStructuredOutput: undefined }, id, "low")).toBe(false);

    const load = vi.fn().mockResolvedValue(available);
    const recommendations = await listMemoryModelRecommendations({} as AdmissionPrisma,
      [{ ...row, activeConfig: available.snapshot.model }], load);
    expect(recommendations.find((entry) => entry.id === id)).toMatchObject({
      providerModelId: row.id, reasoningEffort: "low", unavailableReason: null,
      evidence: { passedCases: 18, totalCases: 18 }
    });
  });

  it("withholds the OpenRouter recommendation for automatic, mixed and untested Google routes", async () => {
    const available = geminiRole(false);
    const configuredModel = available.snapshot.model;
    if (configuredModel.adapterKind === "fake") throw new Error("invalid_fixture");
    const id = "gemini-flash-openrouter-low-memory-v2";
    const variants = [
      undefined,
      { mode: "automatic", providers: [] },
      { mode: "only_selected", providers: ["google-vertex"] },
      { mode: "only_selected", providers: ["google-ai-studio", "google-vertex"] },
      { mode: "only_selected", providers: ["google-ai-studio/flex"] },
      { mode: "only_selected", providers: ["google-ai-studio/priority"] }
    ] as const;
    for (const routing of variants) {
      const other: ProviderAdmissionRole = { ...available, snapshot: { ...available.snapshot,
        model: { ...configuredModel, openRouterRouting: routing?.mode === "automatic"
          ? { mode: "automatic", providers: [] }
          : routing ? { mode: "only_selected", providers: [...routing.providers] } : undefined }
      } };
      expect(memoryRecommendationMatches(other, id, "low")).toBe(false);
    }
    const automatic = { ...available, snapshot: { ...available.snapshot,
      model: { ...configuredModel, openRouterRouting: { mode: "automatic" as const, providers: [] as [] } }
    } };
    const list = await listMemoryModelRecommendations({} as AdmissionPrisma,
      [{ ...row, activeConfig: automatic.snapshot.model }], vi.fn().mockResolvedValue(automatic));
    expect(list.find((entry) => entry.id === id)).toMatchObject({ unavailableReason: "verification_required" });
  });
});
