import { describe, expect, it } from "vitest";
import { fixtureConnection, fixtureModel } from "@/components/admin/providers/providerFixtures";
import {
  applyCatalogHint,
  applyCompatibleModel,
  applyOpenRouterModel,
  blankModelForm,
  catalogHintsFor,
  describeOpenRouterModel,
  endpointDetail,
  endpointLabel,
  modelFormBody,
  modelFormFrom,
  modelNameOnlyChanged,
  moveProviderTag,
  withDataCollection
} from "./modelSheetView";

const openRouter = fixtureConnection({ displayName: "OpenRouter", family: "openrouter", id: "conn-or" });

describe("model sheet form", () => {
  it("recognizes only a display-name edit against the frozen form", () => {
    const baseline = blankModelForm(openRouter);
    const renamed = { ...baseline, displayName: "New label" };
    expect(modelNameOnlyChanged(baseline, baseline)).toBe(false);
    expect(modelNameOnlyChanged(renamed, baseline)).toBe(true);
    for (const patch of [
      { defaultParamsText: "{ \"temperature\": 1 }" }, { defaultParamsText: "{invalid" },
      { adapterKind: "openai_responses_compatible" as const }, { answerSelectable: false },
      { capabilities: { ...baseline.capabilities, vision: true } }, { dataCollectionAllowed: true },
      { openRouterRoutingMode: "only_selected" as const }, { providerTags: ["vendor"] },
      { reasoningEffortPath: "effort" }, { reasoningModePath: "mode" },
      { responseTimeoutSeconds: "120" }, { upstreamModelId: "different-model" },
      { modelClass: "image" as const }, { image: { profile: "openai" as const } }
    ]) expect(modelNameOnlyChanged({ ...renamed, ...patch }, baseline)).toBe(false);
  });

  it("starts from family defaults and turns into a Test & Save body with routing and data collection", () => {
    const form = blankModelForm(openRouter);
    expect(form.adapterKind).toBe("openrouter_chat_completions");
    expect(modelFormBody(form, openRouter, null)).toMatchObject({ field: "upstreamModelId", ok: false });

    const filled = {
      ...form,
      dataCollectionAllowed: true,
      displayName: "Claude Sonnet 5",
      openRouterRoutingMode: "only_selected" as const,
      providerTags: ["anthropic", "amazon-bedrock"],
      responseTimeoutSeconds: "120",
      upstreamModelId: "anthropic/claude-sonnet-5"
    };
    const result = modelFormBody(filled, openRouter, null);
    expect(result).toEqual({
      body: {
        configuration: {
          adapterKind: "openrouter_chat_completions",
          answerSelectable: true,
          capabilities: form.capabilities,
          defaultParams: { provider: { dataCollection: "allow" } },
          modelClass: "answer",
          openRouterRouting: { mode: "only_selected", providers: ["anthropic", "amazon-bedrock"] },
          responseTimeoutSeconds: 120,
          upstreamModelId: "anthropic/claude-sonnet-5"
        },
        displayName: "Claude Sonnet 5"
      },
      ok: true
    });
    expect(modelFormBody({ ...filled, providerTags: [] }, openRouter, null)).toMatchObject({ field: "routing", ok: false });
    expect(modelFormBody({ ...filled, defaultParamsText: "[]" }, openRouter, null)).toMatchObject({ field: "defaultParams", ok: false });
    expect(modelFormBody({ ...filled, responseTimeoutSeconds: "2" }, openRouter, null)).toMatchObject({ field: "timeout", ok: false });
  });

  it("round-trips a saved model, keeps its class and version, and writes the reasoning mapping only for compatible answer models", () => {
    const custom = fixtureConnection({ displayName: "codex-lb", family: "openai_compatible", id: "conn-custom" });
    const model = fixtureModel({ connectionId: "conn-custom", displayName: "GPT-5.6 Luna", id: "m" });
    model.draftConfig = {
      ...model.draftConfig,
      adapterKind: "openai_responses_compatible",
      capabilities: { ...model.draftConfig.capabilities, reasoning: true, reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" },
      defaultParams: { temperature: 0.2 },
      reasoningRequestMapping: { effortPath: "reasoning.effort", modePath: "reasoning.mode" },
      responseTimeoutSeconds: 90
    };
    model.draftVersion = 4;
    const form = modelFormFrom(model);
    expect(form).toMatchObject({
      defaultParamsText: JSON.stringify({ temperature: 0.2 }, null, 2),
      displayName: "GPT-5.6 Luna",
      reasoningEffortPath: "reasoning.effort",
      reasoningModePath: "reasoning.mode",
      responseTimeoutSeconds: "90"
    });
    const result = modelFormBody(form, custom, model);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.expectedDraftVersion).toBe(4);
    expect(result.body.configuration).toMatchObject({
      defaultParams: { temperature: 0.2 },
      reasoningRequestMapping: { effortPath: "reasoning.effort", modePath: "reasoning.mode" },
      responseTimeoutSeconds: 90
    });
    expect(result.body.configuration.openRouterRouting).toBeUndefined();

    const embedding = fixtureModel({ connectionId: "conn-or", displayName: "Qwen3 Embedding 8B", id: "e", modelClass: "embedding" });
    embedding.draftConfig = {
      ...embedding.draftConfig,
      adapterKind: "openai_embeddings_compatible",
      answerSelectable: false,
      embedding: { nativeDimension: 4_096, providerFamily: "openrouter", queryInstructionTemplate: null, supportsMrl: true, targetDimension: 1_536 },
      modelClass: "embedding",
      openRouterRouting: { mode: "only_selected", providers: ["nebius"] }
    };
    const embeddingBody = modelFormBody(modelFormFrom(embedding), openRouter, embedding);
    expect(embeddingBody.ok).toBe(true);
    if (!embeddingBody.ok) return;
    expect(embeddingBody.body.configuration).toMatchObject({
      answerSelectable: false,
      embedding: { targetDimension: 1_536 },
      modelClass: "embedding",
      openRouterRouting: { mode: "only_selected", providers: ["nebius"] }
    });
  });

  it("fills the form from the OpenRouter catalog or a built-in hint and orders providers", () => {
    const discovered = {
      contextLength: 1_000_000,
      id: "anthropic/claude-sonnet-5",
      inputModalities: ["text", "image"],
      name: "Anthropic: Claude Sonnet 5",
      outputModalities: ["text"],
      pricing: {},
      supportedParameters: ["tools", "reasoning"]
    };
    const applied = applyOpenRouterModel(blankModelForm(openRouter), discovered);
    expect(applied).toMatchObject({
      capabilities: expect.objectContaining({ contextWindow: 1_000_000, reasoning: true, toolCalling: true, vision: true }),
      displayName: "Anthropic: Claude Sonnet 5",
      upstreamModelId: "anthropic/claude-sonnet-5"
    });
    expect(describeOpenRouterModel(discovered)).toBe("1M context · tools, reasoning, image input");

    const hints = catalogHintsFor("openai");
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.every((hint) => hint.providerFamily === "openai")).toBe(true);
    expect(catalogHintsFor("openai_compatible")).toEqual([]);
    const hinted = applyCatalogHint(blankModelForm({ family: "openai" }), hints[0]!);
    expect(hinted.upstreamModelId).toBe(hints[0]!.upstreamModelId);
    expect(hinted.displayName).toBe(hints[0]!.displayName);

    expect(moveProviderTag(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveProviderTag(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    const endpoint = { name: "Anthropic | claude-sonnet-5", providerName: "Anthropic", quantization: "fp8", supportedParameters: [], tag: "anthropic" };
    expect(endpointLabel(endpoint)).toBe("Anthropic");
    expect(endpointDetail(endpoint)).toBe("anthropic");
    expect(withDataCollection({ provider: { dataCollection: "allow", order: ["x"] }, temperature: 1 }, false))
      .toEqual({ provider: { order: ["x"] }, temperature: 1 });
    expect(withDataCollection({ provider: { data_collection: "allow" } }, false)).toEqual({});
  });

  it("imports bounded compatible hints for a new model without resetting an existing override", () => {
    const blank = blankModelForm({ family: "openai_compatible" });
    const model = { id: "first", capabilities: { contextWindow: 272_000, maxOutputTokens: 65_536, defaultMaxOutputTokens: 2_048, toolCalling: true, vision: true, parallelToolCalls: true } };
    const imported = applyCompatibleModel(blank, model, model.id);
    expect(imported.capabilities).toMatchObject(model.capabilities);
    const reviewed = { ...imported, capabilities: { ...imported.capabilities, vision: false, nativePdfInput: false } };
    expect(applyCompatibleModel(reviewed, model, model.id)).toEqual(reviewed);
    const different = applyCompatibleModel(imported, { id: "unknown", capabilities: {} }, "unknown");
    expect(different.capabilities).not.toHaveProperty("maxOutputTokens");
    expect(different.capabilities.reasoning).toBe(false);
  });
});
