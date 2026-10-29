import { describe, expect, it } from "vitest";
import type { CatalogWireModel } from "../../../contracts/catalog";
import { SUBAGENT_ERROR_CODES } from "../../../contracts/subagents";
import {
  SUBAGENT_MODEL_CATALOG_LIMIT,
  chooseSubagentModel,
  decodeSubagentModels,
  freezeSubagentModels,
  type SubagentParentModel
} from "./modelCatalog";

function model(id: string, extra: Partial<CatalogWireModel> = {}, efforts: string[] = ["low", "medium", "high"]): CatalogWireModel {
  return {
    capabilities: { background: false, documentInputMode: "none", imageInput: true, nativeWebSearch: false,
      openRouterPerplexitySearch: false, reasoning: true, streaming: true, text: true, toolCalling: true },
    contextWindow: 200_000, defaultParams: {}, displayName: `Model ${id}`, modelId: `pm-${id}`,
    parameterControls: {
      background: { defaultValue: false, supported: false }, maxOutputTokens: { defaultValue: 4_096 },
      reasoningEffort: { defaultValue: "medium", options: efforts, supported: efforts.length > 0 },
      stream: { defaultValue: true, supported: true }, temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: false }
    } as unknown as CatalogWireModel["parameterControls"],
    provider: "connection-1", providerFamily: "openai", searchStrategyIds: [], upstreamModelId: id, ...extra
  };
}

const parent: SubagentParentModel = { connectionId: "connection-1", effort: "high", efforts: ["low", "medium", "high"],
  providerModelId: "pm-gpt-6-sol", upstreamModelId: "gpt-6-sol" };
const catalog = freezeSubagentModels([model("gpt-6-sol"), model("gpt-6-luna", {}, ["low", "medium"]),
  model("no-tools", { capabilities: { ...model("x").capabilities, toolCalling: false } })]);

describe("sub-agent model catalog", () => {
  it("freezes only tool-calling chat models, bounded, and decodes what it froze", () => {
    expect(catalog.models.map((entry) => entry.upstreamModelId)).toEqual(["gpt-6-sol", "gpt-6-luna"]);
    expect(catalog.models[1]).toEqual({ connectionId: "connection-1", contextWindow: 200_000, defaultEffort: "medium",
      displayName: "Model gpt-6-luna", imageInput: true, providerFamily: "openai", providerModelId: "pm-gpt-6-luna",
      reasoningEfforts: ["low", "medium"], upstreamModelId: "gpt-6-luna" });
    const many = freezeSubagentModels(Array.from({ length: SUBAGENT_MODEL_CATALOG_LIMIT + 5 }, (_, index) => model(`m${index}`)));
    expect(many.models).toHaveLength(SUBAGENT_MODEL_CATALOG_LIMIT);
    expect(decodeSubagentModels(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog);
    expect(decodeSubagentModels({ models: [{ ...catalog.models[0], defaultEffort: "max" }], version: 1 })).toBeNull();
    expect(decodeSubagentModels(undefined)).toBeNull();
  });

  it("inherits the parent's exact model and effort by default", () => {
    expect(chooseSubagentModel({ call: {}, catalog, parent })).toEqual({ ok: true,
      choice: { effort: "high", effortSource: "parent", entry: null, modelSource: "parent" } });
    // Naming the parent's own model keeps its route; only the effort changes.
    expect(chooseSubagentModel({ call: { effort: "low", model: "gpt-6-sol" }, catalog, parent })).toEqual({ ok: true,
      choice: { effort: "low", effortSource: "call", entry: null, modelSource: "call" } });
  });

  it("never checks the parent's own admitted effort again, whatever options its capabilities list", () => {
    // An Assistant chat, a failed catalog read or an older run: no frozen list and no declared efforts.
    const bare = { ...parent, efforts: [] };
    expect(chooseSubagentModel({ call: {}, catalog: null, parent: bare })).toEqual({ ok: true,
      choice: { effort: "high", effortSource: "parent", entry: null, modelSource: "parent" } });
    // Another effort on that model is still checked.
    expect(chooseSubagentModel({ call: { effort: "low" }, catalog: null, parent: bare }))
      .toMatchObject({ code: SUBAGENT_ERROR_CODES.effortUnsupported, ok: false });
  });

  it("takes another frozen model the call names, with its own default effort", () => {
    const chosen = chooseSubagentModel({ call: { model: "GPT-6-LUNA" }, catalog, parent });
    expect(chosen).toMatchObject({ ok: true, choice: { effort: "medium", effortSource: "parent", modelSource: "call",
      entry: { providerModelId: "pm-gpt-6-luna" } } });
  });

  it("refuses a model outside the frozen list and an effort the model lacks, never substituting", () => {
    expect(chooseSubagentModel({ call: { model: "no-tools" }, catalog, parent }))
      .toMatchObject({ code: SUBAGENT_ERROR_CODES.modelUnavailable, ok: false });
    expect(chooseSubagentModel({ call: { model: "gpt-6-luna" }, catalog: null, parent }))
      .toMatchObject({ code: SUBAGENT_ERROR_CODES.modelUnavailable, ok: false });
    expect(chooseSubagentModel({ call: { effort: "high", model: "gpt-6-luna" }, catalog, parent }))
      .toMatchObject({ code: SUBAGENT_ERROR_CODES.effortUnsupported, ok: false });
    expect(chooseSubagentModel({ call: { effort: "max" }, catalog, parent }))
      .toMatchObject({ code: SUBAGENT_ERROR_CODES.effortUnsupported, ok: false });
  });

  it("puts the call over the type, and the type over the parent", () => {
    const type = { providerModelId: "pm-gpt-6-luna", reasoningEffort: "low" };
    expect(chooseSubagentModel({ call: {}, catalog, parent, type })).toMatchObject({ ok: true,
      choice: { effort: "low", effortSource: "type", entry: { upstreamModelId: "gpt-6-luna" }, modelSource: "type" } });
    expect(chooseSubagentModel({ call: { model: "gpt-6-sol" }, catalog, parent, type })).toMatchObject({ ok: true,
      choice: { effort: "low", effortSource: "type", entry: null, modelSource: "call" } });
  });

  it("keeps a continued thread's chosen model and effort, and follows the parent otherwise", () => {
    const chose = { connectionId: "connection-1", effort: "low", effortSource: "call" as const, modelSource: "call" as const,
      providerModelId: "pm-gpt-6-luna" };
    expect(chooseSubagentModel({ call: {}, catalog, parent, previous: chose })).toMatchObject({ ok: true,
      choice: { effort: "low", effortSource: "call", entry: { upstreamModelId: "gpt-6-luna" }, modelSource: "call" } });
    // A thread that ran on the parent's model follows the parent's current binding (the user switched the chat's model).
    const followed = { connectionId: "connection-1", effort: "medium", effortSource: "parent" as const, modelSource: "parent" as const,
      providerModelId: "pm-old" };
    expect(chooseSubagentModel({ call: {}, catalog, parent, previous: followed })).toEqual({ ok: true,
      choice: { effort: "high", effortSource: "parent", entry: null, modelSource: "parent" } });
    // A chosen model that left the list refuses the continuation instead of running on another.
    expect(chooseSubagentModel({ call: {}, catalog, parent, previous: { ...chose, providerModelId: "pm-gone" } }))
      .toMatchObject({ code: SUBAGENT_ERROR_CODES.modelUnavailable, ok: false });
  });
});
